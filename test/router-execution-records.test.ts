import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JobEnvelope } from "../src/contracts/envelope.js";
import { PROTOCOL_VERSION } from "../src/contracts/protocol.js";
import { listExecutionRecords } from "../src/router/db/execution-records.js";
import { retryJob } from "../src/router/recovery.js";
import { verifyActiveJobs } from "../src/router/scheduler.js";
import { RuleDecisionProvider } from "../src/router/decision.js";
import {
  IN_PROGRESS_STATUS,
  issueDescription,
  REQUEST_STATUS,
  REVIEW_STATUS,
} from "./helpers/router-fixtures.js";
import { type RegisteredWorker, RouterHarness } from "./helpers/router-harness.js";

const TRANSITIONS = [
  { id: "t-request", name: "Request", toStatusName: REQUEST_STATUS },
  { id: "t-progress", name: "Start", toStatusName: IN_PROGRESS_STATUS },
  { id: "t-review", name: "Review", toStatusName: REVIEW_STATUS },
];

const CLAUDE_CALL = {
  providerId: "default",
  providerType: "claude-code",
  model: "claude-x-1",
  modelSource: "reported",
  callId: "session-1",
  exitReason: "completed",
  durationMs: 61000,
  numTurns: 12,
  usage: {
    inputTokens: 300,
    outputTokens: 4000,
    cacheReadTokens: 90000,
    cacheCreationTokens: 5000,
    cacheReadIncludedInInput: false,
    costUsd: 0.75,
  },
};

