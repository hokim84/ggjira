import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapAgent } from "../src/agent/runtime.js";
import type { AppConfig } from "../src/config.js";
import { FakeJiraGateway } from "../src/jira/fake.js";
import { runJobForIssue } from "../src/job/runner.js";
import { JobStore } from "../src/job/store.js";
import type {
  WorkerProvider,
  WorkerRequest,
  WorkerResult,
  WorkerRunHooks,
} from "../src/worker/provider.js";
import { buildTestConfig, buildTestIssue } from "./helpers/fixtures.js";

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
});
