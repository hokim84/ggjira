import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderSections } from "../src/profile/description.js";
import { FakeJiraGateway } from "../src/jira/fake.js";
import { getActiveAttemptForWorker } from "../src/router/db/attempts.js";
import { openRouterDb } from "../src/router/db/connection.js";
import { getOpenJobForIssue, getQueuedJobs } from "../src/router/db/jobs.js";
import { RuleDecisionProvider } from "../src/router/decision.js";
import type { RouterConfig, WorkerPolicyConfig, WorkspaceConfig } from "../src/router/config.js";
import {
  reconcileCandidates,
  type SchedulerDeps,
  type WorkerAvailability,
} from "../src/router/scheduler.js";

const REQUEST_STATUS = "AI 작업 요청";
const PLANNING_STATUS = "AI 계획 요청";
const IN_PROGRESS_STATUS = "작업 중";
const REVIEW_STATUS = "AI 작업 완료";

const workspace: WorkspaceConfig = {
  id: "ws1",
  repositoryId: "repo1",
  projectKeys: ["KAN"],
  workflow: {
    requestStatus: REQUEST_STATUS,
    planningStatus: PLANNING_STATUS,
    inProgressStatus: IN_PROGRESS_STATUS,
    reviewStatus: REVIEW_STATUS,
  },
};

function description(opts: { dependencies?: string[]; capabilities?: string[] } = {}): string {
  return renderSections([
    { heading: "Dependencies", items: opts.dependencies ?? [] },
    { heading: "Required Capabilities", items: opts.capabilities ?? ["programming"] },
  ]);
}

function buildConfig(overrides: Partial<RouterConfig> = {}): RouterConfig {
  return {
    configVersion: 5,
    jira: { baseUrl: "https://example.atlassian.net" },
    repositories: [{ id: "repo1" }],
    workspaces: [workspace],
    workers: [],
    db: { path: "data/router.sqlite3" },
    http: { host: "127.0.0.1", port: 8787 },
    reconciliation: {
      startupFullSyncOnBoot: true,
      backgroundIntervalMs: 60_000,
      activeJobPollIntervalMs: 5_000,
    },
    ...overrides,
  };
}

function workerPolicy(overrides: Partial<WorkerPolicyConfig> = {}): WorkerPolicyConfig {
  return {
    workerId: "worker-1",
    allowedCapabilities: ["programming"],
    allowedRepositoryIds: ["repo1"],
    enabled: true,
    ...overrides,
  };
}

function workerAvailability(overrides: Partial<WorkerAvailability> = {}): WorkerAvailability {
  return {
    workerId: "worker-1",
    capabilities: ["programming"],
    repositoryIds: ["repo1"],
    lastAssignedAt: null,
    ...overrides,
  };
}

function makeClock(startMs = Date.parse("2026-01-01T00:00:00.000Z")): () => string {
  let ms = startMs;
  return () => {
    const value = new Date(ms).toISOString();
    ms += 1000;
    return value;
  };
}

function makeIdGenerator(prefix: string): () => string {
  let counter = 0;
  return () => `${prefix}-${counter++}`;
}

