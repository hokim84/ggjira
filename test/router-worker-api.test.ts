import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JobEnvelope } from "../src/contracts/envelope.js";
import { PROTOCOL_VERSION } from "../src/contracts/protocol.js";
import { upsertApproval } from "../src/router/db/approvals.js";
import { getActiveAttemptForWorker, getAttempt } from "../src/router/db/attempts.js";
import { getJob, getOpenJobForIssue } from "../src/router/db/jobs.js";
import { getResult } from "../src/router/db/results.js";
import { revokeWorker } from "../src/router/db/workers.js";
import { ADMIN_TOKEN, RouterHarness, type RegisteredWorker } from "./helpers/router-harness.js";

function lease(envelope: JobEnvelope) {
  return { attemptId: envelope.attemptId, leaseToken: envelope.leaseToken };
}

function result(envelope: JobEnvelope, overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    jobId: envelope.jobId,
    attemptId: envelope.attemptId,
    resultId: `result-${envelope.attemptId}`,
    status: "succeeded",
    summary: "done",
    ...overrides,
  };
}

describe("worker API", () => {
  let router: RouterHarness;

  beforeEach(() => {
    router = new RouterHarness();
  });

  afterEach(async () => {
    await router.close();
  });

  async function reserve(worker: RegisteredWorker, requestId = "req-1"): Promise<JobEnvelope> {
    const response = await router.next(worker, requestId);
    expect(response.statusCode).toBe(200);
    return response.json() as JobEnvelope;
  }

  it("runs the full register → session → next → start → heartbeat → authorize → result path", async () => {
    await router.seedQueuedJob();
    const worker = await router.connectWorker("worker-1");

    const envelope = await reserve(worker);
    expect(envelope).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      repositoryId: "repo1",
      kind: "implementation",
      providerId: "default",
      issueSnapshot: { key: "KAN-1", summary: "Implement KAN-1" },
    });

    const start = await router.jobCall(worker, envelope.jobId, "start", lease(envelope));
    expect(start.json()).toMatchObject({ granted: true });
    expect(getJob(router.db, envelope.jobId)?.state).toBe("running");

    const heartbeat = await router.jobCall(worker, envelope.jobId, "heartbeat", lease(envelope));
    expect(heartbeat.json()).toMatchObject({ cancel: false });

    const authorize = await router.jobCall(worker, envelope.jobId, "authorize", lease(envelope), {
      stage: "commit",
    });
    expect(authorize.json()).toEqual({ authorized: true });

    const submitted = await router.post(
      `/api/v1/jobs/${envelope.jobId}/result`,
      result(envelope),
      worker.token,
    );
    expect(submitted.json()).toEqual({ accepted: true, applied: true });
    expect(getJob(router.db, envelope.jobId)?.state).toBe("succeeded");
    expect(getAttempt(router.db, envelope.attemptId)?.state).toBe("succeeded");
    expect(getActiveAttemptForWorker(router.db, "worker-1")).toBeUndefined();
  });

  it("answers 204 when nothing is queued", async () => {
    const worker = await router.connectWorker("worker-1");
    const response = await router.next(worker, "req-1");
    expect(response.statusCode).toBe(204);
  });

  it("returns the same reservation when jobs/next is resent with the same requestId (lost response)", async () => {
    await router.seedQueuedJob("KAN-1");
    await router.seedQueuedJob("KAN-2");
    const worker = await router.connectWorker("worker-1");

    const first = await reserve(worker, "req-1");
    const replay = await reserve(worker, "req-1");

    expect(replay.attemptId).toBe(first.attemptId);
    expect(replay.leaseToken).toBe(first.leaseToken);
    // The second queued job was not leased to anyone.
    expect(getOpenJobForIssue(router.db, "KAN-2")?.state).toBe("queued");
  });

  it("grants start to exactly one worker when two workers poll for one job at the same time", async () => {
    await router.seedQueuedJob();
    const [a, b] = await Promise.all([
      router.connectWorker("worker-1"),
      router.connectWorker("worker-2"),
    ]);

    const [nextA, nextB] = await Promise.all([router.next(a, "req-a"), router.next(b, "req-b")]);
    const served = [nextA, nextB].filter((response) => response.statusCode === 200);
    expect(served).toHaveLength(1);
    expect([nextA, nextB].filter((response) => response.statusCode === 204)).toHaveLength(1);

    const envelope = served[0]?.json() as JobEnvelope;
    const owner = nextA.statusCode === 200 ? a : b;
    const other = owner === a ? b : a;

    // The other worker cannot start someone else's attempt, even with the leaked lease.
    const stolen = await router.jobCall(other, envelope.jobId, "start", lease(envelope));
    expect(stolen.statusCode).toBe(403);

    const start = await router.jobCall(owner, envelope.jobId, "start", lease(envelope));
    expect(start.json()).toMatchObject({ granted: true });
  });

  it("re-grants a resent start (lost response) without creating another attempt", async () => {
    await router.seedQueuedJob();
    const worker = await router.connectWorker("worker-1");
    const envelope = await reserve(worker);

    await router.jobCall(worker, envelope.jobId, "start", lease(envelope));
    const resent = await router.jobCall(worker, envelope.jobId, "start", lease(envelope));

    expect(resent.json()).toMatchObject({ granted: true });
    const job = getJob(router.db, envelope.jobId);
    expect(job?.attemptCount).toBe(1);
    expect(job?.currentAttemptId).toBe(envelope.attemptId);
  });

  it("refuses start with 409 once a reconcile cancelled the lease (revoke + re-approve)", async () => {
    await router.seedQueuedJob();
    const worker = await router.connectWorker("worker-1");
    const envelope = await reserve(worker);

    // Revoke and re-approve: a new changelog entry into requestStatus → new approval id.
    await router.jira.transitionIssue("KAN-1", "Revoke");
    await router.jira.transitionIssue("KAN-1", "Request");
    await router.reconcile();

    const start = await router.jobCall(worker, envelope.jobId, "start", lease(envelope));
    expect(start.statusCode).toBe(409);
    expect(start.json()).toMatchObject({ error: "attempt_closed" });
    // The fresh approval got its own job, which the worker can now reserve instead.
    const fresh = await reserve(worker, "req-2");
    expect(fresh.jobId).not.toBe(envelope.jobId);
  });

  it("denies start when the approval moved on but no reconcile has cancelled the lease yet", async () => {
    await router.seedQueuedJob();
    const worker = await router.connectWorker("worker-1");
    const envelope = await reserve(worker);
    upsertApproval(router.db, {
      issueKey: "KAN-1",
      approvalId: "a-newer-approval",
      inputHash: envelope.inputHash,
      inputSnapshot: {},
      now: router.clock.now(),
    });

    const start = await router.jobCall(worker, envelope.jobId, "start", lease(envelope));

    expect(start.json()).toMatchObject({ granted: false });
    expect(getAttempt(router.db, envelope.attemptId)?.state).toBe("cancelled");
    expect(getJob(router.db, envelope.jobId)?.state).toBe("cancelled");
    expect(getActiveAttemptForWorker(router.db, "worker-1")).toBeUndefined();
  });

  it("tells a running worker to cancel through the job heartbeat when approval is revoked, then closes on its result", async () => {
    await router.seedQueuedJob();
    const worker = await router.connectWorker("worker-1");
    const envelope = await reserve(worker);
    await router.jobCall(worker, envelope.jobId, "start", lease(envelope));

    await router.jira.transitionIssue("KAN-1", "Revoke");
    const report = await router.reconcile();
    expect(report.jobsCancelRequested).toEqual([envelope.jobId]);

    const heartbeat = await router.jobCall(worker, envelope.jobId, "heartbeat", lease(envelope));
    expect(heartbeat.json()).toMatchObject({ cancel: true });
    const general = await router.heartbeat(worker.workerId, worker.token, worker.sessionId);
    expect(general.json()).toEqual({ cancelAttemptIds: [envelope.attemptId] });
    const authorize = await router.jobCall(worker, envelope.jobId, "authorize", lease(envelope), {
      stage: "commit",
    });
    expect(authorize.json()).toMatchObject({ authorized: false });

    await router.post(
      `/api/v1/jobs/${envelope.jobId}/result`,
      result(envelope, { status: "cancelled", summary: "stopped" }),
      worker.token,
    );
    expect(getJob(router.db, envelope.jobId)?.state).toBe("cancelled");
  });

  it("treats an identical result resend as success and a different payload under the same resultId as 409", async () => {
    await router.seedQueuedJob();
    const worker = await router.connectWorker("worker-1");
    const envelope = await reserve(worker);
    await router.jobCall(worker, envelope.jobId, "start", lease(envelope));

    const url = `/api/v1/jobs/${envelope.jobId}/result`;
    const first = await router.post(url, result(envelope), worker.token);
    const resend = await router.post(url, result(envelope), worker.token);
    const conflict = await router.post(
      url,
      result(envelope, { status: "failed", summary: "different" }),
      worker.token,
    );

    expect(first.json()).toEqual({ accepted: true, applied: true });
    expect(resend.statusCode).toBe(200);
    expect(resend.json()).toEqual({ accepted: true, applied: true });
    expect(conflict.statusCode).toBe(409);
    expect(getJob(router.db, envelope.jobId)?.state).toBe("succeeded");
  });

  it("maps a timed-out failure to timed_out", async () => {
    await router.seedQueuedJob();
    const worker = await router.connectWorker("worker-1");
    const envelope = await reserve(worker);
    await router.jobCall(worker, envelope.jobId, "start", lease(envelope));

    await router.post(
      `/api/v1/jobs/${envelope.jobId}/result`,
      result(envelope, { status: "failed", summary: "slow", timedOut: true }),
      worker.token,
    );
    expect(getJob(router.db, envelope.jobId)?.state).toBe("timed_out");
  });

  it("keeps a late result (lease already expired) only as an audit record", async () => {
    await router.seedQueuedJob();
    const worker = await router.connectWorker("worker-1");
    const envelope = await reserve(worker);
    await router.jobCall(worker, envelope.jobId, "start", lease(envelope));

    router.clock.advance(31_000);
    const late = await router.post(
      `/api/v1/jobs/${envelope.jobId}/result`,
      result(envelope),
      worker.token,
    );

    expect(late.json()).toEqual({ accepted: true, applied: false });
    expect(getResult(router.db, `result-${envelope.attemptId}`)?.applied).toBe(false);
    expect(getJob(router.db, envelope.jobId)?.state).toBe("recovery_required");
  });

  it("rejects a revoked token with 401", async () => {
    const worker = await router.connectWorker("worker-1");
    revokeWorker(router.db, "worker-1", router.clock.now());
    const response = await router.next(worker, "req-1");
    expect(response.statusCode).toBe(401);
  });

  it("rejects a superseded session and a wrong lease token with 409", async () => {
    await router.seedQueuedJob();
    const worker = await router.connectWorker("worker-1");
    const envelope = await reserve(worker);

    const wrongLease = await router.jobCall(worker, envelope.jobId, "start", {
      attemptId: envelope.attemptId,
      leaseToken: "not-the-lease",
    });
    expect(wrongLease.statusCode).toBe(409);

    // A second process of the same worker opens a new session; the old one loses authority.
    await router.openSession(worker.workerId, worker.token);
    const stale = await router.jobCall(worker, envelope.jobId, "start", lease(envelope));
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: "stale_session" });
  });

  it("answers a protocol version mismatch with 426 before touching anything", async () => {
    const code = await router.pairingCode("worker-1");
    const response = await router.post("/api/v1/workers/register", {
      protocolVersion: PROTOCOL_VERSION + 1,
      pairingCode: code,
      workerName: "worker-1",
    });
    expect(response.statusCode).toBe(426);
    expect(response.json()).toMatchObject({
      error: "protocol_mismatch",
      supportedProtocolVersion: PROTOCOL_VERSION,
    });
    // The code was not consumed by the refused attempt.
    const retry = await router.post("/api/v1/workers/register", {
      protocolVersion: PROTOCOL_VERSION,
      pairingCode: code,
      workerName: "worker-1",
    });
    expect(retry.statusCode).toBe(200);
  });

  it("never hands out work to a worker that has not reported availability yet", async () => {
    await router.seedQueuedJob();
    const code = await router.pairingCode("worker-1");
    const registered = await router.post("/api/v1/workers/register", {
      protocolVersion: PROTOCOL_VERSION,
      pairingCode: code,
      workerName: "worker-1",
    });
    const { workerToken } = registered.json() as { workerToken: string };
    const sessionId = await router.openSession("worker-1", workerToken);

    const response = await router.next(
      { workerId: "worker-1", token: workerToken, sessionId },
      "req-1",
    );
    expect(response.statusCode).toBe(204);
  });

  it("reports the worker's in-flight attempt as pending when it opens a new session", async () => {
    await router.seedQueuedJob();
    const worker = await router.connectWorker("worker-1");
    const envelope = await reserve(worker);
    await router.jobCall(worker, envelope.jobId, "start", lease(envelope));

    const session = await router.post(
      "/api/v1/workers/session",
      { protocolVersion: PROTOCOL_VERSION, workerId: "worker-1" },
      worker.token,
    );
    expect(session.json()).toMatchObject({
      pendingAttempts: [{ jobId: envelope.jobId, attemptId: envelope.attemptId, state: "running" }],
    });
  });
});

