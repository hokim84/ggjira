import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "../src/contracts/protocol.js";
import { FakeJiraGateway } from "../src/jira/fake.js";
import { AdminService } from "../src/router/admin-service.js";
import type { RouterConfig } from "../src/router/config.js";
import { openRouterDb } from "../src/router/db/connection.js";
import { listUnprocessedEvents, recordEvent } from "../src/router/db/events.js";
import { getJob, getOpenJobForIssue } from "../src/router/db/jobs.js";
import { listJobReportSteps } from "../src/router/db/report-steps.js";
import { RouterDaemon, SYNC_FAILURE_BACKOFF_MS } from "../src/router/daemon.js";
import {
  buildRouterConfig,
  IN_PROGRESS_STATUS,
  issueDescription,
  ManualClock,
  REQUEST_STATUS,
  workerPolicy,
} from "./helpers/router-fixtures.js";

const WEBHOOK_SECRET = "webhook-secret-at-least-16-chars";
const ADMIN_TOKEN = "admin-token-at-least-16-chars";

function sign(body: string): string {
  return `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`;
}

describe("RouterDaemon", () => {
  let dir: string;
  let db: Database.Database;
  let jira: FakeJiraGateway;
  let clock: ManualClock;
  let config: RouterConfig;
  let daemon: RouterDaemon;

  function build(): RouterDaemon {
    return new RouterDaemon({
      db,
      jira,
      config,
      webhookSecret: WEBHOOK_SECRET,
      adminToken: ADMIN_TOKEN,
      siteId: "site-1",
      now: clock.now,
      nowMs: () => Date.parse(clock.now()),
    });
  }

  function seedRequest(key: string): void {
    jira.seedIssue(
      {
        key,
        summary: `Implement ${key}`,
        statusName: REQUEST_STATUS,
        projectKey: "KAN",
        assigneeAccountId: "user-1",
        description: issueDescription(),
      },
      [
        { id: "start", name: "Start", toStatusName: IN_PROGRESS_STATUS },
        { id: "revoke", name: "Revoke", toStatusName: "To Do" },
      ],
    );
  }

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ggjira-daemon-"));
    db = openRouterDb(path.join(dir, "router.sqlite3"));
    jira = new FakeJiraGateway();
    jira.setSelf({ accountId: "router-bot", displayName: "Router", emailAddress: null });
    clock = new ManualClock();
    config = buildRouterConfig({ workers: [workerPolicy({ workerId: "worker-1" })] });
    daemon = build();
  });

  afterEach(async () => {
    await daemon.stop();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("syncs on the first tick, then only when the interval passes or a webhook arrives", async () => {
    seedRequest("KAN-1");
    expect(await daemon.syncTick()).toBeDefined();
    expect(getOpenJobForIssue(db, "KAN-1")?.state).toBe("queued");

    clock.advance(1_000);
    expect(await daemon.syncTick()).toBeUndefined();

    const body = JSON.stringify({ webhookEvent: "jira:issue_updated", issue: { key: "KAN-2" } });
    const response = await daemon.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: {
        "content-type": "application/json",
        "x-hub-signature": sign(body),
        "x-atlassian-webhook-identifier": "delivery-1",
      },
      payload: body,
    });
    expect(response.statusCode).toBe(202);
    seedRequest("KAN-2");

    const report = await daemon.syncTick();
    expect(report?.jobsCreated).toHaveLength(1);
    expect(getOpenJobForIssue(db, "KAN-2")?.state).toBe("queued");
    expect(listUnprocessedEvents(db)).toEqual([]);

    clock.advance(config.reconciliation.backgroundIntervalMs);
    expect(await daemon.syncTick()).toBeDefined();
  });

  it("keeps webhooks unprocessed while Jira is failing and backs off before retrying", async () => {
    recordEvent(db, {
      id: "e1",
      siteId: "site-1",
      webhookDeliveryId: "d1",
      payload: {},
      now: clock.now(),
    });
    const search = vi.spyOn(jira, "searchIssues").mockRejectedValue(new Error("Jira is down"));

    await expect(daemon.syncTick()).rejects.toThrow("Jira is down");
    expect(listUnprocessedEvents(db)).toHaveLength(1);

    clock.advance(SYNC_FAILURE_BACKOFF_MS - 1);
    expect(await daemon.syncTick()).toBeUndefined();
    expect(search).toHaveBeenCalledTimes(1);

    search.mockRestore();
    clock.advance(1);
    expect(await daemon.syncTick()).toBeDefined();
    expect(listUnprocessedEvents(db)).toEqual([]);
  });

  it("applies a new config in place: new workers pair at once, intervals and scheduling follow", async () => {
    expect(() => daemon.workerService.createPairingCode("worker-2")).toThrow(/not declared/);
    expect(await daemon.syncTick()).toBeDefined();

    await daemon.applyConfig({
      ...config,
      workers: [...config.workers, workerPolicy({ workerId: "worker-2" })],
      reconciliation: { ...config.reconciliation, backgroundIntervalMs: 1_000 },
    });

    expect(daemon.workerService.createPairingCode("worker-2").workerId).toBe("worker-2");
    expect(daemon.adminService.listWorkers().map((worker) => worker.workerId)).toEqual([
      "worker-1",
      "worker-2",
    ]);
    clock.advance(1_000);
    expect(await daemon.syncTick()).toBeDefined();

    await daemon.applyConfig({
      ...config,
      workspaces: config.workspaces.map((workspace) => ({ ...workspace, projectKeys: ["OTHER"] })),
    });
    seedRequest("KAN-9");
    clock.advance(config.reconciliation.backgroundIntervalMs);
    await daemon.syncTick();
    expect(getOpenJobForIssue(db, "KAN-9")).toBeUndefined();
  });

  it("serializes an admin reconcile with the timer-driven passes", async () => {
    seedRequest("KAN-1");
    const [a, b] = await Promise.all([daemon.reconcileNow(), daemon.adminService.reconcile("t")]);
    expect([...a.jobsCreated, ...b.jobsCreated]).toHaveLength(1);
  });

  it("runs the report journal: a started job moves the issue to in-progress", async () => {
    seedRequest("KAN-1");
    await daemon.syncTick();
    const pairing = daemon.workerService.createPairingCode("worker-1");
    const { workerToken } = daemon.workerService.register({
      protocolVersion: PROTOCOL_VERSION,
      pairingCode: pairingCode(pairing),
      workerName: "w1",
    });
    const worker = daemon.workerService.authenticate(workerToken);
    const { sessionId } = daemon.workerService.openSession(worker, {
      protocolVersion: PROTOCOL_VERSION,
      workerId: "worker-1",
    });
    daemon.workerService.heartbeat(worker, {
      sessionId,
      workerId: "worker-1",
      availability: { capabilities: ["programming"], repositoryIds: ["repo1"], busy: false },
    });
    const envelope = await daemon.workerService.nextJob(worker, {
      sessionId,
      workerId: "worker-1",
      requestId: "r1",
    });
    if (!envelope) throw new Error("expected a job");
    daemon.workerService.start(worker, envelope.jobId, {
      sessionId,
      attemptId: envelope.attemptId,
      leaseToken: envelope.leaseToken,
    });

    await daemon.reportTick();
    expect((await jira.getIssue("KAN-1")).statusName).toBe(IN_PROGRESS_STATUS);
    expect(listJobReportSteps(db, envelope.jobId).every((s) => s.status === "applied")).toBe(true);

    // The Router's own move is not a withdrawal of approval.
    await daemon.verifyTick();
    expect(getJob(db, envelope.jobId)?.state).toBe("running");

    clock.advance(31_000);
    expect(daemon.leaseTick().recoveryRequired).toHaveLength(1);
  });

  it("starts its loops, syncs on boot, and stops cleanly", async () => {
    seedRequest("KAN-1");
    daemon = new RouterDaemon({
      db,
      jira,
      config,
      webhookSecret: WEBHOOK_SECRET,
      adminToken: ADMIN_TOKEN,
      siteId: "site-1",
      intervals: { eventPollMs: 10, reportMs: 10, leaseSweepMs: 10 },
    });
    daemon.start();
    await vi.waitFor(() => expect(getOpenJobForIssue(db, "KAN-1")).toBeDefined(), {
      timeout: 5_000,
    });
    await daemon.stop();
  });
});

