import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentRegistrationMismatchError } from "../src/agent/context.js";
import { bootstrapAgent } from "../src/agent/runtime.js";
import type { AppConfig } from "../src/config.js";
import { FakeJiraGateway } from "../src/jira/fake.js";
import { runJobForIssue } from "../src/job/runner.js";
import { JobStore } from "../src/job/store.js";
import { PLAN_PROPERTY_KEY, PLAN_TASK_PROPERTY_KEY } from "../src/pm/metadata.js";
import { claimAgentProfile, createAgentProfile } from "../src/profile/profile.js";
import { buildImplementSystemPrompt } from "../src/worker/prompt.js";
import type {
  WorkerProvider,
  WorkerRequest,
  WorkerResult,
  WorkerRunHooks,
} from "../src/worker/provider.js";
import {
  buildProfileModeConfig,
  buildTestConfig,
  buildTestIssue,
  buildV4Config,
} from "./helpers/fixtures.js";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function initTargetRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "GGJIRA Test"]);
  writeFileSync(path.join(dir, "README.md"), "initial\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "initial commit"]);
}

class StaticProvider implements WorkerProvider {
  constructor(private readonly result: WorkerResult) {}
  async run(_request: WorkerRequest, _hooks?: WorkerRunHooks): Promise<WorkerResult> {
    return this.result;
  }
}

class RecordingProvider implements WorkerProvider {
  readonly requests: WorkerRequest[] = [];
  constructor(private readonly result: WorkerResult) {}
  async run(request: WorkerRequest, _hooks?: WorkerRunHooks): Promise<WorkerResult> {
    this.requests.push(request);
    return this.result;
  }
}

class CallbackProvider implements WorkerProvider {
  constructor(private readonly callback: () => void) {}
  async run(_request: WorkerRequest, _hooks?: WorkerRunHooks): Promise<WorkerResult> {
    this.callback();
    return {
      exitReason: "completed",
      isError: false,
      summary: "local work completed",
      durationMs: 1,
      exitCode: 0,
    };
  }
}

