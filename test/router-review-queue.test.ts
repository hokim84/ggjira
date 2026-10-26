import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JobEnvelope } from "../src/contracts/envelope.js";
import { PROTOCOL_VERSION } from "../src/contracts/protocol.js";
import { listAttentionItems } from "../src/router/db/attention.js";
import { listAudit } from "../src/router/db/audit.js";
import type { ReviewQueueItem, ReviewRecordRow } from "../src/router/db/review-targets.js";
import { retryJob } from "../src/router/recovery.js";
import { processReportJournal } from "../src/router/report-processor.js";
import { reRequestHint } from "../src/router/workflow-mode.js";
import { testWorkspace } from "./helpers/router-fixtures.js";
import { ADMIN_TOKEN, type RegisteredWorker, RouterHarness } from "./helpers/router-harness.js";

const HEAD = "b".repeat(40);
const committed = {
  git: {
    repository: "git",
    baseBranch: "main",
    baseSha: "a".repeat(40),
    headSha: HEAD,
    committed: true,
  },
  validation: ['"npm test" passed'],
};
const noCommit = { git: { repository: "none", committed: false } };

/** F01 (ADR 0043): the review queue and per-item judgments, which record and never act. */
describe("review queue", () => {
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

  /** An issue whose plan a human approved; the next reconcile queues its implementation. */
  function seedApproved(
    key: string,
    extra: { assigneeAccountId?: string; parentKey?: string } = {},
  ): Promise<void> {
    return router.seedApprovedIssue(key, {
      summary: `Work on ${key}`,
      assigneeAccountId: extra.assigneeAccountId ?? "user-1",
      fields: extra.parentKey ? { parentKey: extra.parentKey } : {},
    });
  }

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
        summary: `changed ${envelope.issueSnapshot.key}`,
        ...overrides,
      },
      worker.token,
    );
    await process();
    return envelope;
  }

  async function queue(query = ""): Promise<ReviewQueueItem[]> {
    const response = await router.adminCall("GET", `/reviews${query}`);
    expect(response.statusCode).toBe(200);
    return (response.json() as { items: ReviewQueueItem[] }).items;
  }

  function judge(targetId: string, action: string, note?: string) {
    return router.adminCall("POST", `/reviews/${targetId}/judgments`, {
      action,
      ...(note ? { note } : {}),
    });
  }

  const judgmentComments = (key: string) =>
    router.jira.comments
      .filter(
        (comment) =>
          comment.key === key &&
          (comment.body.includes("검토 보류") || comment.body.includes("재작업 요청")),
      )
      .map((comment) => comment.body);

  async function seedTwo(): Promise<{ one: string; two: string }> {
    await seedApproved("KAN-1", { assigneeAccountId: "user-1" });
    await router.reconcile();
    const one = await runOnce(committed);
    await seedApproved("KAN-2", { assigneeAccountId: "user-2", parentKey: "KAN-9" });
    await router.reconcile();
    const two = await runOnce(noCommit);
    return { one: `result-${one.attemptId}`, two: `result-${two.attemptId}` };
  }

  it("splits immediate from standard and filters by owner and parent", async () => {
    const { one, two } = await seedTwo();

    const all = await queue();
    expect(all.map((item) => [item.target.id, item.target.reviewClass, item.state])).toEqual([
      [two, "immediate", "pending"],
      [one, "standard", "pending"],
    ]);
    const [immediate] = all;
    expect(immediate?.issue).toEqual({
      summary: "Work on KAN-2",
      assigneeAccountId: "user-2",
      parentKey: "KAN-9",
    });
    expect(immediate?.result.summary).toBe("changed KAN-2");
    expect(immediate?.target.assessment.reasons.map((reason) => reason.code)).toEqual([
      "no_commit",
      "no_trusted_validation",
    ]);

    expect((await queue("?class=standard")).map((item) => item.target.id)).toEqual([one]);
    expect((await queue("?class=immediate")).map((item) => item.target.id)).toEqual([two]);
    expect((await queue("?assignee=user-1")).map((item) => item.target.id)).toEqual([one]);
    expect((await queue("?parent=kan-9")).map((item) => item.target.id)).toEqual([two]);
    expect((await queue("?issue=kan-1")).map((item) => item.target.id)).toEqual([one]);
    expect((await queue("?issue=KAN-2")).map((item) => item.target.id)).toEqual([two]);
    expect(await queue("?issue=KAN-999")).toEqual([]);
    expect((await router.adminCall("GET", "/reviews?state=bogus")).statusCode).toBe(400);
    expect((await router.adminCall("GET", "/status")).json()).toMatchObject({
      reviews: { waiting: 2 },
    });
  });

  it("records each judgment on its own, comments only for hold and rework, and moves nothing", async () => {
    const { one, two } = await seedTwo();
    const transitionsBefore = router.jira.transitions.length;

    // A hold needs a reason.
    expect((await judge(two, "hold")).statusCode).toBe(400);
    const held = await judge(two, "hold", "Waiting on the design review");
    expect(held.statusCode).toBe(201);
    expect(held.json()).toMatchObject({
      targetId: two,
      issueKey: "KAN-2",
      action: "judgment.hold",
      actor: "admin:tester",
      authentication: "admin-token",
      headSha: null,
      outcome: "matched",
      detail: { commitState: "no_commit", note: "Waiting on the design review" },
    } satisfies Partial<ReviewRecordRow>);

    // Holding one item does not stop another from being judged.
    const confirmed = await judge(one, "confirm");
    expect(confirmed.statusCode).toBe(201);
    expect(confirmed.json()).toMatchObject({ headSha: HEAD, action: "judgment.confirm" });

    await process();
    await process(); // a replay of the journal posts nothing twice
    expect(judgmentComments("KAN-2")).toHaveLength(1);
    expect(judgmentComments("KAN-2")[0]).toContain("이유: Waiting on the design review");
    expect(judgmentComments("KAN-2")[0]).toContain("공유 관리자 토큰으로 밝힌 이름");
    expect(judgmentComments("KAN-1")).toEqual([]);

    expect((await queue()).map((item) => [item.target.id, item.state])).toEqual([[two, "held"]]);
    expect((await queue("?state=confirmed")).map((item) => item.target.id)).toEqual([one]);

    // Confirming the held, individually reviewed item settles its attention item.
    expect(listAttentionItems(router.db, { issueKey: "KAN-2", status: "open" })).toEqual([
      expect.objectContaining({ kind: "review_required" }),
    ]);
    expect((await judge(two, "confirm")).statusCode).toBe(201);
    expect(listAttentionItems(router.db, { issueKey: "KAN-2", status: "open" })).toEqual([]);
    expect(await queue()).toEqual([]);

    // No judgment moved a Jira status or started a job.
    await process();
    expect(router.jira.transitions.length).toBe(transitionsBefore);
    expect(
      listAudit(router.db)
        .map((entry) => entry.action)
        .filter((action) => action.startsWith("review.")),
    ).toEqual([
      "review.judgment.refused",
      "review.judgment.hold",
      "review.judgment.confirm",
      "review.judgment.confirm",
    ]);
  });

  it("records a non-ASCII reviewer name sent percent-encoded", async () => {
    const { one } = await seedTwo();
    const response = await router.app.inject({
      method: "POST",
      url: `/api/v1/admin/reviews/${one}/judgments`,
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        "content-type": "application/json",
        "x-ggjira-actor": encodeURIComponent("검토자 김"),
      },
      payload: JSON.stringify({ action: "confirm" }),
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ actor: "admin:검토자 김" });
  });

  it("refuses a judgment on a superseded target and points at the current one (T16)", async () => {
    await seedApproved("KAN-1");
    await router.reconcile();
    const first = await runOnce({ status: "failed", summary: "broke", failureReason: "tests" });
    await retryJob(
      { db: router.db, jira: router.jira, config: router.config, now: router.clock.now },
      { jobId: first.jobId, actor: "admin" },
    );
    const second = await runOnce(committed);

    const response = await judge(`result-${first.attemptId}`, "confirm");
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: "stale_review_target",
      currentTargetId: `result-${second.attemptId}`,
    });
    const refused = listAudit(router.db).find(
      (entry) => entry.action === "review.judgment.refused",
    );
    expect(refused?.detail).toMatchObject({ currentTargetId: `result-${second.attemptId}` });
    expect((await judge("result-nope", "confirm")).statusCode).toBe(404);
    expect((await judge(`result-${second.attemptId}`, "approve")).statusCode).toBe(400);
  });

  it("asks for rework without rerunning; the next approved run is a new target", async () => {
    await seedApproved("KAN-1");
    await router.reconcile();
    const first = await runOnce(committed);
    const firstTarget = `result-${first.attemptId}`;

    expect((await judge(firstTarget, "rework", "The error message is wrong")).statusCode).toBe(201);
    await process();
    const [comment] = judgmentComments("KAN-1");
    expect(comment).toContain("재작업 요청");
    expect(comment).toContain("GGJIRA가 스스로 다시 실행하지 않습니다");
    expect(comment).toContain(reRequestHint(testWorkspace, "implementation", "ko"));
    expect(await queue()).toEqual([]);
    await router.reconcile();
    expect((await router.adminCall("GET", "/jobs?state=queued")).json()).toMatchObject({
      jobs: [],
    });

    // A human approves the plan again: a new approval. The old target can no longer be judged.
    await router.reapprove("KAN-1");
    await router.reconcile();
    const stale = await judge(firstTarget, "confirm");
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: "stale_review_target" });

    const second = await runOnce(committed);
    expect((await queue()).map((item) => [item.target.id, item.state])).toEqual([
      [`result-${second.attemptId}`, "pending"],
    ]);
  });
});
