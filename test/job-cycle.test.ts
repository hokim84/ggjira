import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { FakeJiraGateway } from "../src/jira/fake.js";
import type { JiraIssue } from "../src/jira/types.js";
import { recoverStaleClaims, runPollCycle } from "../src/job/cycle.js";
import { createJob, transitionJob } from "../src/job/job.js";
import { JobStore } from "../src/job/store.js";
import { fakeSuccessResult } from "../src/worker/fake.js";
import type {
  WorkerProvider,
  WorkerRequest,
  WorkerResult,
  WorkerRunHooks,
} from "../src/worker/provider.js";

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

function baseConfig(targetRepoPath: string): AppConfig {
  return {
    jira: {
      jql: 'project = KAN AND labels = "ggjira"',
      inProgressTransitionName: "In Progress",
      successTransitionName: "In Review",
      failureLabel: "ggjira-failed",
    },
    polling: { intervalMs: 60000 },
    targetRepo: { path: targetRepoPath, baseBranch: "main" },
    worker: {
      command: "unused",
      model: "sonnet",
      effort: "high",
      timeoutMs: 60000,
      permissionMode: "acceptEdits",
      allowedTools: [],
    },
    concurrency: { maxConcurrentJobs: 1 },
  };
}

function issue(key: string): JiraIssue {
  return {
    key,
    id: key,
    summary: `summary for ${key}`,
    description: null,
    statusName: "To Do",
    labels: ["ggjira"],
  };
}

class SequentialWorkerProvider implements WorkerProvider {
  readonly startedOrder: string[] = [];
  private counter = 0;

  async run(request: WorkerRequest, _hooks?: WorkerRunHooks): Promise<WorkerResult> {
    this.startedOrder.push(request.cwd);
    this.counter += 1;
    writeFileSync(path.join(request.cwd, `output-${this.counter}.txt`), "done\n");
    return fakeSuccessResult({ summary: `did work #${this.counter}` });
  }
}

class ThrowingSearchGateway extends FakeJiraGateway {
  override async searchIssues(): Promise<JiraIssue[]> {
    throw new Error("jira search is down");
  }
}

describe("runPollCycle", () => {
  let tempDir: string;
  let targetRepoPath: string;
  let worktreesRoot: string;
  let store: JobStore;
  let config: AppConfig;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "ggjira-cycle-test-"));
    targetRepoPath = path.join(tempDir, "target-repo");
    worktreesRoot = path.join(tempDir, "worktrees");
    initTargetRepo(targetRepoPath);
    store = new JobStore(path.join(tempDir, "data"));
    config = baseConfig(targetRepoPath);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("processes multiple candidate issues sequentially, each with its own recorded run", async () => {
    const jira = new FakeJiraGateway();
    for (const key of ["KAN-1", "KAN-2", "KAN-3"]) {
      jira.seedIssue(issue(key), [
        { id: "21", name: "In Progress", toStatusName: "In Progress" },
        { id: "31", name: "In Review", toStatusName: "In Review" },
      ]);
    }
    const worker = new SequentialWorkerProvider();

    const outcomes = await runPollCycle(config, { jira, store, worker, worktreesRoot });

    expect(outcomes).toHaveLength(3);
    expect(outcomes.map((o) => o.issue.key)).toEqual(["KAN-1", "KAN-2", "KAN-3"]);
    expect(outcomes.every((o) => o.job?.status === "succeeded")).toBe(true);

    // each issue got its own runId/worktree and its own recorded run on disk
    const runIds = outcomes.map((o) => o.job?.runId);
    expect(new Set(runIds).size).toBe(3);
    for (const outcome of outcomes) {
      const runId = outcome.job?.runId;
      if (!runId) throw new Error("expected runId");
      expect(store.loadJob(outcome.issue.key, runId)?.status).toBe("succeeded");
    }
    expect(worker.startedOrder).toHaveLength(3);
  });

  it("returns an empty cycle and does not throw when the Jira search fails", async () => {
    const jira = new ThrowingSearchGateway();
    const worker = new SequentialWorkerProvider();

    const outcomes = await runPollCycle(config, { jira, store, worker, worktreesRoot });

    expect(outcomes).toEqual([]);
    expect(worker.startedOrder).toHaveLength(0);
  });
});

