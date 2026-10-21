import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeJiraGateway } from "../src/jira/fake.js";
import { getActiveAttemptForWorker, getAttempt } from "../src/router/db/attempts.js";
import { listAttentionItems } from "../src/router/db/attention.js";
import { openRouterDb } from "../src/router/db/connection.js";
import { createJob, getJob, getOpenJobForIssue, getQueuedJobs } from "../src/router/db/jobs.js";
import { RuleDecisionProvider } from "../src/router/decision.js";
import type { RouterConfig } from "../src/router/config.js";
import {
  assignQueuedJobs,
  reconcileCandidates,
  type SchedulerDeps,
  type WorkerAvailability,
} from "../src/router/scheduler.js";
import {
  type ApprovedIssueOptions,
  reapprove,
  seedApprovedIssue,
} from "./helpers/approved-plan.js";
import {
  buildRouterConfig as buildConfig,
  DONE_STATUS,
  IN_PROGRESS_STATUS,
  issueDescription as description,
  makeClock,
  makeIdGenerator,
  REQUEST_STATUS,
  singlePlan,
  TODO_STATUS,
  testWorkspace,
  WORKFLOW_TRANSITIONS,
  workerPolicy,
} from "./helpers/router-fixtures.js";

function workerAvailability(overrides: Partial<WorkerAvailability> = {}): WorkerAvailability {
  return {
    workerId: "worker-1",
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

  /** An issue whose plan a human approved (ADR 0044); its implementation is the next job. */
  function approved(key: string, opts: ApprovedIssueOptions = {}): Promise<void> {
    return seedApprovedIssue(
      { db, jira, workspace: testWorkspace, now: "2026-01-01T00:00:00.000Z" },
      key,
      opts,
    );
  }

  it("creates a queued implementation job for an approved plan", async () => {
    await approved("KAN-1");
    const config = buildConfig();

    const report = await reconcileCandidates(makeDeps(config), []);

    expect(report.jobsCreated).toHaveLength(1);
    const job = getOpenJobForIssue(db, "KAN-1");
    expect(job?.state).toBe("queued");
    expect(job?.kind).toBe("implementation");
  });

  it("does not create a second job for the same issue on a repeated reconcile", async () => {
    await approved("KAN-1");
    const config = buildConfig();
    const deps = makeDeps(config);

    await reconcileCandidates(deps, []);
    const second = await reconcileCandidates(deps, []);

    expect(second.jobsCreated).toHaveLength(0);
    const job = getOpenJobForIssue(db, "KAN-1");
    expect(job?.state).toBe("queued");
  });

  it("dispatches a planning job for an issue in the request status", async () => {
    jira.seedIssue({
      key: "KAN-1",
      statusName: REQUEST_STATUS,
      projectKey: "KAN",
      assigneeAccountId: "user-1",
      description: description(),
    });
    const config = buildConfig();

    await reconcileCandidates(makeDeps(config), []);

    expect(getOpenJobForIssue(db, "KAN-1")?.kind).toBe("planning");
  });

  it("never picks up an issue a person moved to in progress", async () => {
    jira.seedIssue({
      key: "KAN-1",
      statusName: IN_PROGRESS_STATUS,
      projectKey: "KAN",
      assigneeAccountId: "user-1",
      description: description(),
    });

    const report = await reconcileCandidates(makeDeps(buildConfig()), []);

    expect(report.jobsCreated).toEqual([]);
    expect(getOpenJobForIssue(db, "KAN-1")).toBeUndefined();
  });

  it("holds for a human and processes other candidates when metadata is invalid or assignee is missing", async () => {
    await approved("KAN-1", { assigneeAccountId: null }); // no human assignee
    await approved("KAN-2");
    const config = buildConfig();

    const report = await reconcileCandidates(makeDeps(config), []);

    expect(report.held).toEqual([
      { issueKey: "KAN-1", target: "human", reason: expect.any(String) },
    ]);
    expect(getOpenJobForIssue(db, "KAN-1")).toBeUndefined();
    expect(getOpenJobForIssue(db, "KAN-2")?.state).toBe("queued");
  });

  it("tells the human once when a request has no assignee, and runs it once assigned", async () => {
    jira.seedIssue({
      key: "KAN-1",
      statusName: REQUEST_STATUS,
      projectKey: "KAN",
      assigneeAccountId: null,
      description: description(),
    });
    const deps = makeDeps(buildConfig());
    const unassigned = () => listAttentionItems(db, { issueKey: "KAN-1", kind: "unassigned" });

    // A comment that fails is tried again on the next pass.
    jira.failNextComment("KAN-1");
    const failed = await reconcileCandidates(deps, []);
    expect(failed.held[0]?.reason).toMatch(/no human assignee; telling it on the issue failed/);
    expect(unassigned()).toEqual([]);

    await reconcileCandidates(deps, []);
    await reconcileCandidates(deps, []);
    const comments = jira.comments.filter((comment) => comment.key === "KAN-1");
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toMatch(
      /이슈에 담당자가 없습니다[\s\S]*다음: 이슈에 책임자를 담당자로 지정하세요/,
    );
    expect(unassigned()).toMatchObject([{ status: "open", severity: "immediate" }]);
    expect(getOpenJobForIssue(db, "KAN-1")).toBeUndefined();

    await jira.assignIssue("KAN-1", "user-1");
    await reconcileCandidates(deps, []);
    expect(getOpenJobForIssue(db, "KAN-1")?.kind).toBe("planning");
    expect(unassigned()).toMatchObject([{ status: "resolved" }]);
  });

  it("assigns a queued job to the only matching available worker", async () => {
    await approved("KAN-1");
    const config = buildConfig({ workers: [workerPolicy()] });

    const report = await reconcileCandidates(makeDeps(config), [workerAvailability()]);

    expect(report.jobsAssigned).toEqual([{ jobId: expect.any(String), workerId: "worker-1" }]);
    expect(getOpenJobForIssue(db, "KAN-1")?.state).toBe("leased");
    expect(getActiveAttemptForWorker(db, "worker-1")).toBeDefined();
  });

  it.each(["planning", "implementation", "quality_review"] as const)(
    "assigns %s without a worker capability declaration",
    (kind) => {
      createJob(db, {
        id: "universal",
        issueKey: "KAN-1",
        workspaceId: "ws1",
        repositoryId: "repo1",
        kind,
        approvalId: "human-entry",
        now: "2026-10-21",
      });
      const config = buildConfig({
        workers: [workerPolicy()],
      });

      const assignments = assignQueuedJobs(makeDeps(config), [workerAvailability()]);

      expect(assignments).toHaveLength(1);
      expect(getOpenJobForIssue(db, "KAN-1")?.state).toBe("leased");
    },
  );

  it("leaves the job queued when the available worker isn't allowed the job's repository", async () => {
    await approved("KAN-1");
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
    await approved("KAN-1");
    await approved("KAN-2");
    const config = buildConfig({ workers: [workerPolicy()] });

    const report = await reconcileCandidates(makeDeps(config), [workerAvailability()]);

    expect(report.jobsAssigned).toHaveLength(1);
    const states = [getOpenJobForIssue(db, "KAN-1")?.state, getOpenJobForIssue(db, "KAN-2")?.state];
    expect(states.filter((s) => s === "leased")).toHaveLength(1);
    expect(states.filter((s) => s === "queued")).toHaveLength(1);
  });

  it("grants exactly one lease when two workers are available for one job", async () => {
    await approved("KAN-1");
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
    await approved("KAN-1", { fields: { executionAgentOptionId: "option-a" } });
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
    // KAN-1 is a person's issue in progress; KAN-2's approved plan depends on it.
    jira.seedIssue(
      { key: "KAN-1", statusName: IN_PROGRESS_STATUS, projectKey: "KAN", assigneeAccountId: "u" },
      WORKFLOW_TRANSITIONS,
    );
    await approved("KAN-2", { plan: singlePlan({ dependencies: ["Depends on KAN-1"] }) });
    const config = buildConfig({ workers: [workerPolicy()] });
    const deps = makeDeps(config);

    const first = await reconcileCandidates(deps, [workerAvailability()]);
    expect(first.held.find((h) => h.issueKey === "KAN-2")).toBeUndefined();
    const waitingJobId = getOpenJobForIssue(db, "KAN-2")?.id;
    expect(getOpenJobForIssue(db, "KAN-2")?.state).toBe("waiting");

    // KAN-1 is done (ADR 0044: reaching review alone would not be).
    await jira.transitionIssueToStatus("KAN-1", DONE_STATUS);
    const second = await reconcileCandidates(deps, [workerAvailability()]);

    // The old "waiting" row is cancelled and replaced by a fresh queued/leased job — dependency
    // resolution re-runs the full decision (pin checks included), so the row can't
    // just flip state in place.
    expect(second.jobsCancelled).toContain(waitingJobId);
    const job = getOpenJobForIssue(db, "KAN-2");
    expect(job?.id).not.toBe(waitingJobId);
    expect(job?.state === "queued" || job?.state === "leased").toBe(true);
  });

  it("cancels an open job once its issue leaves in progress (approval withdrawn)", async () => {
    await approved("KAN-1");
    const config = buildConfig();
    const deps = makeDeps(config);

    await reconcileCandidates(deps, []);
    const queuedJobId = getOpenJobForIssue(db, "KAN-1")?.id;
    expect(queuedJobId).toBeDefined();

    await jira.transitionIssueToStatus("KAN-1", TODO_STATUS);
    const report = await reconcileCandidates(deps, []);

    expect(report.jobsCancelled).toContain(queuedJobId);
    expect(getOpenJobForIssue(db, "KAN-1")).toBeUndefined();
    expect(getQueuedJobs(db)).toHaveLength(0);
  });

  it("cancels a leased job together with its attempt when the issue's inputs change, freeing the worker", async () => {
    await approved("KAN-1");
    const config = buildConfig({ workers: [workerPolicy()] });
    const deps = makeDeps(config);

    await reconcileCandidates(deps, [workerAvailability()]);
    const leased = getOpenJobForIssue(db, "KAN-1");
    expect(leased?.state).toBe("leased");
    const attemptId = leased?.currentAttemptId ?? "";

    // Same approval (still in progress under the plan), but the request was edited.
    await jira.updateIssueDescription("KAN-1", description("Make it work differently."));
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
    await approved("KAN-1");
    const deps = makeDeps(buildConfig());
    await reconcileCandidates(deps, []);
    const first = getOpenJobForIssue(db, "KAN-1");

    // A title edit is part of what was approved.
    jira.seedIssue(
      { ...(await jira.getIssue("KAN-1")), summary: "Do the thing differently" },
      await jira.getTransitions("KAN-1"),
    );
    const edited = await reconcileCandidates(deps, []);
    expect(edited.jobsCancelled).toContain(first?.id);
    expect(getOpenJobForIssue(db, "KAN-1")).toBeUndefined();

    await reapprove(jira, testWorkspace, "KAN-1", db);
    const reapproved = await reconcileCandidates(deps, []);
    expect(reapproved.jobsCreated).toHaveLength(1);
    expect(getOpenJobForIssue(db, "KAN-1")?.approvalId).not.toBe(first?.approvalId);
  });

  it("cancels and holds a job stamped by the v1 hash rules: it needs a new approval (ADR 0047)", async () => {
    await approved("KAN-1");
    const deps = makeDeps(buildConfig());
    await reconcileCandidates(deps, []);
    const job = getOpenJobForIssue(db, "KAN-1");
    db.prepare("UPDATE jobs SET input_hash = ? WHERE id = ?").run("0".repeat(64), job?.id);

    const report = await reconcileCandidates(deps, []);

    expect(report.jobsCancelled).toContain(job?.id);
    expect(getJob(db, job?.id as string)?.state).toBe("cancelled");
    expect(getOpenJobForIssue(db, "KAN-1")).toBeUndefined();
  });

  it("asks a running job to stop but never closes it on a later pass without a confirmed stop", async () => {
    await approved("KAN-1");
    const config = buildConfig({ workers: [workerPolicy()] });
    const deps = makeDeps(config);
    await reconcileCandidates(deps, [workerAvailability()]);
    const job = getOpenJobForIssue(db, "KAN-1");
    // Simulate the worker's `start` (normally WorkerService.start).
    db.prepare("UPDATE jobs SET state = 'running' WHERE id = ?").run(job?.id);
    db.prepare("UPDATE attempts SET state = 'running' WHERE id = ?").run(job?.currentAttemptId);

    await jira.transitionIssueToStatus("KAN-1", TODO_STATUS);
    const first = await reconcileCandidates(deps, []);
    const second = await reconcileCandidates(deps, []);

    expect(first.jobsCancelRequested).toEqual([job?.id]);
    expect(second.jobsCancelled).toEqual([]);
    expect(getJob(db, job?.id ?? "")?.state).toBe("cancel_requested");
    expect(getAttempt(db, job?.currentAttemptId ?? "")?.state).toBe("cancel_requested");
  });
});
