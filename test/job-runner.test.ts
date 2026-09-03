import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { createImplementHandler } from "../src/implement/executor.js";
import { FakeJiraGateway } from "../src/jira/fake.js";
import { runJobForIssue } from "../src/job/runner.js";
import { JobStore } from "../src/job/store.js";
import { fakeFailureResult, fakeSuccessResult, fakeTimeoutResult } from "../src/worker/fake.js";
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

const SELF = { accountId: "self-id", displayName: "GGJIRA Test Agent", emailAddress: null };

class WritesFileWorkerProvider implements WorkerProvider {
  async run(request: WorkerRequest, _hooks?: WorkerRunHooks): Promise<WorkerResult> {
    writeFileSync(path.join(request.cwd, "output.txt"), "did the work\n");
    return fakeSuccessResult({ summary: "wrote output.txt" });
  }
}

class StaticWorkerProvider implements WorkerProvider {
  constructor(private readonly result: WorkerResult) {}
  async run(_request: WorkerRequest, _hooks?: WorkerRunHooks): Promise<WorkerResult> {
    return this.result;
  }
}

class NeverCalledWorkerProvider implements WorkerProvider {
  async run(): Promise<WorkerResult> {
    throw new Error("worker should never have been invoked");
  }
}

describe("runJobForIssue", () => {
  let tempDir: string;
  let targetRepoPath: string;
  let dataDir: string;
  let worktreesRoot: string;
  let store: JobStore;
  let jira: FakeJiraGateway;
  let config: AppConfig;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "ggjira-runner-test-"));
    targetRepoPath = path.join(tempDir, "target-repo");
    dataDir = path.join(tempDir, "data");
    worktreesRoot = path.join(tempDir, "worktrees");
    initTargetRepo(targetRepoPath);
    store = new JobStore(dataDir);
    jira = new FakeJiraGateway();
    jira.setSelf(SELF);
    config = buildTestConfig({
      workspace: { path: targetRepoPath, baseBranch: "main", validateCommand: null },
    });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function handlerFor(provider: WorkerProvider) {
    return createImplementHandler({ config, provider, store, worktreesRoot });
  }

  it("runs the success path: claims in Jira, commits the change, reports success", async () => {
    const issue = buildTestIssue({ key: "KAN-1", assigneeAccountId: SELF.accountId });
    jira.seedIssue(issue, [
      { id: "21", name: "In Progress", toStatusName: "In Progress" },
      { id: "31", name: "In Review", toStatusName: "In Review" },
    ]);

    const job = await runJobForIssue(issue, config, {
      jira,
      store,
      handler: handlerFor(new WritesFileWorkerProvider()),
    });

    if (!job) throw new Error("expected job to be defined");

    expect(job.status).toBe("succeeded");
    expect(job.summary).toBe("wrote output.txt");
    expect(job.branch).toBe(`ggjira/${issue.key}-${job.runId}`);

    // Jira side effects, in order: claim transition, start comment, success comment, success transition.
    expect(jira.transitions.map((t) => t.transitionName)).toEqual(["In Progress", "In Review"]);
    expect(jira.comments).toHaveLength(2);
    expect(jira.comments[1]?.body).toContain("output.txt");

    // the worker's change was committed by GGJIRA, not the worker
    if (!job.branch) throw new Error("expected job.branch to be set");
    const log = execFileSync("git", ["log", "--oneline", "-1"], {
      cwd: path.join(worktreesRoot, job.branch.replace(/\//g, "-")),
    }).toString();
    expect(log).toContain("GGJIRA worker");

    // local claim released once the job reaches a terminal state
    expect(store.getClaim(issue.key)).toBeUndefined();

    // disk records survive independent of Jira reporting
    expect(store.loadJob(issue.key, job.runId)?.status).toBe("succeeded");
    const summary = readFileSync(store.summaryPath(issue.key, job.runId), "utf-8");
    expect(summary).toContain("output.txt");
  });

  it("reports failure and labels the issue when the worker exits non-zero", async () => {
    const issue = buildTestIssue({ key: "KAN-2", assigneeAccountId: SELF.accountId });
    jira.seedIssue(issue, [{ id: "21", name: "In Progress", toStatusName: "In Progress" }]);

    const job = await runJobForIssue(issue, config, {
      jira,
      store,
      handler: handlerFor(new StaticWorkerProvider(fakeFailureResult({ summary: "boom" }))),
    });

    expect(job?.status).toBe("failed");
    expect(job?.failureStage).toBe("worker");
    expect(job?.error).toBe("boom");

    expect(jira.labelChanges).toEqual([{ key: "KAN-2", label: "ggjira-failed", action: "add" }]);
    expect(jira.comments.at(-1)?.body).toContain("boom");
    expect(store.getClaim(issue.key)).toBeUndefined();
  });

  it("marks the job timed_out when the worker times out", async () => {
    const issue = buildTestIssue({ key: "KAN-3", assigneeAccountId: SELF.accountId });
    jira.seedIssue(issue, [{ id: "21", name: "In Progress", toStatusName: "In Progress" }]);

    const job = await runJobForIssue(issue, config, {
      jira,
      store,
      handler: handlerFor(new StaticWorkerProvider(fakeTimeoutResult())),
    });

    expect(job?.status).toBe("timed_out");
    expect(jira.labelChanges).toHaveLength(1);
  });

  it("keeps the job succeeded but flags reportingFailed when the success comment fails", async () => {
    const issue = buildTestIssue({ key: "KAN-9", assigneeAccountId: SELF.accountId });
    jira.seedIssue(issue, [
      { id: "21", name: "In Progress", toStatusName: "In Progress" },
      { id: "31", name: "In Review", toStatusName: "In Review" },
    ]);
    // let the claim/start comment through, but fail the success comment that follows
    jira.failNextComment(issue.key, (body) => body.includes("Implementation completed."));

    const job = await runJobForIssue(issue, config, {
      jira,
      store,
      handler: handlerFor(new WritesFileWorkerProvider()),
    });

    if (!job) throw new Error("expected job to be defined");
    expect(job.status).toBe("succeeded");
    expect(job.reportingFailed).toBe(true);
    expect(job.reportingError).toContain("addComment rejected");
    // the success transition never ran, since the comment before it threw
    expect(jira.transitions.map((t) => t.transitionName)).toEqual(["In Progress"]);

    // persisted to disk too, not just the in-memory return value
    expect(store.loadJob(issue.key, job.runId)?.reportingFailed).toBe(true);
  });

  it("cancels (not fails) the job when Jira rejects the claim transition — another agent got there first", async () => {
    const issue = buildTestIssue({ key: "KAN-4", assigneeAccountId: SELF.accountId });
    jira.seedIssue(issue, [{ id: "21", name: "In Progress", toStatusName: "In Progress" }]);
    jira.failNextTransition(issue.key);

    const job = await runJobForIssue(issue, config, {
      jira,
      store,
      handler: handlerFor(new NeverCalledWorkerProvider()),
    });

    expect(job?.status).toBe("cancelled");
    expect(store.getClaim(issue.key)).toBeUndefined();
    // no comment/label was attempted since a claim loss is not reported to Jira
    expect(jira.comments).toHaveLength(0);
    expect(jira.labelChanges).toHaveLength(0);
  });

  it("cancels the job without attempting a transition when the issue already moved off the ready status", async () => {
    const issue = buildTestIssue({
      key: "KAN-6",
      assigneeAccountId: SELF.accountId,
      statusName: "In Progress",
    });
    jira.seedIssue(issue, [{ id: "21", name: "In Progress", toStatusName: "In Progress" }]);

    const job = await runJobForIssue(issue, config, {
      jira,
      store,
      handler: handlerFor(new NeverCalledWorkerProvider()),
    });

    expect(job?.status).toBe("cancelled");
    expect(jira.transitions).toHaveLength(0);
  });

  it("skips the issue without touching Jira when it is already claimed locally", async () => {
    const issue = buildTestIssue({ key: "KAN-5", assigneeAccountId: SELF.accountId });
    jira.seedIssue(issue, [{ id: "21", name: "In Progress", toStatusName: "In Progress" }]);
    store.claimIssue(issue.key, "some-other-run");

    const job = await runJobForIssue(issue, config, {
      jira,
      store,
      handler: handlerFor(new NeverCalledWorkerProvider()),
    });

    expect(job).toBeUndefined();
    expect(jira.transitions).toHaveLength(0);
    expect(store.getClaim(issue.key)).toBe("some-other-run");
  });
});
