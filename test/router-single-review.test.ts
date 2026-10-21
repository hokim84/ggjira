import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JobEnvelope } from "../src/contracts/envelope.js";
import { processReportJournal } from "../src/router/report-processor.js";
import { getOpenJobForIssue } from "../src/router/db/jobs.js";
import { latestPlanningRequest, syncPlanningRequest } from "../src/router/planning-requests.js";
import { RouterHarness, type RegisteredWorker } from "./helpers/router-harness.js";
import {
  REQUEST_STATUS,
  IN_PROGRESS_STATUS,
  WORKFLOW_TRANSITIONS,
  singlePlan,
} from "./helpers/router-fixtures.js";

describe("single AI review workflow", () => {
  let router: RouterHarness;
  let worker: RegisteredWorker;
  let counter = 0;
  beforeEach(async () => {
    router = new RouterHarness();
    worker = await router.connectWorker("worker-1");
    router.jira.seedIssue(
      {
        key: "KAN-1",
        summary: "Storage",
        description: "Choose storage",
        statusName: REQUEST_STATUS,
        assigneeAccountId: "user-1",
      },
      WORKFLOW_TRANSITIONS,
    );
  });
  afterEach(async () => {
    await router.close();
  });
  const question = {
    needsDecision: true,
    summary: "Choose storage",
    decision: {
      question: "SQL or NoSQL?",
      options: [
        { id: "sql", title: "SQL" },
        { id: "nosql", title: "NoSQL" },
      ],
    },
  };
  async function process() {
    const report = await processReportJournal({
      db: router.db,
      jira: router.jira,
      now: router.clock.now,
    });
    expect(report.blocked).toEqual([]);
  }
  async function start() {
    await router.reconcile();
    const response = await router.next(worker, `single-${++counter}`);
    expect(response.statusCode).toBe(200);
    const job = response.json() as JobEnvelope;
    const responseStart = await router.jobCall(worker, job.jobId, "start", {
      attemptId: job.attemptId,
      leaseToken: job.leaseToken,
    });
    expect(responseStart.json()).toMatchObject({ granted: true });
    return job;
  }
  async function finish(job: JobEnvelope, plan = singlePlan(), status = "planned") {
    const response = await router.post(
      `/api/v1/jobs/${job.jobId}/result`,
      {
        protocolVersion: 2,
        jobId: job.jobId,
        attemptId: job.attemptId,
        resultId: `result-${job.attemptId}`,
        status,
        summary: "Result",
        ...(status === "failed" ? { failureReason: "failed" } : { plan }),
      },
      worker.token,
    );
    expect(response.statusCode).toBe(200);
    await process();
  }
  async function edit(description: string) {
    router.jira.seedIssue(
      { ...(await router.jira.getIssue("KAN-1")), description },
      WORKFLOW_TRANSITIONS,
    );
  }
  it("stays in AI review after planning, ignores its own description writes, and runs only after a manual approval", async () => {
    const job = await start();
    await finish(job);
    expect((await router.jira.getIssue("KAN-1")).statusName).toBe(REQUEST_STATUS);
    expect(latestPlanningRequest(router.db, "KAN-1")?.ready_history).not.toBeNull();
    expect((await router.reconcile()).jobsCreated).toEqual([]);
    await router.jira.transitionIssueToStatus("KAN-1", IN_PROGRESS_STATUS);
    const next = await start();
    expect(next.kind).toBe("implementation");
  });
  it("accepts only the assignee's valid number and consumes it once across restart", async () => {
    await finish(await start(), question, "needs_decision");
    const original = latestPlanningRequest(router.db, "KAN-1")?.id;
    router.jira.seedComment("KAN-1", { body: "2", authorAccountId: "other" });
    router.jira.seedComment("KAN-1", { body: "3", authorAccountId: "user-1" });
    router.jira.seedComment("KAN-1", { body: "Let's discuss", authorAccountId: "user-1" });
    await router.reconcile();
    expect(latestPlanningRequest(router.db, "KAN-1")?.id).toBe(original);
    router.jira.seedComment("KAN-1", { body: "2번", authorAccountId: "user-1" });
    const next = await start();
    expect(next.planningContext?.humanDecision).toMatchObject({ raw: "2번", optionId: "nosql" });
    await finish(next);
    await router.restart();
    expect((await router.reconcile()).jobsCreated).toEqual([]);
  });
  it("ignores Router comments even when the Jira account is shared", async () => {
    router.jira.seedIssue(
      { ...(await router.jira.getIssue("KAN-1")), assigneeAccountId: "self-account-id" },
      WORKFLOW_TRANSITIONS,
    );
    await finish(await start(), question, "needs_decision");
    expect((await router.reconcile()).jobsCreated).toEqual([]);
    router.jira.seedComment("KAN-1", { body: "1", authorAccountId: "self-account-id" });
    expect((await start()).planningContext?.humanDecision?.optionId).toBe("sql");
  });
  it("replans edits, coalesces changes while waiting for cancellation, and rejects a late result", async () => {
    const old = await start();
    await edit("New requirements");
    await router.reconcile();
    expect(getOpenJobForIssue(router.db, "KAN-1")?.state).toBe("cancel_requested");
    await edit("Latest requirements");
    expect((await router.reconcile()).jobsCreated).toEqual([]);
    await finish(old);
    const next = await start();
    expect(next.kind).toBe("planning");
    expect(next.issueSnapshot.description).toBe("Latest requirements");
    expect(router.db.prepare("SELECT * FROM plan_reviews").all()).toEqual([]);
  });
  it("retries a failed plan only on a fresh assignee retry comment", async () => {
    const first = await start();
    router.jira.seedComment("KAN-1", {
      body: "재시도",
      authorAccountId: "user-1",
      created: "2000-01-01T00:00:00Z",
    });
    await finish(first, singlePlan(), "failed");
    expect((await router.reconcile()).jobsCreated).toEqual([]);
    router.jira.seedComment("KAN-1", { body: "재시도", authorAccountId: "other" });
    expect((await router.reconcile()).jobsCreated).toEqual([]);
    router.jira.seedComment("KAN-1", { body: "재시도", authorAccountId: "user-1" });
    const next = await start();
    expect(next.kind).toBe("planning");
    expect(next.approvalId).not.toBe(first.approvalId);
  });
  it("does not approve a plan whose reports were not applied before the manual move", async () => {
    const job = await start();
    await router.post(
      `/api/v1/jobs/${job.jobId}/result`,
      {
        protocolVersion: 2,
        jobId: job.jobId,
        attemptId: job.attemptId,
        resultId: `result-${job.attemptId}`,
        status: "planned",
        summary: "Done",
        plan: singlePlan(),
      },
      worker.token,
    );
    await router.jira.transitionIssueToStatus("KAN-1", IN_PROGRESS_STATUS);
    await router.reconcile();
    await process();
    await router.restart();
    expect((await router.reconcile()).jobsCreated).toEqual([]);
    expect(router.db.prepare("SELECT * FROM plan_deployments").all()).toEqual([]);
  });
  it("refuses approval after a requirement edit even without an intervening reconcile", async () => {
    await finish(await start());
    await edit("Changed after the plan was ready");
    await router.jira.transitionIssueToStatus("KAN-1", IN_PROGRESS_STATUS);
    expect((await router.reconcile()).jobsCreated).toEqual([]);
    expect(router.db.prepare("SELECT * FROM plan_deployments").all()).toEqual([]);
  });

  it("deduplicates concurrent discoveries of the same edit", async () => {
    const issue = await router.jira.getIssue("KAN-1");
    const requests = await Promise.all(
      Array.from({ length: 3 }, () =>
        syncPlanningRequest(router.db, router.jira, issue, REQUEST_STATUS),
      ),
    );
    expect(new Set(requests.map((request) => request?.id)).size).toBe(1);
    expect(router.db.prepare("SELECT COUNT(*) AS n FROM planning_requests").get()).toEqual({
      n: 1,
    });
  });

  it("holds an upgrade baseline until the person delegates again", async () => {
    router.db
      .prepare("INSERT INTO planning_baselines VALUES (?,?)")
      .run("KAN-1", "2000-01-01T00:00:00Z");
    expect((await router.reconcile()).jobsCreated).toEqual([]);
    expect((await router.admin.issueView("KAN-1")).delegation).toMatchObject({
      stage: "plan_held",
      heldBy: "migration:single-review",
    });
    await router.jira.transitionIssueToStatus("KAN-1", IN_PROGRESS_STATUS);
    await router.jira.transitionIssueToStatus("KAN-1", REQUEST_STATUS);
    expect((await start()).kind).toBe("planning");
  });

  it("does not treat preserving a started human subtask as a blocked plan report", async () => {
    router.jira.seedIssue(
      {
        key: "KAN-2",
        summary: "Human task",
        parentKey: "KAN-1",
        statusName: IN_PROGRESS_STATUS,
        assigneeAccountId: "user-1",
      },
      WORKFLOW_TRANSITIONS,
    );
    await finish(await start());
    expect(latestPlanningRequest(router.db, "KAN-1")?.ready_history).toBeTruthy();
    expect((await router.jira.getIssue("KAN-2")).statusName).toBe(IN_PROGRESS_STATUS);
  });
});