/** M4-12 (ADR 0042): the provider call behind every result, kept once and never invented. */
describe("execution records", () => {
  let router: RouterHarness;
  let worker: RegisteredWorker;
  let requests = 0;

  beforeEach(async () => {
    router = new RouterHarness();
    worker = await router.connectWorker("worker-1");
  });

  afterEach(async () => {
    await router.close();
  });

  function seed(key: string, approval: string, extra: Record<string, unknown> = {}): void {
    router.jira.seedIssue(
      {
        key,
        summary: `Work on ${key}`,
        statusName: REQUEST_STATUS,
        projectKey: "KAN",
        assigneeAccountId: "user-1",
        description: issueDescription(),
        ...extra,
      },
      TRANSITIONS,
    );
    router.jira.seedChangelogEntry(key, {
      id: approval,
      items: [{ field: "status", fromString: "To Do", toString: REQUEST_STATUS }],
    });
  }

  async function start(): Promise<JobEnvelope> {
    requests += 1;
    const envelope = (await router.next(worker, `req-${requests}`)).json() as JobEnvelope;
    await router.jobCall(worker, envelope.jobId, "start", {
      attemptId: envelope.attemptId,
      leaseToken: envelope.leaseToken,
    });
    return envelope;
  }

  function submit(envelope: JobEnvelope, overrides: Record<string, unknown> = {}) {
    return router.post(
      `/api/v1/jobs/${envelope.jobId}/result`,
      {
        protocolVersion: PROTOCOL_VERSION,
        jobId: envelope.jobId,
        attemptId: envelope.attemptId,
        resultId: `result-${envelope.attemptId}`,
        status: "succeeded",
        summary: "done",
        ...overrides,
      },
      worker.token,
    );
  }

  it("keeps the call and its usage once, across a resend and a restart (T22)", async () => {
    seed("KAN-1", "approval-a");
    await router.reconcile();
    const envelope = await start();
    await submit(envelope, { execution: CLAUDE_CALL });
    await submit(envelope, { execution: CLAUDE_CALL });
    await router.restart();
    await submit(envelope, { execution: CLAUDE_CALL });

    expect(listExecutionRecords(router.db)).toEqual([
      expect.objectContaining({
        resultId: `result-${envelope.attemptId}`,
        issueKey: "KAN-1",
        kind: "implementation",
        runType: "initial",
        applied: true,
        resultStatus: "succeeded",
        model: "claude-x-1",
        callId: "session-1",
        inputTokens: 300,
        cacheReadTokens: 90000,
        cacheReadIncluded: false,
        usageReported: true,
        causeCategory: "none",
      }),
    ]);
    const view = (await router.adminCall("GET", "/executions?issue=KAN-1")).json();
    expect(view.totals).toMatchObject({
      records: 1,
      usageUnreported: 0,
      inputTokens: 300,
      cacheReadTokensOnTop: 90000,
      cacheReadTokensInsideInput: 0,
      costUsd: 0.75,
    });
  });

  it("records unknown usage as unknown, not zero, for a worker that reports none", async () => {
    seed("KAN-1", "approval-a");
    await router.reconcile();
    await submit(await start());
    const [record] = listExecutionRecords(router.db);
    expect(record).toMatchObject({
      providerId: null,
      inputTokens: null,
      outputTokens: null,
      usageReported: false,
    });
    const view = (await router.adminCall("GET", "/executions")).json();
    expect(view.totals).toMatchObject({ records: 1, usageUnreported: 1, inputTokens: 0 });
  });

  it("keeps failed, retried and reworked runs with what Router can tell about their cause", async () => {
    seed("KAN-1", "approval-a");
    await router.reconcile();
    const first = await start();
    await submit(first, {
      status: "failed",
      summary: "timed out",
      failureReason: "Worker timed out after 1800000ms",
      timedOut: true,
      execution: { ...CLAUDE_CALL, exitReason: "timeout", usage: { outputTokens: 900 } },
    });
    await retryJob(
      { db: router.db, jira: router.jira, config: router.config, now: router.clock.now },
      { jobId: first.jobId, actor: "admin" },
    );
    const retried = await start();
    await submit(retried, {
      status: "failed",
      summary: "tests red",
      failureReason: "Verification failed: it works",
      execution: CLAUDE_CALL,
    });

    // A human requests it again: a new job under a new approval is rework.
    seed("KAN-1", "approval-b");
    await router.reconcile();
    const reworked = await start();
    await submit(reworked, { execution: CLAUDE_CALL });

    expect(
      listExecutionRecords(router.db).map((record) => [
        record.runType,
        record.resultStatus,
        record.causeCategory,
        record.causeSource,
        record.outputTokens,
      ]),
    ).toEqual([
      ["initial", "failed", "environment", "router", 900],
      ["retry", "failed", "unknown", null, 4000],
      ["rework", "succeeded", "none", null, 4000],
    ]);
  });

  it("keeps a cancelled run's usage and names an edited request as the cause", async () => {
    seed("KAN-1", "approval-a");
    await router.reconcile();
    const envelope = await start();
    router.jira.seedIssue(
      {
        ...(await router.jira.getIssue("KAN-1")),
        description: issueDescription({ acceptance: ["Something else"] }),
      },
      TRANSITIONS,
    );
    await verifyActiveJobs({
      db: router.db,
      jira: router.jira,
      config: router.config,
      decisionProvider: new RuleDecisionProvider(router.config.executionAgent),
      now: router.clock.now,
    });
    await submit(envelope, { execution: CLAUDE_CALL });

    expect(listExecutionRecords(router.db)).toEqual([
      expect.objectContaining({
        resultStatus: "cancelled",
        causeCategory: "requirements_change",
        causeSource: "router",
        outputTokens: 4000,
      }),
    ]);
  });

  it("links a subtask's runs to its parent requirement", async () => {
    seed("KAN-2", "approval-sub", { isSubtask: true, parentKey: "KAN-1" });
    await router.reconcile();
    await submit(await start(), { execution: CLAUDE_CALL });

    expect(listExecutionRecords(router.db)[0]?.parentIssueKey).toBe("KAN-1");
    const view = (await router.adminCall("GET", "/executions?issue=KAN-1&children=true")).json();
    expect(view.records.map((record: { issueKey: string }) => record.issueKey)).toEqual(["KAN-2"]);
  });
});
