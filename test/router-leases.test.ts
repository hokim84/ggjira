import { afterEach, describe, expect, it } from "vitest";
import type { JobEnvelope } from "../src/contracts/envelope.js";
import { getActiveAttemptForWorker, getAttempt } from "../src/router/db/attempts.js";
import { getJob, getOpenJobForIssue } from "../src/router/db/jobs.js";
import { expireLeases } from "../src/router/leases.js";
import { RouterHarness } from "./helpers/router-harness.js";

describe("lease expiry", () => {
  let router: RouterHarness;

  afterEach(async () => {
    await router.close();
  });

  async function reserveAndMaybeStart(start: boolean): Promise<JobEnvelope> {
    await router.seedQueuedJob();
    const worker = await router.connectWorker("worker-1");
    const envelope = (await router.next(worker, "req-1")).json() as JobEnvelope;
    if (start) {
      await router.jobCall(worker, envelope.jobId, "start", {
        attemptId: envelope.attemptId,
        leaseToken: envelope.leaseToken,
      });
    }
    return envelope;
  }

  it("requeues a job whose lease ran out before start, so another worker can take it", async () => {
    router = new RouterHarness();
    const envelope = await reserveAndMaybeStart(false);

    router.clock.advance(31_000);
    const report = expireLeases(router.db, router.clock.now());

    expect(report.requeued).toEqual([{ jobId: envelope.jobId, attemptId: envelope.attemptId }]);
    expect(getAttempt(router.db, envelope.attemptId)?.state).toBe("cancelled");
    expect(getJob(router.db, envelope.jobId)?.state).toBe("queued");

    const other = await router.connectWorker("worker-2");
    const retaken = (await router.next(other, "req-other")).json() as JobEnvelope;
    expect(retaken.jobId).toBe(envelope.jobId);
    expect(retaken.attemptId).not.toBe(envelope.attemptId);
  });

  it("parks a started job in recovery_required on expiry and never reassigns it automatically", async () => {
    router = new RouterHarness();
    const envelope = await reserveAndMaybeStart(true);

    router.clock.advance(31_000);
    const report = expireLeases(router.db, router.clock.now());

    expect(report.recoveryRequired).toEqual([
      { jobId: envelope.jobId, attemptId: envelope.attemptId },
    ]);
    expect(getJob(router.db, envelope.jobId)?.state).toBe("recovery_required");
    expect(getActiveAttemptForWorker(router.db, "worker-1")).toBeUndefined();

    // Neither a reconcile nor another worker's poll picks it back up.
    await router.reconcile();
    const other = await router.connectWorker("worker-2");
    expect((await router.next(other, "req-other")).statusCode).toBe(204);
    expect(getOpenJobForIssue(router.db, "KAN-1")?.state).toBe("recovery_required");
  });

  it("rejects a late job heartbeat after the lease expired with 409", async () => {
    router = new RouterHarness();
    await router.seedQueuedJob();
    const worker = await router.connectWorker("worker-1");
    const envelope = (await router.next(worker, "req-1")).json() as JobEnvelope;
    const lease = { attemptId: envelope.attemptId, leaseToken: envelope.leaseToken };
    await router.jobCall(worker, envelope.jobId, "start", lease);

    router.clock.advance(31_000);
    const late = await router.jobCall(worker, envelope.jobId, "heartbeat", lease);

    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({ error: "lease_expired" });
  });

  it("keeps a running lease alive across heartbeats well past the initial 30s", async () => {
    router = new RouterHarness();
    await router.seedQueuedJob();
    const worker = await router.connectWorker("worker-1");
    const envelope = (await router.next(worker, "req-1")).json() as JobEnvelope;
    const lease = { attemptId: envelope.attemptId, leaseToken: envelope.leaseToken };
    await router.jobCall(worker, envelope.jobId, "start", lease);

    for (let i = 0; i < 12; i += 1) {
      router.clock.advance(5_000);
      const beat = await router.jobCall(worker, envelope.jobId, "heartbeat", lease);
      expect(beat.statusCode).toBe(200);
    }
    expect(getJob(router.db, envelope.jobId)?.state).toBe("running");
  });

  it("moves a cancel_requested job whose worker went silent to recovery_required, not cancelled", async () => {
    router = new RouterHarness();
    const envelope = await reserveAndMaybeStart(true);
    await router.jira.transitionIssue("KAN-1", "Revoke");
    await router.reconcile();
    expect(getJob(router.db, envelope.jobId)?.state).toBe("cancel_requested");

    router.clock.advance(31_000);
    expireLeases(router.db, router.clock.now());

    expect(getJob(router.db, envelope.jobId)?.state).toBe("recovery_required");
    expect(getAttempt(router.db, envelope.attemptId)?.state).toBe("recovery_required");
  });

  it("keeps leases across a Router restart: nothing is cleared or resumed on boot", async () => {
    router = new RouterHarness();
    const envelope = await reserveAndMaybeStart(true);

    await router.restart();

    expect(getJob(router.db, envelope.jobId)?.state).toBe("running");
    expect(getAttempt(router.db, envelope.attemptId)?.state).toBe("running");
  });
});

describe("jobs/next long polling", () => {
  let router: RouterHarness;

  afterEach(async () => {
    await router.close();
  });

  it("holds the request open and returns a job queued while it waits", async () => {
    let sleeps = 0;
    router = new RouterHarness({
      service: {
        longPollMs: 25_000,
        pollIntervalMs: 1_000,
        sleep: async (ms) => {
          sleeps += 1;
          router.clock.advance(ms);
          // The job shows up two polls into the wait.
          if (sleeps === 2) await router.seedQueuedJob();
        },
      },
    });
    const worker = await router.connectWorker("worker-1");

    const response = await router.next(worker, "req-1");

    expect(response.statusCode).toBe(200);
    expect(sleeps).toBe(2);
  });

  it("counts the poll itself as liveness: a job queued 20s in (past the 15s freshness window) is served", async () => {
    let waitedMs = 0;
    router = new RouterHarness({
      service: {
        longPollMs: 25_000,
        pollIntervalMs: 1_000,
        sleep: async (ms) => {
          waitedMs += ms;
          router.clock.advance(ms);
          if (waitedMs === 20_000) await router.seedQueuedJob();
        },
      },
    });
    const worker = await router.connectWorker("worker-1");

    const response = await router.next(worker, "req-1");

    expect(response.statusCode).toBe(200);
    expect(waitedMs).toBe(20_000);
  });

  it("gives up with 204 once 25 seconds pass with nothing to hand out", async () => {
    let waitedMs = 0;
    router = new RouterHarness({
      service: {
        longPollMs: 25_000,
        pollIntervalMs: 1_000,
        sleep: async (ms) => {
          waitedMs += ms;
          router.clock.advance(ms);
        },
      },
    });
    const worker = await router.connectWorker("worker-1");

    const response = await router.next(worker, "req-1");

    expect(response.statusCode).toBe(204);
    expect(waitedMs).toBe(25_000);
  });

  it("ends the wait early when a newer session supersedes the polling one", async () => {
    let sleeps = 0;
    router = new RouterHarness({
      service: {
        longPollMs: 25_000,
        pollIntervalMs: 1_000,
        sleep: async (ms) => {
          sleeps += 1;
          router.clock.advance(ms);
          // Only called during `next` below, after `worker` is assigned.
          if (sleeps === 1) await router.openSession(worker.workerId, worker.token);
        },
      },
    });
    const worker = await router.connectWorker("worker-1");

    const response = await router.next(worker, "req-1");

    expect(response.statusCode).toBe(204);
    expect(sleeps).toBe(1);
  });
});