function pairingCode(response: { pairingCode: string }): string {
  return response.pairingCode;
}

describe("backup and restore", () => {
  it("a restored backup resumes pending webhooks, expires the running lease, and keeps reports", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ggjira-restore-"));
    const clock = new ManualClock();
    const config = buildRouterConfig({
      workers: [workerPolicy({ workerId: "worker-1" })],
      db: { path: path.join(dir, "router.sqlite3") },
    });
    const jira = new FakeJiraGateway();
    jira.setSelf({ accountId: "router-bot", displayName: "Router", emailAddress: null });
    for (const key of ["KAN-1", "KAN-2"]) {
      jira.seedIssue(
        {
          key,
          summary: key,
          statusName: REQUEST_STATUS,
          projectKey: "KAN",
          assigneeAccountId: "user-1",
          description: issueDescription(),
        },
        [{ id: "start", name: "Start", toStatusName: IN_PROGRESS_STATUS }],
      );
    }
    const original = openRouterDb(config.db.path);
    const daemon = new RouterDaemon({
      db: original,
      jira,
      config,
      webhookSecret: WEBHOOK_SECRET,
      adminToken: ADMIN_TOKEN,
      siteId: "site-1",
      now: clock.now,
      nowMs: () => Date.parse(clock.now()),
    });

    // State at backup time: KAN-1 running on worker-1 with its start step unreported,
    // one webhook not processed yet, KAN-2 not yet reconciled.
    jira.seedIssue({ key: "KAN-2", statusName: "To Do", projectKey: "KAN" });
    await daemon.syncTick();
    const { pairingCode: code } = daemon.workerService.createPairingCode("worker-1");
    const { workerToken } = daemon.workerService.register({
      protocolVersion: PROTOCOL_VERSION,
      pairingCode: code,
      workerName: "w1",
    });
    const worker = daemon.workerService.authenticate(workerToken);
    const { sessionId } = daemon.workerService.openSession(worker, {
      protocolVersion: PROTOCOL_VERSION,
      workerId: "worker-1",
    });
    daemon.workerService.heartbeat(worker, {
      sessionId,
      workerId: "worker-1",
      availability: { capabilities: ["programming"], repositoryIds: ["repo1"], busy: false },
    });
    const envelope = await daemon.workerService.nextJob(worker, {
      sessionId,
      workerId: "worker-1",
      requestId: "r1",
    });
    if (!envelope) throw new Error("expected a job");
    daemon.workerService.start(worker, envelope.jobId, {
      sessionId,
      attemptId: envelope.attemptId,
      leaseToken: envelope.leaseToken,
    });
    recordEvent(original, {
      id: "e1",
      siteId: "site-1",
      webhookDeliveryId: "d1",
      payload: { issue: { key: "KAN-2" } },
      now: clock.now(),
    });

    const admin = new AdminService({
      db: original,
      jira,
      config,
      now: clock.now,
      backupDir: path.join(dir, "backups"),
    });
    const backup = await admin.backup("tester");
    await daemon.stop();
    original.close();

    // Restore: the backup file becomes the live database of a fresh Router process.
    const restored = openRouterDb(backup.path);
    const clock2 = new ManualClock(Date.parse(clock.now()) + 60_000);
    const revived = new RouterDaemon({
      db: restored,
      jira,
      config,
      webhookSecret: WEBHOOK_SECRET,
      adminToken: ADMIN_TOKEN,
      siteId: "site-1",
      now: clock2.now,
      nowMs: () => Date.parse(clock2.now()),
    });
    try {
      expect(listUnprocessedEvents(restored)).toHaveLength(1);
      jira.seedIssue(
        {
          key: "KAN-2",
          summary: "KAN-2",
          statusName: REQUEST_STATUS,
          projectKey: "KAN",
          assigneeAccountId: "user-1",
          description: issueDescription(),
        },
        [],
      );

      // The running attempt's lease has run out while the Router was down: never re-run.
      expect(revived.leaseTick().recoveryRequired).toEqual([
        { jobId: envelope.jobId, attemptId: envelope.attemptId },
      ]);
      // The pending webhook drives a reconcile that picks up KAN-2.
      await revived.syncTick();
      expect(listUnprocessedEvents(restored)).toEqual([]);
      expect(getOpenJobForIssue(restored, "KAN-2")?.state).toBe("queued");
      // The unreported start step is still journaled and gets applied.
      await revived.reportTick();
      expect((await jira.getIssue("KAN-1")).statusName).toBe(IN_PROGRESS_STATUS);
      expect(getJob(restored, envelope.jobId)?.state).toBe("recovery_required");
    } finally {
      await revived.stop();
      restored.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
