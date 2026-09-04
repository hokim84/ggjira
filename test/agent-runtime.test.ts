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
