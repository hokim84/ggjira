import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JobEnvelope } from "../src/contracts/envelope.js";
import { getAttempt } from "../src/router/db/attempts.js";
import { listAudit } from "../src/router/db/audit.js";
import { openRouterDb } from "../src/router/db/connection.js";
import { getJob, getOpenJobForIssue, type JobRow } from "../src/router/db/jobs.js";
import {
  insertReportBatch,
  listBatchReportSteps,
  updateReportStep,
} from "../src/router/db/report-steps.js";
import { expireLeases } from "../src/router/leases.js";
import { REQUEST_STATUS } from "./helpers/router-fixtures.js";
import { RouterHarness } from "./helpers/router-harness.js";

function lease(envelope: JobEnvelope) {
  return { attemptId: envelope.attemptId, leaseToken: envelope.leaseToken };
}

describe("admin API", () => {
  let router: RouterHarness;

  beforeEach(() => {
    router = new RouterHarness();
  });

  afterEach(async () => {
    await router.close();
  });

  async function leasedJob(key = "KAN-1") {
    await router.seedQueuedJob(key);
    const worker = await router.connectWorker("worker-1");
    const envelope = (await router.next(worker, `req-${key}`)).json() as JobEnvelope;
    return { worker, envelope };
  }

  async function runningJob(key = "KAN-1") {
    const { worker, envelope } = await leasedJob(key);
    const start = await router.jobCall(worker, envelope.jobId, "start", lease(envelope));
    expect(start.statusCode).toBe(200);
    return { worker, envelope };
  }

  it("refuses every admin route without the admin token", async () => {
    const response = await router.app.inject({ method: "GET", url: "/api/v1/admin/workers" });
    expect(response.statusCode).toBe(401);
    const wrong = await router.app.inject({
      method: "POST",
      url: "/api/v1/admin/reconcile",
      headers: { authorization: "Bearer not-the-admin-token-at-all" },
    });
    expect(wrong.statusCode).toBe(401);
  });

  it("lists declared and paired workers with their online state", async () => {
    await router.connectWorker("worker-1");
    const response = await router.adminCall("GET", "/workers");
    expect(response.statusCode).toBe(200);
    const { workers } = response.json() as {
      workers: Array<{ workerId: string; paired: boolean; online: boolean }>;
    };
    expect(workers).toEqual([
      expect.objectContaining({ workerId: "worker-1", paired: true, online: true }),
      expect.objectContaining({ workerId: "worker-2", paired: false, online: false }),
    ]);
  });

  it("disable blocks new assignments, enable restores them, and both are audited", async () => {
    await router.seedQueuedJob("KAN-1");
    const worker = await router.connectWorker("worker-1");

    expect((await router.adminCall("POST", "/workers/worker-1/disable")).statusCode).toBe(200);
    expect((await router.next(worker, "req-1")).statusCode).toBe(204);

    expect((await router.adminCall("POST", "/workers/worker-1/enable")).statusCode).toBe(200);
    expect((await router.next(worker, "req-2")).statusCode).toBe(200);

    expect(listAudit(router.db, "worker-1").map((entry) => [entry.action, entry.actor])).toEqual([
      ["worker.disabled", "admin:tester"],
      ["worker.enabled", "admin:tester"],
    ]);
  });

  it("revoke puts a never-started lease back in the queue and rejects the token", async () => {
    const { worker, envelope } = await leasedJob();
    expect((await router.adminCall("POST", "/workers/worker-1/revoke")).statusCode).toBe(200);

    expect(getJob(router.db, envelope.jobId)?.state).toBe("queued");
    expect(getAttempt(router.db, envelope.attemptId)?.state).toBe("cancelled");
    expect((await router.next(worker, "req-after")).statusCode).toBe(401);
  });

  it("revoke asks a running job to stop", async () => {
    const { envelope } = await runningJob();
    await router.adminCall("POST", "/workers/worker-1/revoke");

    expect(getJob(router.db, envelope.jobId)?.state).toBe("cancel_requested");
    expect(getAttempt(router.db, envelope.attemptId)?.state).toBe("cancel_requested");
  });

  it("revoking a worker that was never paired is a 404", async () => {
    expect((await router.adminCall("POST", "/workers/worker-2/revoke")).statusCode).toBe(404);
  });

  it("pages the job list newest first and filters by state", async () => {
    for (const key of ["KAN-1", "KAN-2", "KAN-3"]) {
      await router.seedQueuedJob(key);
      router.clock.advance(1000);
    }
    const first = (await router.adminCall("GET", "/jobs?limit=2")).json() as {
      jobs: JobRow[];
      nextCursor?: string;
    };
    expect(first.jobs.map((job) => job.issueKey)).toEqual(["KAN-3", "KAN-2"]);
    expect(first.nextCursor).toBeDefined();

    const second = (
      await router.adminCall("GET", `/jobs?limit=2&cursor=${first.nextCursor}`)
    ).json() as { jobs: JobRow[]; nextCursor?: string };
    expect(second.jobs.map((job) => job.issueKey)).toEqual(["KAN-1"]);
    expect(second.nextCursor).toBeUndefined();

    const running = (await router.adminCall("GET", "/jobs?state=running")).json() as {
      jobs: JobRow[];
    };
    expect(running.jobs).toEqual([]);

    expect((await router.adminCall("GET", "/jobs?state=bogus")).statusCode).toBe(400);
    expect((await router.adminCall("GET", "/jobs?cursor=garbage")).statusCode).toBe(400);
  });

  it("shows a job with its attempts, report steps and audit trail", async () => {
    const { envelope } = await runningJob();
    const detail = (await router.adminCall("GET", `/jobs/${envelope.jobId}`)).json() as {
      job: JobRow;
      attempts: Array<{ id: string }>;
      reportSteps: Array<{ kind: string }>;
    };
    expect(detail.job.state).toBe("running");
    expect(detail.attempts.map((a) => a.id)).toEqual([envelope.attemptId]);
    expect(detail.reportSteps.length).toBeGreaterThan(0);
    expect((await router.adminCall("GET", "/jobs/nope")).statusCode).toBe(404);
  });

  it("cancel closes a queued job and keeps reconcile from re-dispatching that approval", async () => {
    await router.seedQueuedJob("KAN-1");
    const job = getOpenJobForIssue(router.db, "KAN-1") as JobRow;

    const response = await router.adminCall("POST", `/jobs/${job.id}/cancel`);
    expect(response.statusCode).toBe(200);
    expect((response.json() as JobRow).state).toBe("cancelled");

    const report = await router.reconcile();
    expect(getOpenJobForIssue(router.db, "KAN-1")).toBeUndefined();
    expect(report.held).toEqual([expect.objectContaining({ issueKey: "KAN-1", target: "human" })]);

    // A human re-requesting the issue in Jira is a new approval, which runs again.
    await router.jira.transitionIssue("KAN-1", "Revoke");
    await router.jira.transitionIssue("KAN-1", "Request");
    expect((await router.jira.getIssue("KAN-1")).statusName).toBe(REQUEST_STATUS);
    await router.reconcile();
    expect(getOpenJobForIssue(router.db, "KAN-1")?.state).toBe("queued");
  });

  it("cancel refuses recovery_required and points at resolve", async () => {
    const { envelope } = await runningJob();
    router.clock.advance(31_000);
    expireLeases(router.db, router.clock.now());
    expect(getJob(router.db, envelope.jobId)?.state).toBe("recovery_required");

    const cancel = await router.adminCall("POST", `/jobs/${envelope.jobId}/cancel`);
    expect(cancel.statusCode).toBe(409);

    const resolve = await router.adminCall("POST", `/jobs/${envelope.jobId}/resolve`);
    expect(resolve.statusCode).toBe(200);
    expect((resolve.json() as JobRow).state).toBe("cancelled");
    expect(listAudit(router.db, envelope.jobId).map((entry) => entry.action)).toContain(
      "job.resolved",
    );
  });

  it("retry re-queues a recovery_required job as a new attempt after re-checking Jira", async () => {
    const { envelope } = await runningJob();
    // Router's own start step would move the issue to inProgressStatus; retry accepts that too.
    router.clock.advance(31_000);
    expireLeases(router.db, router.clock.now());

    const retry = await router.adminCall("POST", `/jobs/${envelope.jobId}/retry`);
    expect(retry.statusCode).toBe(200);
    expect((retry.json() as JobRow).state).toBe("queued");
    expect(getAttempt(router.db, envelope.attemptId)?.state).toBe("superseded");

    expect((await router.adminCall("POST", `/jobs/${envelope.jobId}/retry`)).statusCode).toBe(409);
    expect((await router.adminCall("POST", "/jobs/nope/retry")).statusCode).toBe(404);
  });

  it("lists blocked report batches and re-queues one without re-running the worker", async () => {
    const { envelope } = await runningJob();
    insertReportBatch(router.db, {
      batchId: "batch-x",
      jobId: envelope.jobId,
      attemptId: envelope.attemptId,
      issueKey: "KAN-1",
      steps: [{ kind: "comment", params: { body: "hello" } }],
      now: router.clock.now(),
    });
    const [step] = listBatchReportSteps(router.db, "batch-x");
    updateReportStep(router.db, step?.id as string, {
      status: "failed",
      error: "403 from Jira",
      now: router.clock.now(),
    });

    const list = (await router.adminCall("GET", "/reports")).json() as {
      batches: Array<{ batchId: string; steps: Array<{ status: string }> }>;
    };
    expect(list.batches).toEqual([
      expect.objectContaining({
        batchId: "batch-x",
        steps: [expect.objectContaining({ status: "failed" })],
      }),
    ]);

    const retry = await router.adminCall("POST", "/reports/batch-x/retry");
    expect(retry.json()).toEqual({ requeued: 1 });
    expect(listBatchReportSteps(router.db, "batch-x")[0]?.status).toBe("pending");
    expect(getJob(router.db, envelope.jobId)?.attemptCount).toBe(1);
    expect((await router.adminCall("POST", "/reports/nope/retry")).statusCode).toBe(404);
  });

  it("reconcile runs a pass on demand", async () => {
    router.jira.seedIssue({
      key: "KAN-9",
      summary: "x",
      statusName: REQUEST_STATUS,
      assigneeAccountId: "user-1",
      description: "h2. Required Capabilities\n* programming",
    });
    const response = await router.adminCall("POST", "/reconcile");
    expect(response.statusCode).toBe(200);
    expect((response.json() as { jobsCreated: string[] }).jobsCreated).toHaveLength(1);
  });

  it("backup writes a consistent copy of the database", async () => {
    await router.seedQueuedJob("KAN-1");
    const response = await router.adminCall("POST", "/backup");
    expect(response.statusCode).toBe(200);
    const { path } = response.json() as { path: string; bytes: number };
    expect(existsSync(path)).toBe(true);

    const copy = openRouterDb(path);
    try {
      expect(getOpenJobForIssue(copy, "KAN-1")?.state).toBe("queued");
    } finally {
      copy.close();
    }
  });

  it("status reports queue, worker, recovery, webhook and report figures", async () => {
    await router.seedQueuedJob("KAN-1");
    await router.connectWorker("worker-2");
    router.clock.advance(4_000);
    const status = (await router.adminCall("GET", "/status")).json() as {
      jobs: Record<string, number>;
      queue: { waitMs: number };
      workers: { online: number; paired: number; declared: number };
      recoveryRequired: number;
      reports: { blocked: number };
    };
    expect(status.jobs).toEqual({ queued: 1 });
    expect(status.queue.waitMs).toBeGreaterThanOrEqual(4_000);
    expect(status.workers).toEqual({ declared: 2, paired: 1, online: 1 });
    expect(status.recoveryRequired).toBe(0);
    expect(status.reports.blocked).toBe(0);
  });
});
