import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeJiraGateway } from "../src/jira/fake.js";
import { getActiveAttemptForWorker, getAttempt } from "../src/router/db/attempts.js";
import { openRouterDb } from "../src/router/db/connection.js";
import { readIssueRequirements } from "../src/issue/requirements.js";
import { computeLegacyInputHash } from "../src/router/approval.js";
import { getJob, getOpenJobForIssue, getQueuedJobs } from "../src/router/db/jobs.js";
import { RuleDecisionProvider } from "../src/router/decision.js";
import type { RouterConfig } from "../src/router/config.js";
import {
  reconcileCandidates,
  type SchedulerDeps,
  type WorkerAvailability,
} from "../src/router/scheduler.js";
import {
  buildRouterConfig as buildConfig,
  issueDescription as description,
  makeClock,
  makeIdGenerator,
  PLANNING_STATUS,
  REQUEST_STATUS,
  REVIEW_STATUS,
  workerPolicy,
} from "./helpers/router-fixtures.js";

function workerAvailability(overrides: Partial<WorkerAvailability> = {}): WorkerAvailability {
  return {
    workerId: "worker-1",
    capabilities: ["programming"],
    repositoryIds: ["repo1"],
    lastAssignedAt: null,
    ...overrides,
  };
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

  it("cancels a leased job together with its attempt when the issue's inputs change, freeing the worker", async () => {
    jira.seedIssue({
      key: "KAN-1",
      statusName: REQUEST_STATUS,
      projectKey: "KAN",
      assigneeAccountId: "user-1",
      description: description(),
    });
    const config = buildConfig({ workers: [workerPolicy()] });
    const deps = makeDeps(config);

    await reconcileCandidates(deps, [workerAvailability()]);
    const leased = getOpenJobForIssue(db, "KAN-1");
    expect(leased?.state).toBe("leased");
    const attemptId = leased?.currentAttemptId ?? "";

    // Same approval (still in requestStatus), but the required capabilities changed.
    jira.seedIssue({
      key: "KAN-1",
      statusName: REQUEST_STATUS,
      projectKey: "KAN",
      assigneeAccountId: "user-1",
      description: description({ capabilities: ["programming", "testing"] }),
    });
    const report = await reconcileCandidates(deps, []);

    expect(report.jobsCancelled).toContain(leased?.id);
    expect(getAttempt(db, attemptId)?.state).toBe("cancelled");
    expect(getActiveAttemptForWorker(db, "worker-1")).toBeUndefined();
    // ADR 0035: the edited request is not re-run under the approval of the original one.
    expect(getOpenJobForIssue(db, "KAN-1")).toBeUndefined();
    expect(report.held).toEqual([
      expect.objectContaining({ issueKey: "KAN-1", reason: expect.stringContaining("edited") }),
    ]);
    const again = await reconcileCandidates(deps, []);
    expect(again.jobsCreated).toEqual([]);
  });

  it("re-runs an edited request only after it is approved again (ADR 0035)", async () => {
    jira.seedIssue(
      {
        key: "KAN-1",
        statusName: REQUEST_STATUS,
        projectKey: "KAN",
        assigneeAccountId: "user-1",
        description: description(),
      },
      [
        { id: "1", name: "Revoke", toStatusName: "To Do" },
        { id: "2", name: "Request", toStatusName: REQUEST_STATUS },
      ],
    );
    const deps = makeDeps(buildConfig());
    await reconcileCandidates(deps, []);
    const first = getOpenJobForIssue(db, "KAN-1");

    // A title edit alone was invisible to the v1 hash.
    jira.seedIssue(
      { ...(await jira.getIssue("KAN-1")), summary: "Do the thing differently" },
      await jira.getTransitions("KAN-1"),
    );
    const edited = await reconcileCandidates(deps, []);
    expect(edited.jobsCancelled).toContain(first?.id);
    expect(getOpenJobForIssue(db, "KAN-1")).toBeUndefined();

    await jira.transitionIssue("KAN-1", "Revoke");
    await jira.transitionIssue("KAN-1", "Request");
    const reapproved = await reconcileCandidates(deps, []);
    expect(reapproved.jobsCreated).toHaveLength(1);
    expect(getOpenJobForIssue(db, "KAN-1")?.approvalId).not.toBe(first?.approvalId);
  });

  it("keeps judging a job stamped with a v1 hash by the v1 rules until it closes", async () => {
    jira.seedIssue({
      key: "KAN-1",
      statusName: REQUEST_STATUS,
      projectKey: "KAN",
      assigneeAccountId: "user-1",
      description: description(),
    });
    const deps = makeDeps(buildConfig());
    await reconcileCandidates(deps, []);
    const job = getOpenJobForIssue(db, "KAN-1");
    const issue = await jira.getIssue("KAN-1");
    const legacy = computeLegacyInputHash(readIssueRequirements(issue), null);
    db.prepare("UPDATE jobs SET input_hash = ? WHERE id = ?").run(legacy, job?.id);

    // Free text outside the GGJIRA sections: not part of v1, so the legacy job stands.
    jira.seedIssue({ ...issue, description: `Some background first.\n\n${description()}` });
    const freeText = await reconcileCandidates(deps, []);
    expect(freeText.jobsCancelled).toEqual([]);
    expect(getJob(db, job?.id as string)?.inputHash).toBe(legacy);

    // A capability edit is part of v1: cancelled and held like any other change.
    jira.seedIssue({
      ...issue,
      description: description({ capabilities: ["programming", "testing"] }),
    });
    const capability = await reconcileCandidates(deps, []);
    expect(capability.jobsCancelled).toContain(job?.id);
    expect(getOpenJobForIssue(db, "KAN-1")).toBeUndefined();
  });

  it("asks a running job to stop but never closes it on a later pass without a confirmed stop", async () => {
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
    const config = buildConfig({ workers: [workerPolicy()] });
    const deps = makeDeps(config);
    await reconcileCandidates(deps, [workerAvailability()]);
    const job = getOpenJobForIssue(db, "KAN-1");
    // Simulate the worker's `start` (normally WorkerService.start).
    db.prepare("UPDATE jobs SET state = 'running' WHERE id = ?").run(job?.id);
    db.prepare("UPDATE attempts SET state = 'running' WHERE id = ?").run(job?.currentAttemptId);

    await jira.transitionIssue("KAN-1", "Revoke");
    const first = await reconcileCandidates(deps, []);
    const second = await reconcileCandidates(deps, []);

    expect(first.jobsCancelRequested).toEqual([job?.id]);
    expect(second.jobsCancelled).toEqual([]);
    expect(getJob(db, job?.id ?? "")?.state).toBe("cancel_requested");
    expect(getAttempt(db, job?.currentAttemptId ?? "")?.state).toBe("cancel_requested");
  });
});
