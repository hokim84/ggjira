import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { FakeJiraGateway } from "../src/jira/fake.js";
import { runJobForIssue } from "../src/job/runner.js";
import { JobStore } from "../src/job/store.js";
import { createPmHandler } from "../src/pm/executor.js";
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

class StaticPlanProvider implements WorkerProvider {
  constructor(
    private readonly structuredOutput: unknown,
    private readonly summary = "plan produced",
  ) {}
  async run(_request: WorkerRequest, _hooks?: WorkerRunHooks): Promise<WorkerResult> {
    return {
      exitReason: "completed",
      isError: false,
      summary: this.summary,
      durationMs: 5,
      exitCode: 0,
      structuredOutput: this.structuredOutput,
    };
  }
}

const PM = {
  accountId: "pm-account",
  displayName: "GGJIRA PM",
  emailAddress: "ggjira-pm@example.com",
};
const IMPLEMENT = {
  accountId: "implement-account",
  displayName: "GGJIRA Implement",
  emailAddress: "ggjira-implement@example.com",
};

describe("pm role E2E via runJobForIssue", () => {
  let tempDir: string;
  let targetRepoPath: string;
  let worktreesRoot: string;
  let store: JobStore;
  let jira: FakeJiraGateway;
  let config: AppConfig;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "ggjira-pm-executor-test-"));
    targetRepoPath = path.join(tempDir, "target-repo");
    worktreesRoot = path.join(tempDir, "worktrees");
    initTargetRepo(targetRepoPath);
    store = new JobStore(path.join(tempDir, "data"));
    jira = new FakeJiraGateway();
    jira.setSelf(PM);
    jira.seedUser(IMPLEMENT);
    config = buildTestConfig({
      agent: { identity: "ggjira-pm", role: "pm", machine: "test-machine" },
      workspace: { path: targetRepoPath, baseBranch: "main", validateCommand: null },
    });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates and assigns subtasks, then reports 'planned' when the plan needs no decision", async () => {
    const issue = buildTestIssue({
      key: "KAN-1",
      projectKey: "KAN",
      assigneeAccountId: PM.accountId,
    });
    jira.seedIssue(issue, [{ id: "21", name: "In Progress", toStatusName: "In Progress" }]);

    const provider = new StaticPlanProvider({
      needsDecision: false,
      summary: "Split into two tasks",
      tasks: [
        { title: "Task A", description: "Do A", acceptance: [] },
        { title: "Task B", description: "Do B", acceptance: [] },
      ],
      keepTaskKeys: [],
    });
    const handler = createPmHandler({ config, jira, provider, store, worktreesRoot });

    const job = await runJobForIssue(issue, config, { jira, store, handler });

    expect(job?.status).toBe("succeeded");
    expect(jira.createdIssues).toHaveLength(2);
    expect(jira.assignments.every((a) => a.accountId === IMPLEMENT.accountId)).toBe(true);
    expect(jira.comments.at(-1)?.body).toContain("Split into two tasks");
    expect(jira.transitions.map((t) => t.transitionName)).toEqual(["In Progress"]);
    expect(jira.labelChanges).toEqual([{ key: "KAN-1", label: "ggjira-planned", action: "add" }]);
  });

  it("posts a decision request and transitions to Needs Decision when the plan needs a decision", async () => {
    const issue = buildTestIssue({
      key: "KAN-2",
      projectKey: "KAN",
      assigneeAccountId: PM.accountId,
    });
    jira.seedIssue(issue, [
      { id: "21", name: "In Progress", toStatusName: "In Progress" },
      { id: "61", name: "Needs Decision", toStatusName: "Needs Decision" },
    ]);

    const provider = new StaticPlanProvider({
      needsDecision: true,
      summary: "Two viable approaches",
      tasks: [],
      keepTaskKeys: [],
      decision: {
        question: "Which approach?",
        options: [
          { id: "A", title: "Extend", pros: [], cons: [] },
          { id: "B", title: "New module", pros: [], cons: [] },
        ],
      },
    });
    const handler = createPmHandler({ config, jira, provider, store, worktreesRoot });

    const job = await runJobForIssue(issue, config, { jira, store, handler });

    expect(job?.status).toBe("succeeded");
    expect(jira.createdIssues).toHaveLength(0);
    expect(jira.comments.at(-1)?.body).toContain("[GGJIRA:DECISION-REQUEST]");
    expect(jira.transitions.map((t) => t.transitionName)).toEqual([
      "In Progress",
      "Needs Decision",
    ]);
  });

  it("fails the job when the provider's output doesn't parse as a valid plan", async () => {
    const issue = buildTestIssue({
      key: "KAN-3",
      projectKey: "KAN",
      assigneeAccountId: PM.accountId,
    });
    jira.seedIssue(issue, [{ id: "21", name: "In Progress", toStatusName: "In Progress" }]);

    const provider = new StaticPlanProvider(undefined, "not a plan, just prose");
    const handler = createPmHandler({ config, jira, provider, store, worktreesRoot });

    const job = await runJobForIssue(issue, config, { jira, store, handler });

    expect(job?.status).toBe("failed");
    expect(jira.labelChanges).toEqual([{ key: "KAN-3", label: "ggjira-failed", action: "add" }]);
  });
});