describe("bootstrapAgent", () => {
  let tempDir: string;
  let targetRepoPath: string;
  let worktreesRoot: string;
  let store: JobStore;
  let jira: FakeJiraGateway;
  let baseConfig: AppConfig;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "ggjira-runtime-test-"));
    targetRepoPath = path.join(tempDir, "target-repo");
    worktreesRoot = path.join(tempDir, "worktrees");
    initTargetRepo(targetRepoPath);
    store = new JobStore(path.join(tempDir, "data"));
    jira = new FakeJiraGateway();
    baseConfig = buildTestConfig({
      workspace: { path: targetRepoPath, baseBranch: "main", validateCommand: null },
    });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("v4 implements an issue assigned to the same account as the agent", async () => {
    jira.setSelf({ accountId: "agent-account", displayName: "GGJIRA", emailAddress: null });
    const config = buildV4Config({
      jira: { baseUrl: "https://example.atlassian.net", projectKey: "KAN" },
      agent: {
        identity: "dev-machine",
        role: "implement",
        machine: "test-machine",
        backends: ["filesystem", "git", "coding-runtime"],
      },
      workflow: {
        ...baseConfig.workflow,
        planningStatus: "Ready for Planning",
        implementationStatus: "AI Implementation",
        inProgressStatus: "In Progress",
        reviewStatus: "In Review",
      },
      workspace: { path: targetRepoPath, baseBranch: "main", validateCommand: null },
    });
    const provider = new StaticProvider({
      exitReason: "completed",
      isError: false,
      summary: "ok",
      durationMs: 1,
      exitCode: 0,
      structuredOutput: {
        needsDecision: false,
        summary: "planned",
        objective: "Implement the feature",
        acceptanceCriteria: ["works"],
        dependencies: [],
        constraints: [],
        requiredCapabilities: ["programming"],
        suggestedExecutionStrategy: "Use the existing architecture",
        tasks: [],
        keepTaskKeys: [],
        agentProfiles: [],
        disableAgentIds: [],
      },
    });
    const runtime = await bootstrapAgent({
      config,
      jira,
      store,
      provider,
      worktreesRoot,
    });

    const planningIssue = buildTestIssue({
      key: "KAN-20",
      statusName: "Ready for Planning",
      assigneeAccountId: "human-account",
    });
    jira.seedIssue(planningIssue, [
      { id: "1", name: "Start planning", toStatusName: "In Progress" },
    ]);
    const planningJob = await runJobForIssue(planningIssue, config, runtime.cycleDeps);
    expect(planningJob?.status).toBe("succeeded");

    const implementationIssue = buildTestIssue({
      key: "KAN-21",
      statusName: "AI Implementation",
      assigneeAccountId: "agent-account",
      description: "Implement the requested change.",
    });
    jira.seedIssue(implementationIssue, [
      { id: "2", name: "Start", toStatusName: "In Progress" },
      { id: "3", name: "Send to review", toStatusName: "In Review" },
    ]);
    const implementationJob = await runJobForIssue(implementationIssue, config, runtime.cycleDeps);
    expect(implementationJob?.status).toBe("succeeded");
    expect(jira.assignments).toHaveLength(0);
    // The status-based workflow (ADR 0015): claiming moves the issue to the
    // in-progress status, finishing moves it to review, and nothing closes it.
    expect(jira.transitions).toContainEqual({ key: "KAN-21", transitionName: "Start" });
    expect(jira.transitions).toContainEqual({ key: "KAN-21", transitionName: "Send to review" });
  });

  it("implements directly in a workspace without Git", async () => {
    const workspacePath = path.join(tempDir, "plain-workspace");
    mkdirSync(workspacePath);
    const issue = buildTestIssue({
      key: "KAN-plain",
      statusName: "AI Implementation",
      assigneeAccountId: "agent-account",
    });
    jira.seedIssue(issue, [{ id: "2", name: "In Review", toStatusName: "Review" }]);
    const config = buildTestConfig({
      configVersion: 4,
      jira: { baseUrl: "https://example.atlassian.net", projectKey: "KAN" },
      workflow: { ...baseConfig.workflow, implementationStatus: "AI Implementation" },
      workspace: { path: workspacePath, baseBranch: "main", validateCommand: null },
    });
    const outputPath = path.join(workspacePath, "result.txt");
    const runtime = await bootstrapAgent({
      config,
      jira,
      store,
      worktreesRoot,
      provider: new CallbackProvider(() => writeFileSync(outputPath, "implemented")),
    });

    const job = await runJobForIssue(issue, config, runtime.cycleDeps);
    expect(job?.status).toBe("succeeded");
    expect(job?.branch).toBeUndefined();
    expect(existsSync(outputPath)).toBe(true);
    expect(jira.comments.at(-1)?.body).toContain("direct edits; no Git branch or commit");
  });

  it("v4 discards a successful provider result when a human withdraws approval", async () => {
    jira.setSelf({ accountId: "agent-account", displayName: "GGJIRA", emailAddress: null });
    const issue = buildTestIssue({
      key: "KAN-30",
      statusName: "AI Implementation",
      assigneeAccountId: "human-account",
      description: "h2. Required Capabilities\n* programming",
    });
    jira.seedIssue(issue, [{ id: "2", name: "In Review", toStatusName: "Review" }]);
    const config = buildTestConfig({
      configVersion: 4,
      jira: { baseUrl: "https://example.atlassian.net", projectKey: "KAN" },
      agent: {
        identity: "dev-machine",
        role: "implement",
        machine: "test-machine",
        backends: ["filesystem", "git", "coding-runtime"],
      },
      workflow: { ...baseConfig.workflow, implementationStatus: "AI Implementation" },
      workspace: { path: targetRepoPath, baseBranch: "main", validateCommand: null },
    });
    const runtime = await bootstrapAgent({
      config,
      jira,
      store,
      worktreesRoot,
      provider: new CallbackProvider(() => {
        jira.seedIssue({ ...issue, statusName: "In Progress" });
      }),
    });

    const job = await runJobForIssue(issue, config, runtime.cycleDeps);

    expect(job?.status).toBe("cancelled");
    expect(jira.transitions).not.toContainEqual({ key: issue.key, transitionName: "In Review" });
    expect(jira.comments.at(-1)?.body).toContain("AI execution stopped");
  });

  it("authenticates against Jira and exposes self on the runtime", async () => {
    const self = { accountId: "acc-1", displayName: "GGJIRA Implement", emailAddress: null };
    jira.setSelf(self);

    const runtime = await bootstrapAgent({
      config: baseConfig,
      jira,
      store,
      provider: new StaticProvider({
        exitReason: "completed",
        isError: false,
        summary: "ok",
        durationMs: 1,
        exitCode: 0,
      }),
      worktreesRoot,
    });

    expect(runtime.self).toEqual(self);
  });

  it("wires an implement handler for role=implement: a claimed issue lands on a git branch, no new issues created", async () => {
    jira.setSelf({ accountId: "acc-1", displayName: "GGJIRA Implement", emailAddress: null });
    const issue = buildTestIssue({ key: "KAN-1" });
    jira.seedIssue(issue, [{ id: "21", name: "In Progress", toStatusName: "In Progress" }]);

    const runtime = await bootstrapAgent({
      config: baseConfig,
      jira,
      store,
      provider: new StaticProvider({
        exitReason: "completed",
        isError: false,
        summary: "did it",
        durationMs: 1,
        exitCode: 0,
      }),
      worktreesRoot,
    });

    const job = await runJobForIssue(issue, baseConfig, runtime.cycleDeps);

    expect(job?.branch).toMatch(/^ggjira\/KAN-1-/);
    expect(jira.createdIssues).toHaveLength(0);
  });

  it("wires a pm handler for role=pm: a claimed issue results in created subtasks, no branch", async () => {
    const pmConfig = buildTestConfig({
      agent: { identity: "ggjira-pm", role: "pm", machine: "test-machine" },
      workspace: { path: targetRepoPath, baseBranch: "main", validateCommand: null },
    });
    jira.setSelf({ accountId: "pm-acc", displayName: "GGJIRA PM", emailAddress: null });
    jira.seedUser({
      accountId: "impl-acc",
      displayName: "GGJIRA Implement",
      emailAddress: "ggjira-implement@example.com",
    });
    const issue = buildTestIssue({ key: "KAN-2", projectKey: "KAN" });
    jira.seedIssue(issue, [{ id: "21", name: "In Progress", toStatusName: "In Progress" }]);

    const runtime = await bootstrapAgent({
      config: pmConfig,
      jira,
      store,
      provider: new StaticProvider({
        exitReason: "completed",
        isError: false,
        summary: "plan",
        durationMs: 1,
        exitCode: 0,
        structuredOutput: {
          needsDecision: false,
          summary: "plan",
          tasks: [{ title: "T1", description: "D1", acceptance: [] }],
          keepTaskKeys: [],
        },
      }),
      worktreesRoot,
    });

    const job = await runJobForIssue(issue, pmConfig, runtime.cycleDeps);

    expect(job?.branch).toBeUndefined();
    expect(jira.createdIssues).toHaveLength(1);
  });

  it("in legacy mode, the worker receives the unmodified buildImplementSystemPrompt() text", async () => {
    jira.setSelf({ accountId: "acc-1", displayName: "GGJIRA Implement", emailAddress: null });
    const issue = buildTestIssue({ key: "KAN-1" });
    jira.seedIssue(issue, [{ id: "21", name: "In Progress", toStatusName: "In Progress" }]);
    const provider = new RecordingProvider({
      exitReason: "completed",
      isError: false,
      summary: "did it",
      durationMs: 1,
      exitCode: 0,
    });

    const runtime = await bootstrapAgent({
      config: baseConfig,
      jira,
      store,
      provider,
      worktreesRoot,
    });
    await runJobForIssue(issue, baseConfig, runtime.cycleDeps);

    expect(runtime.context).toBeUndefined();
    expect(provider.requests[0]?.systemPrompt).toBe(buildImplementSystemPrompt());
  });

  it("in profile mode, the worker's system prompt is composed with the registered profile's Human Instructions", async () => {
    const profileConfig = buildProfileModeConfig({
      workspace: { path: targetRepoPath, baseBranch: "main", validateCommand: null },
    });
    jira.setSelf({ accountId: "acc-1", displayName: "GGJIRA Implement", emailAddress: null });
    const profile = await createAgentProfile(jira, {
      projectKey: "KAN",
      issueTypeName: "Task",
      agentId: "unity-implement-01",
      displayName: "Unity Implement 01",
      role: "implement",
      preset: null,
      capabilities: [],
      workStyle: [],
      humanInstructions: ["favor maintainability over performance"],
    });
    await claimAgentProfile(jira, profile, profileConfig.agent.machineId as string, {
      settleMs: 0,
    });
    const config = {
      ...profileConfig,
      agent: { ...profileConfig.agent, profileKey: profile.issueKey },
    };
    const issue = buildTestIssue({ key: "KAN-2", projectKey: "KAN" });
    jira.seedIssue(issue, [{ id: "21", name: "In Progress", toStatusName: "In Progress" }]);
    const provider = new RecordingProvider({
      exitReason: "completed",
      isError: false,
      summary: "did it",
      durationMs: 1,
      exitCode: 0,
    });

    const runtime = await bootstrapAgent({ config, jira, store, provider, worktreesRoot });
    await runJobForIssue(issue, config, runtime.cycleDeps);

    expect(runtime.context?.profile.agentId).toBe("unity-implement-01");
    expect(provider.requests[0]?.systemPrompt).toContain("favor maintainability over performance");
    expect(provider.requests[0]?.systemPrompt).toContain(buildImplementSystemPrompt());
  });

  it("throws when the configured profile is not registered to this machine", async () => {
    const profileConfig = buildProfileModeConfig({
      workspace: { path: targetRepoPath, baseBranch: "main", validateCommand: null },
    });
    jira.setSelf({ accountId: "acc-1", displayName: "GGJIRA Implement", emailAddress: null });
    const profile = await createAgentProfile(jira, {
      projectKey: "KAN",
      issueTypeName: "Task",
      agentId: "unity-implement-01",
      displayName: "Unity Implement 01",
      role: "implement",
      preset: null,
      capabilities: [],
      workStyle: [],
      humanInstructions: [],
    });
    // Never claimed -- unregistered.
    const config = {
      ...profileConfig,
      agent: { ...profileConfig.agent, profileKey: profile.issueKey },
    };

    await expect(
      bootstrapAgent({
        config,
        jira,
        store,
        provider: new StaticProvider({
          exitReason: "completed",
          isError: false,
          summary: "ok",
          durationMs: 1,
          exitCode: 0,
        }),
        worktreesRoot,
      }),
    ).rejects.toThrow(AgentRegistrationMismatchError);
  });

  it("boots successfully but shouldPoll resolves false when the profile is disabled", async () => {
    const profileConfig = buildProfileModeConfig({
      workspace: { path: targetRepoPath, baseBranch: "main", validateCommand: null },
    });
    jira.setSelf({ accountId: "acc-1", displayName: "GGJIRA Implement", emailAddress: null });
    const profile = await createAgentProfile(jira, {
      projectKey: "KAN",
      issueTypeName: "Task",
      agentId: "unity-implement-01",
      displayName: "Unity Implement 01",
      role: "implement",
      preset: null,
      capabilities: [],
      workStyle: [],
      humanInstructions: [],
    });
    await claimAgentProfile(jira, profile, profileConfig.agent.machineId as string, {
      settleMs: 0,
    });
    await jira.addLabel(profile.issueKey, "ggjira-disabled");
    const config = {
      ...profileConfig,
      agent: { ...profileConfig.agent, profileKey: profile.issueKey },
    };

    const runtime = await bootstrapAgent({
      config,
      jira,
      store,
      provider: new StaticProvider({
        exitReason: "completed",
        isError: false,
        summary: "ok",
        durationMs: 1,
        exitCode: 0,
      }),
      worktreesRoot,
    });

    expect(await runtime.cycleDeps.shouldPoll?.()).toBe(false);
  });
});