describe("admin pairing route", () => {
  let router: RouterHarness;

  beforeEach(() => {
    router = new RouterHarness();
  });

  afterEach(async () => {
    await router.close();
  });

  it("requires the admin token", async () => {
    const response = await router.post("/api/v1/admin/pairing-codes", { workerId: "worker-1" });
    expect(response.statusCode).toBe(401);
    const wrong = await router.post(
      "/api/v1/admin/pairing-codes",
      { workerId: "worker-1" },
      `${ADMIN_TOKEN}x`,
    );
    expect(wrong.statusCode).toBe(401);
  });

  it("refuses a workerId that is not declared in Router config", async () => {
    const response = await router.post(
      "/api/v1/admin/pairing-codes",
      { workerId: "ghost" },
      ADMIN_TOKEN,
    );
    expect(response.statusCode).toBe(404);
  });

  it("binds the registered identity to the code's workerId, and the code works once", async () => {
    const code = await router.pairingCode("worker-2");
    const body = { protocolVersion: PROTOCOL_VERSION, pairingCode: code, workerName: "laptop" };

    const first = await router.post("/api/v1/workers/register", body);
    const second = await router.post("/api/v1/workers/register", body);

    expect(first.json()).toMatchObject({ workerId: "worker-2" });
    expect(second.statusCode).toBe(401);
  });

  it("rejects a code after its 10 minute lifetime", async () => {
    const code = await router.pairingCode("worker-1");
    router.clock.advance(10 * 60 * 1000);
    const response = await router.post("/api/v1/workers/register", {
      protocolVersion: PROTOCOL_VERSION,
      pairingCode: code,
      workerName: "worker-1",
    });
    expect(response.statusCode).toBe(401);
  });

  it("invalidates the old token when a worker is re-paired", async () => {
    const worker = await router.connectWorker("worker-1");
    await router.connectWorker("worker-1");
    const response = await router.heartbeat(worker.workerId, worker.token, worker.sessionId);
    expect(response.statusCode).toBe(401);
  });
});
