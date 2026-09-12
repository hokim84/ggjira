import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentRegistrationMismatchError } from "../src/agent/context.js";
import { bootstrapAgent } from "../src/agent/runtime.js";
import type { AppConfig } from "../src/config.js";
import { FakeJiraGateway } from "../src/jira/fake.js";
import { runJobForIssue } from "../src/job/runner.js";
import { JobStore } from "../src/job/store.js";
import { claimAgentProfile, createAgentProfile } from "../src/profile/profile.js";
import { buildImplementSystemPrompt } from "../src/worker/prompt.js";
import type {
  WorkerProvider,
  WorkerRequest,
  WorkerResult,
  WorkerRunHooks,
} from "../src/worker/provider.js";
import { buildProfileModeConfig, buildTestConfig, buildTestIssue } from "./helpers/fixtures.js";

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

  it("v4 dispatches planning and implementation through the same runtime while preserving the human assignee", async () => {
    jira.setSelf({ accountId: "agent-account", displayName: "GGJIRA", emailAddress: null });
    const config = buildTestConfig({
      configVersion: 4,
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
    jira.seedIssue(planningIssue, [{ id: "1", name: "In Progress", toStatusName: "AI Planning" }]);
    const planningJob = await runJobForIssue(planningIssue, config, runtime.cycleDeps);
    expect(planningJob?.status).toBe("succeeded");

    const implementationIssue = buildTestIssue({
      key: "KAN-21",
      statusName: "AI Implementation",
      assigneeAccountId: "human-account",
      description: "h2. Required Capabilities\n* programming",
    });
    jira.seedIssue(implementationIssue, [{ id: "2", name: "In Review", toStatusName: "Review" }]);
    const implementationJob = await runJobForIssue(implementationIssue, config, runtime.cycleDeps);
    expect(implementationJob?.status).toBe("succeeded");
    expect(jira.assignments).toHaveLength(0);
    expect(jira.transitions).not.toContainEqual({
      key: "KAN-21",
      transitionName: config.workflow.claimTransitionName,
    });
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