describe("bootstrapAgent distribution gating", () => {
  let tempDir: string;
  let targetRepoPath: string;
  let worktreesRoot: string;
  let store: JobStore;
  let jira: FakeJiraGateway;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "ggjira-runtime-distribution-test-"));
    targetRepoPath = path.join(tempDir, "target-repo");
    worktreesRoot = path.join(tempDir, "worktrees");
    initTargetRepo(targetRepoPath);
    store = new JobStore(path.join(tempDir, "data"));
    jira = new FakeJiraGateway();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function buildDistributionConfig(overrides: Partial<AppConfig> = {}): AppConfig {
    return buildTestConfig({
      configVersion: 4,
      jira: { baseUrl: "https://example.atlassian.net", projectKey: "KAN" },
      agent: { identity: "impl-1", role: "implement", machine: "test-machine" },
      workflow: {
        ...buildTestConfig().workflow,
        implementationStatus: "AI Implementation",
        inProgressStatus: "In Progress",
        reviewStatus: "In Review",
        planningStatus: "AI Planning",
        planningInProgressStatus: "AI Planning In Progress",
        planReviewStatus: "Plan Review",
        executionApprovedStatus: "Execution Approved",
        taskWaitingStatus: "Waiting for Assignment",
      },
      workspace: { path: targetRepoPath, baseBranch: "main", validateCommand: null },
      distribution: {
        enabled: true,
        executionAgentFieldId: "customfield_12345",
        workspaceId: "workspace-a",
        executionAgentOptionId: "agent-a",
      },
      ...overrides,
    });
  }

  const successProvider = () =>
    new StaticProvider({
      exitReason: "completed",
      isError: false,
      summary: "ok",
      durationMs: 1,
      exitCode: 0,
    });

  it("cancels when the execution agent assignment was withdrawn before execution", async () => {
    const config = buildDistributionConfig();
    const issue = buildTestIssue({
      key: "KAN-40",
      statusName: "AI Implementation",
      assigneeAccountId: "human-account",
      executionAgentOptionId: "some-other-agent",
    });
    jira.seedIssue(issue, [{ id: "1", name: "Start", toStatusName: "In Progress" }]);
    const runtime = await bootstrapAgent({
      config,
      jira,
      store,
      provider: successProvider(),
      worktreesRoot,
    });

    const job = await runJobForIssue(issue, config, runtime.cycleDeps);

    expect(job?.status).toBe("cancelled");
    expect(job?.summary).toContain("withdrawn before execution");
  });

  it("fails when the plan-task metadata names a different workspace", async () => {
    const config = buildDistributionConfig();
    const issue = buildTestIssue({
      key: "KAN-41",
      statusName: "AI Implementation",
      assigneeAccountId: "human-account",
      executionAgentOptionId: "agent-a",
    });
    jira.seedIssue(issue, [{ id: "1", name: "Start", toStatusName: "In Progress" }]);
    await jira.setIssueProperty(issue.key, PLAN_TASK_PROPERTY_KEY, {
      planVersion: "v1",
      taskId: "task-1",
      parentKey: "KAN-1",
      workspaceId: "some-other-workspace",
      dependencies: [],
    });
    const runtime = await bootstrapAgent({
      config,
      jira,
      store,
      provider: successProvider(),
      worktreesRoot,
    });

    const job = await runJobForIssue(issue, config, runtime.cycleDeps);

    expect(job?.status).toBe("failed");
    expect(job?.error).toContain("Expected workspace workspace-a");
  });

  it("cancels when the parent plan is not (yet, or no longer) approved for execution", async () => {
    const config = buildDistributionConfig();
    const parent = buildTestIssue({ key: "KAN-1", statusName: "Plan Review" });
    jira.seedIssue(parent);
    const issue = buildTestIssue({
      key: "KAN-42",
      statusName: "AI Implementation",
      assigneeAccountId: "human-account",
      executionAgentOptionId: "agent-a",
    });
    jira.seedIssue(issue, [{ id: "1", name: "Start", toStatusName: "In Progress" }]);
    await jira.setIssueProperty(issue.key, PLAN_TASK_PROPERTY_KEY, {
      planVersion: "v1",
      taskId: "task-1",
      parentKey: "KAN-1",
      workspaceId: "workspace-a",
      dependencies: [],
    });
    const runtime = await bootstrapAgent({
      config,
      jira,
      store,
      provider: successProvider(),
      worktreesRoot,
    });

    const job = await runJobForIssue(issue, config, runtime.cycleDeps);

    expect(job?.status).toBe("cancelled");
    expect(job?.summary).toContain("not approved for execution");
  });

  it("fails when the task's plan version no longer matches the parent's current plan", async () => {
    const config = buildDistributionConfig();
    const parent = buildTestIssue({ key: "KAN-1", statusName: "Execution Approved" });
    jira.seedIssue(parent);
    await jira.setIssueProperty(parent.key, PLAN_PROPERTY_KEY, {
      version: "v2",
      status: "review",
      taskIds: ["task-1"],
    });
    const issue = buildTestIssue({
      key: "KAN-43",
      statusName: "AI Implementation",
      assigneeAccountId: "human-account",
      executionAgentOptionId: "agent-a",
    });
    jira.seedIssue(issue, [{ id: "1", name: "Start", toStatusName: "In Progress" }]);
    await jira.setIssueProperty(issue.key, PLAN_TASK_PROPERTY_KEY, {
      planVersion: "v1", // stale -- a replan moved the parent to v2 without refreshing this task
      taskId: "task-1",
      parentKey: "KAN-1",
      workspaceId: "workspace-a",
      dependencies: [],
    });
    const runtime = await bootstrapAgent({
      config,
      jira,
      store,
      provider: successProvider(),
      worktreesRoot,
    });

    const job = await runJobForIssue(issue, config, runtime.cycleDeps);

    expect(job?.status).toBe("failed");
    expect(job?.error).toContain("Plan version mismatch");
  });

  it("fails closed when the plan-task metadata is present but corrupted", async () => {
    const config = buildDistributionConfig();
    const issue = buildTestIssue({
      key: "KAN-44",
      statusName: "AI Implementation",
      assigneeAccountId: "human-account",
      executionAgentOptionId: "agent-a",
    });
    jira.seedIssue(issue, [{ id: "1", name: "Start", toStatusName: "In Progress" }]);
    // Missing required fields (taskId, parentKey, workspaceId) -- present but not schema-shaped.
    await jira.setIssueProperty(issue.key, PLAN_TASK_PROPERTY_KEY, { planVersion: "v1" });
    const runtime = await bootstrapAgent({
      config,
      jira,
      store,
      provider: successProvider(),
      worktreesRoot,
    });

    const job = await runJobForIssue(issue, config, runtime.cycleDeps);

    expect(job?.status).toBe("failed");
    expect(job?.error).toContain("doesn't match the expected shape");
  });

  it("proceeds when the option, workspace, parent approval, and plan version all agree", async () => {
    const config = buildDistributionConfig();
    const parent = buildTestIssue({ key: "KAN-1", statusName: "Execution Approved" });
    jira.seedIssue(parent);
    await jira.setIssueProperty(parent.key, PLAN_PROPERTY_KEY, {
      version: "v1",
      status: "review",
      taskIds: ["task-1"],
    });
    const issue = buildTestIssue({
      key: "KAN-45",
      statusName: "AI Implementation",
      assigneeAccountId: "human-account",
      executionAgentOptionId: "agent-a",
    });
    jira.seedIssue(issue, [
      { id: "1", name: "Start", toStatusName: "In Progress" },
      { id: "2", name: "Send to review", toStatusName: "In Review" },
    ]);
    await jira.setIssueProperty(issue.key, PLAN_TASK_PROPERTY_KEY, {
      planVersion: "v1",
      taskId: "task-1",
      parentKey: "KAN-1",
      workspaceId: "workspace-a",
      dependencies: [],
    });
    const runtime = await bootstrapAgent({
      config,
      jira,
      store,
      provider: successProvider(),
      worktreesRoot,
    });

    const job = await runJobForIssue(issue, config, runtime.cycleDeps);

    expect(job?.status).toBe("succeeded");
  });
});
