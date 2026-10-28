import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JobEnvelope } from "../src/contracts/envelope.js";
import { PROTOCOL_VERSION } from "../src/contracts/protocol.js";
import { listAttentionItems, recordAttention } from "../src/router/db/attention.js";
import { getOpenJobForIssue } from "../src/router/db/jobs.js";
import { retryJob, retryReportBatch } from "../src/router/recovery.js";
import { processReportJournal } from "../src/router/report-processor.js";
import { reRequestHint } from "../src/router/workflow-mode.js";
import {
  DONE_STATUS,
  IN_PROGRESS_STATUS,
  REQUEST_STATUS,
  WORKFLOW_TRANSITIONS,
  testWorkspace,
} from "./helpers/router-fixtures.js";
import { type RegisteredWorker, RouterHarness } from "./helpers/router-harness.js";

/** M4-09 (ADR 0041): attention items group incidents, keep their history, and never run anything. */
describe("attention items", () => {
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

  function process() {
    return processReportJournal({ db: router.db, jira: router.jira, now: router.clock.now });
  }

  async function runOnce(overrides: Record<string, unknown>): Promise<JobEnvelope> {
    requests += 1;
    const envelope = (await router.next(worker, `req-${requests}`)).json() as JobEnvelope;
    await router.jobCall(worker, envelope.jobId, "start", {
      attemptId: envelope.attemptId,
      leaseToken: envelope.leaseToken,
    });
    await router.post(
      `/api/v1/jobs/${envelope.jobId}/result`,
      {
        protocolVersion: PROTOCOL_VERSION,
        jobId: envelope.jobId,
        attemptId: envelope.attemptId,
        resultId: `result-${envelope.attemptId}`,
        status: "succeeded",
        summary: "done",
        git: {
          repository: "git",
          baseBranch: "main",
          baseSha: "a".repeat(40),
          headSha: "b".repeat(40),
          committed: true,
        },
        validation: ['"npm test" passed'],
        ...overrides,
      },
      worker.token,
    );
    await process();
    return envelope;
  }

  function retry(jobId: string) {
    return retryJob(
      { db: router.db, jira: router.jira, config: router.config, now: router.clock.now },
      { jobId, actor: "admin" },
    );
  }

  const failed = (reason: string) => ({
    status: "failed",
    summary: "broke",
    failureReason: reason,
  });

  function failureComments(): string[] {
    return router.jira.comments
      .filter((comment) => comment.key === "KAN-1" && comment.body.includes("실행 실패 ["))
      .map((comment) => comment.body);
  }

  it("counts a repeated failure once, resolves it on success, links a recurrence (T20)", async () => {
    await router.seedQueuedJob("KAN-1");
    const first = await runOnce(failed("Tests failed: 3 of 120 in run 4711"));
    expect(failureComments()).toHaveLength(1);
    expect(
      failureComments()[0]
        ?.split("\n")
        .filter((line) => !line.startsWith("[GGJIRA:"))
        .slice(0, 3),
    ).toEqual([
      "실행 실패 [GGJ-999]: 분류되지 않은 오류: Tests failed: 3 of 120 in run 4711.",
      `다음: 원인을 고친 뒤 ${reRequestHint(testWorkspace, "implementation", "ko")}.`,
      expect.stringMatching(/^자세한 내용: Router 머신의 .*KAN-1-.*\.log$/),
    ]);

    // The same failure again on an admin retry: one more occurrence, no second comment.
    await retry(first.jobId);
    await runOnce(failed("Tests failed: 5 of 120 in run 4712"));
    expect(failureComments()).toHaveLength(1);
    let [item] = listAttentionItems(router.db, { issueKey: "KAN-1" });
    expect(item).toMatchObject({ kind: "failed", status: "open", occurrences: 2 });
    expect(item?.firstSeenAt).toBeDefined();

    // A different cause is news: told once.
    await retry(first.jobId);
    await runOnce(failed("Could not reach the package registry"));
    expect(failureComments()).toHaveLength(2);
    expect(listAttentionItems(router.db, { status: "open" })).toHaveLength(2);

    // It finally passes: every open failure of the issue is settled, history kept.
    await retry(first.jobId);
    await runOnce({});
    expect(listAttentionItems(router.db, { status: "open" })).toEqual([]);
    [item] = listAttentionItems(router.db, { issueKey: "KAN-1", status: "resolved" }).filter(
      (entry) => entry.occurrences === 2,
    );
    expect(item?.resolution).toContain("a later run finished");

    // Approved again later and the first cause comes back: a new occurrence, linked, told again.
    await router.reapprove("KAN-1");
    await router.reconcile();
    await runOnce(failed("Tests failed: 1 of 121 in run 4800"));
    const reopened = listAttentionItems(router.db, { status: "open" });
    expect(reopened).toEqual([
      expect.objectContaining({ kind: "failed", occurrences: 1, previousId: item?.id }),
    ]);
    expect(failureComments()).toHaveLength(3);
  });

  it("never starts anything when an item is resolved; only a new approval does (T21)", async () => {
    await router.seedQueuedJob("KAN-1");
    await runOnce({
      status: "needs_decision",
      summary: "Needs a migration",
      implementation: {
        outcome: "needs_decision",
        summary: "Needs a migration",
        scopeDeviations: [{ description: "Schema change", reason: "the API needs it" }],
        risks: [],
        decision: {
          question: "Add a column?",
          options: [
            { id: "a", title: "Add it" },
            { id: "b", title: "Derive it" },
          ],
          recommendation: "b",
          impact: "migration",
        },
        verification: [],
      },
    });
    const [deviation] = listAttentionItems(router.db, { status: "open" });
    expect(deviation).toMatchObject({ kind: "scope_deviation", severity: "immediate" });

    // Polling keeps finding the issue in progress; nothing settles it and nothing runs.
    await router.reconcile();
    await router.reconcile();
    expect(getOpenJobForIssue(router.db, "KAN-1")).toBeUndefined();
    expect(listAttentionItems(router.db, { status: "open" })).toHaveLength(1);

    // Even an item resolved by other means does not start the issue.
    recordAttention(router.db, {
      issueKey: "KAN-1",
      approvalId: null,
      kind: "scope_deviation",
      cause: deviation?.cause as string,
      severity: "immediate",
      reason: "x",
      now: router.clock.now(),
    });
    router.db.prepare("UPDATE attention_items SET status = 'resolved', resolved_at = ?").run("t");
    expect((await router.reconcile()).jobsCreated).toEqual([]);

    // A new request (the human records the decision and asks for a new plan) runs and settles it.
    router.db.prepare("UPDATE attention_items SET status = 'open', resolved_at = NULL").run();
    await router.jira.updateIssueDescription("KAN-1", "Make the change; users has the column too.");
    await router.jira.transitionIssueToStatus("KAN-1", REQUEST_STATUS);
    const report = await router.reconcile();
    expect(report.jobsCreated).toHaveLength(1);
    expect(listAttentionItems(router.db, { status: "open" })).toEqual([]);
    expect(listAttentionItems(router.db, { status: "resolved" })[0]?.resolution).toContain(
      "approved again",
    );
  });

  it("tracks a blocked Jira report until a retry applies it, and lists it over the API", async () => {
    await router.seedQueuedJob("KAN-1");
    router.jira.seedIssue(
      { ...(await router.jira.getIssue("KAN-1")) },
      WORKFLOW_TRANSITIONS.filter(
        (transition) => transition.toStatusName !== testWorkspace.workflow.integrationPendingStatus,
      ),
    );
    const envelope = await runOnce({
      pullRequest: { repo: "org/repo", number: 99, url: "https://github.com/org/repo/pull/99" },
    });
    const open = await router.adminCall("GET", "/attention");
    expect(open.json()).toMatchObject({
      items: [{ kind: "report_blocked", issueKey: "KAN-1", status: "open" }],
    });
    expect((await router.adminCall("GET", "/status")).json()).toMatchObject({
      attention: { open: 1 },
    });

    router.jira.seedIssue({ ...(await router.jira.getIssue("KAN-1")) }, WORKFLOW_TRANSITIONS);
    retryReportBatch(router.db, {
      batchId: `result-${envelope.attemptId}`,
      actor: "admin",
      now: router.clock.now(),
    });
    await process();
    expect((await router.adminCall("GET", "/attention")).json()).toEqual({ items: [] });
    expect(
      (await router.adminCall("GET", "/attention?status=resolved&issue=kan-1")).json(),
    ).toMatchObject({ items: [{ kind: "report_blocked", resolution: expect.any(String) }] });
  });

  it("settles what a run left for a human once a person moves the issue to Done (ADR 0067)", async () => {
    const at = router.clock.now();
    for (const key of ["KAN-7", "KAN-8"]) {
      router.jira.seedIssue({ key, statusName: key === "KAN-7" ? DONE_STATUS : "To Do" });
      recordAttention(router.db, {
        issueKey: key,
        approvalId: null,
        kind: "review_required",
        cause: `result:${key}`,
        severity: "standard",
        reason: "1 acceptance criterion not verified",
        now: at,
      });
    }
    recordAttention(router.db, {
      issueKey: "KAN-7",
      approvalId: null,
      kind: "report_blocked",
      cause: "batch:1",
      severity: "immediate",
      reason: "Jira refused the transition",
      now: at,
    });

    await router.reconcile();

    const open = listAttentionItems(router.db, { status: "open" }).map((i) => [i.issueKey, i.kind]);
    expect(open).toEqual(
      expect.arrayContaining([
        ["KAN-8", "review_required"],
        ["KAN-7", "report_blocked"],
      ]),
    );
    expect(open).toHaveLength(2);
    const [settled] = listAttentionItems(router.db, { issueKey: "KAN-7", kind: "review_required" });
    expect(settled).toMatchObject({
      status: "resolved",
      resolution: `moved to "${DONE_STATUS}" in Jira`,
    });
  });
});