describe("recoverStaleClaims", () => {
  let tempDir: string;
  let targetRepoPath: string;
  let worktreesRoot: string;
  let store: JobStore;
  let jira: FakeJiraGateway;
  let config: AppConfig;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "ggjira-recovery-test-"));
    targetRepoPath = path.join(tempDir, "target-repo");
    worktreesRoot = path.join(tempDir, "worktrees");
    initTargetRepo(targetRepoPath);
    store = new JobStore(path.join(tempDir, "data"));
    jira = new FakeJiraGateway();
    config = baseConfig(targetRepoPath);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("marks a job left 'running' as failed, reports it to Jira, and releases the claim", async () => {
    const key = "KAN-1";
    jira.seedIssue(issue(key), [{ id: "21", name: "In Progress", toStatusName: "In Progress" }]);
    store.claimIssue(key, "run-1");
    let job = transitionJob(createJob(key, "run-1"), "claimed");
    job = transitionJob(job, "running", { branch: "ggjira/KAN-1-run-1" });
    store.saveJob(job);

    await recoverStaleClaims(config, {
      jira,
      store,
      worker: new SequentialWorkerProvider(),
      worktreesRoot,
    });

    expect(store.getClaim(key)).toBeUndefined();
    const recovered = store.loadJob(key, "run-1");
    expect(recovered?.status).toBe("failed");
    expect(recovered?.failureStage).toBe("job");
    expect(jira.labelChanges).toEqual([{ key, label: "ggjira-failed", action: "add" }]);
    expect(jira.comments).toHaveLength(1);
  });

  it("just releases the claim for a job that already reached a terminal status", async () => {
    const key = "KAN-2";
    jira.seedIssue(issue(key));
    store.claimIssue(key, "run-2");
    let job = transitionJob(createJob(key, "run-2"), "claimed");
    job = transitionJob(job, "running");
    job = transitionJob(job, "succeeded", { summary: "already done" });
    store.saveJob(job);

    await recoverStaleClaims(config, {
      jira,
      store,
      worker: new SequentialWorkerProvider(),
      worktreesRoot,
    });

    expect(store.getClaim(key)).toBeUndefined();
    expect(store.loadJob(key, "run-2")?.status).toBe("succeeded");
    // no redundant Jira write for a job that was already terminal
    expect(jira.comments).toHaveLength(0);
    expect(jira.labelChanges).toHaveLength(0);
  });

  it("recovers a claim even when job.json is missing entirely", async () => {
    const key = "KAN-3";
    jira.seedIssue(issue(key), [{ id: "21", name: "In Progress", toStatusName: "In Progress" }]);
    store.claimIssue(key, "run-3");
    // no store.saveJob call — simulates a crash before the first save

    await recoverStaleClaims(config, {
      jira,
      store,
      worker: new SequentialWorkerProvider(),
      worktreesRoot,
    });

    expect(store.getClaim(key)).toBeUndefined();
    expect(store.loadJob(key, "run-3")?.status).toBe("failed");
  });

  it("recovers multiple independent stale claims in one call", async () => {
    for (const key of ["KAN-4", "KAN-5"]) {
      jira.seedIssue(issue(key), [{ id: "21", name: "In Progress", toStatusName: "In Progress" }]);
      store.claimIssue(key, `run-${key}`);
      store.saveJob(transitionJob(createJob(key, `run-${key}`), "claimed"));
    }

    await recoverStaleClaims(config, {
      jira,
      store,
      worker: new SequentialWorkerProvider(),
      worktreesRoot,
    });

    expect(store.getClaim("KAN-4")).toBeUndefined();
    expect(store.getClaim("KAN-5")).toBeUndefined();
    expect(store.loadJob("KAN-4", "run-KAN-4")?.status).toBe("failed");
    expect(store.loadJob("KAN-5", "run-KAN-5")?.status).toBe("failed");
  });

  it("does nothing when there are no stale claims", async () => {
    await recoverStaleClaims(config, {
      jira,
      store,
      worker: new SequentialWorkerProvider(),
      worktreesRoot,
    });
    expect(jira.comments).toHaveLength(0);
  });
});