describe("reconcileCandidates", () => {
  let dataDir: string;
  let db: Database.Database;
  let jira: FakeJiraGateway;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "ggjira-router-scheduler-test-"));
    db = openRouterDb(path.join(dataDir, "router.sqlite3"));
    jira = new FakeJiraGateway();
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function makeDeps(config: RouterConfig, overrides: Partial<SchedulerDeps> = {}): SchedulerDeps {
    return {
      db,
      jira,
      config,
      decisionProvider: new RuleDecisionProvider(config.executionAgent),
      now: makeClock(),
      genId: makeIdGenerator("id"),
      ...overrides,
    };
  }

  it("creates a queued job for a new approved candidate", async () => {
    jira.seedIssue({
      key: "KAN-1",
      statusName: REQUEST_STATUS,
      projectKey: "KAN",
      assigneeAccountId: "user-1",
      description: description(),
    });
    const config = buildConfig();

    const report = await reconcileCandidates(makeDeps(config), []);

    expect(report.jobsCreated).toHaveLength(1);
    const job = getOpenJobForIssue(db, "KAN-1");
    expect(job?.state).toBe("queued");
    expect(job?.kind).toBe("implementation");
  });

  it("does not create a second job for the same issue on a repeated reconcile", async () => {
    jira.seedIssue({
      key: "KAN-1",
      statusName: REQUEST_STATUS,
      projectKey: "KAN",
      assigneeAccountId: "user-1",
      description: description(),
    });
    const config = buildConfig();
    const deps = makeDeps(config);

    await reconcileCandidates(deps, []);
    const second = await reconcileCandidates(deps, []);

    expect(second.jobsCreated).toHaveLength(0);
    const job = getOpenJobForIssue(db, "KAN-1");
    expect(job?.state).toBe("queued");
  });

  it("dispatches a planning job for an issue in planningStatus", async () => {
    jira.seedIssue({
      key: "KAN-1",
      statusName: PLANNING_STATUS,
      projectKey: "KAN",
      assigneeAccountId: "user-1",
      description: description(),
    });
    const config = buildConfig();

    await reconcileCandidates(makeDeps(config), []);

    expect(getOpenJobForIssue(db, "KAN-1")?.kind).toBe("planning");
  });

  it("holds for a human and processes other candidates when metadata is invalid or assignee is missing", async () => {
    jira.seedIssue({
      key: "KAN-1",
      statusName: REQUEST_STATUS,
      projectKey: "KAN",
      assigneeAccountId: null, // no human assignee
      description: description(),
    });
    jira.seedIssue({
      key: "KAN-2",
      statusName: REQUEST_STATUS,
      projectKey: "KAN",
      assigneeAccountId: "user-1",
      description: description(),
    });
    const config = buildConfig();

    const report = await reconcileCandidates(makeDeps(config), []);

    expect(report.held).toEqual([
      { issueKey: "KAN-1", target: "human", reason: expect.any(String) },
    ]);
    expect(getOpenJobForIssue(db, "KAN-1")).toBeUndefined();
    expect(getOpenJobForIssue(db, "KAN-2")?.state).toBe("queued");
  });

  it("assigns a queued job to the only matching available worker", async () => {
    jira.seedIssue({
      key: "KAN-1",
      statusName: REQUEST_STATUS,
      projectKey: "KAN",
      assigneeAccountId: "user-1",
      description: description(),
    });
    const config = buildConfig({ workers: [workerPolicy()] });

    const report = await reconcileCandidates(makeDeps(config), [workerAvailability()]);

    expect(report.jobsAssigned).toEqual([{ jobId: expect.any(String), workerId: "worker-1" }]);
    expect(getOpenJobForIssue(db, "KAN-1")?.state).toBe("leased");
    expect(getActiveAttemptForWorker(db, "worker-1")).toBeDefined();
  });

  it("leaves the job queued when no available worker has the required capability", async () => {
    jira.seedIssue({
      key: "KAN-1",
      statusName: REQUEST_STATUS,
      projectKey: "KAN",
      assigneeAccountId: "user-1",
      description: description({ capabilities: ["testing"] }),
    });
    const config = buildConfig({
      workers: [workerPolicy({ allowedCapabilities: ["programming"] })],
    });

    const report = await reconcileCandidates(makeDeps(config), [
      workerAvailability({ capabilities: ["programming"] }),
    ]);

    expect(report.jobsAssigned).toHaveLength(0);
    expect(getOpenJobForIssue(db, "KAN-1")?.state).toBe("queued");
  });

  it("leaves the job queued when the available worker isn't allowed the job's repository", async () => {
    jira.seedIssue({
      key: "KAN-1",
      statusName: REQUEST_STATUS,
      projectKey: "KAN",
      assigneeAccountId: "user-1",
      description: description(),
    });
    const config = buildConfig({
      workers: [workerPolicy({ allowedRepositoryIds: ["other-repo"] })],
    });

    const report = await reconcileCandidates(makeDeps(config), [
      workerAvailability({ repositoryIds: ["other-repo"] }),
    ]);

    expect(report.jobsAssigned).toHaveLength(0);
    expect(getOpenJobForIssue(db, "KAN-1")?.state).toBe("queued");
  });

  it("assigns only one of two matching queued jobs when only one worker is available", async () => {
    jira.seedIssue({
      key: "KAN-1",
      statusName: REQUEST_STATUS,
      projectKey: "KAN",
      assigneeAccountId: "user-1",
      description: description(),
    });
    jira.seedIssue({
      key: "KAN-2",
      statusName: REQUEST_STATUS,
      projectKey: "KAN",
      assigneeAccountId: "user-1",
      description: description(),
    });
    const config = buildConfig({ workers: [workerPolicy()] });

    const report = await reconcileCandidates(makeDeps(config), [workerAvailability()]);

    expect(report.jobsAssigned).toHaveLength(1);
    const states = [getOpenJobForIssue(db, "KAN-1")?.state, getOpenJobForIssue(db, "KAN-2")?.state];
    expect(states.filter((s) => s === "leased")).toHaveLength(1);
    expect(states.filter((s) => s === "queued")).toHaveLength(1);
  });

  it("grants exactly one lease when two workers are available for one job", async () => {
    jira.seedIssue({
      key: "KAN-1",
      statusName: REQUEST_STATUS,
      projectKey: "KAN",
      assigneeAccountId: "user-1",
      description: description(),
    });
    const config = buildConfig({
      workers: [workerPolicy({ workerId: "worker-1" }), workerPolicy({ workerId: "worker-2" })],
    });

    const report = await reconcileCandidates(makeDeps(config), [
      workerAvailability({ workerId: "worker-1" }),
      workerAvailability({ workerId: "worker-2" }),
    ]);

    expect(report.jobsAssigned).toHaveLength(1);
    const assignedWorkerId = report.jobsAssigned[0]?.workerId;
    expect(getActiveAttemptForWorker(db, assignedWorkerId ?? "")).toBeDefined();
    const otherWorkerId = assignedWorkerId === "worker-1" ? "worker-2" : "worker-1";
    expect(getActiveAttemptForWorker(db, otherWorkerId)).toBeUndefined();
  });

  it("pins the job to the execution-agent's mapped worker even when another worker would sort first", async () => {
    jira.seedIssue({
      key: "KAN-1",
      statusName: REQUEST_STATUS,
      projectKey: "KAN",
      assigneeAccountId: "user-1",
      description: description(),
      executionAgentOptionId: "option-a",
    });
    const config = buildConfig({
      workers: [workerPolicy({ workerId: "worker-1" }), workerPolicy({ workerId: "worker-2" })],
      executionAgent: {
        fieldId: "customfield_10001",
        optionWorkerMap: { "option-a": "worker-2" },
      },
    });

    const report = await reconcileCandidates(makeDeps(config), [
      // worker-1 has never been assigned (sorts first by lastAssignedAt), but the pin should win.
      workerAvailability({ workerId: "worker-1", lastAssignedAt: null }),
      workerAvailability({ workerId: "worker-2", lastAssignedAt: "2020-01-01T00:00:00.000Z" }),
    ]);

    expect(report.jobsAssigned).toEqual([{ jobId: expect.any(String), workerId: "worker-2" }]);
  });

  it("waits on an unresolved dependency, then re-evaluates once the dependency resolves", async () => {
    jira.seedIssue(
      {
        key: "KAN-1",
        statusName: REQUEST_STATUS,
        projectKey: "KAN",
        assigneeAccountId: "user-1",
      },
      [{ id: "1", name: "Complete", toStatusName: REVIEW_STATUS }],
    );
    jira.seedIssue({
      key: "KAN-2",
      statusName: REQUEST_STATUS,
      projectKey: "KAN",
      assigneeAccountId: "user-1",
      description: description({ dependencies: ["Depends on KAN-1"] }),
    });
    const config = buildConfig({ workers: [workerPolicy()] });
    const deps = makeDeps(config);

    const first = await reconcileCandidates(deps, [workerAvailability()]);
    expect(first.held.find((h) => h.issueKey === "KAN-2")).toBeUndefined();
    const waitingJobId = getOpenJobForIssue(db, "KAN-2")?.id;
    expect(getOpenJobForIssue(db, "KAN-2")?.state).toBe("waiting");

    // KAN-1 resolves (moves past the active statuses).
    await jira.transitionIssue("KAN-1", "Complete");
    const second = await reconcileCandidates(deps, [workerAvailability()]);

    // The old "waiting" row is cancelled and replaced by a fresh queued/leased job — dependency
    // resolution re-runs the full decision (capability/pin checks included), so the row can't
    // just flip state in place.
    expect(second.jobsCancelled).toContain(waitingJobId);
    const job = getOpenJobForIssue(db, "KAN-2");
    expect(job?.id).not.toBe(waitingJobId);
    expect(job?.state === "queued" || job?.state === "leased").toBe(true);
  });

  it("cancels an open job once its issue leaves requestStatus/planningStatus (approval revoked)", async () => {
    jira.seedIssue(
      {
        key: "KAN-1",
        statusName: REQUEST_STATUS,
        projectKey: "KAN",
        assigneeAccountId: "user-1",
        description: description(),
      },
      [{ id: "1", name: "Revoke", toStatusName: "To Do" }],
    );
    const config = buildConfig();
    const deps = makeDeps(config);

    await reconcileCandidates(deps, []);
    const queuedJobId = getOpenJobForIssue(db, "KAN-1")?.id;
    expect(queuedJobId).toBeDefined();

    await jira.transitionIssue("KAN-1", "Revoke");
    const report = await reconcileCandidates(deps, []);

    expect(report.jobsCancelled).toContain(queuedJobId);
    expect(getOpenJobForIssue(db, "KAN-1")).toBeUndefined();
    expect(getQueuedJobs(db)).toHaveLength(0);
  });
});
