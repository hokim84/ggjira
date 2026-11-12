import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobEnvelope } from "../src/contracts/envelope.js";
import { PROTOCOL_VERSION } from "../src/contracts/protocol.js";
import { SlackConfigSchema } from "../src/router/config.js";
import { RouterDaemon } from "../src/router/daemon.js";
import { listAudit } from "../src/router/db/audit.js";
import { getOpenJobForIssue } from "../src/router/db/jobs.js";
import { latestPlanningRequest } from "../src/router/planning-requests.js";
import { processReportJournal } from "../src/router/report-processor.js";
import { buildRouterServer } from "../src/router/server.js";
import { SlackService, verifySlackSignature } from "../src/router/slack.js";
import { WORKFLOW_TRANSITIONS, singlePlan, testWorkspace } from "./helpers/router-fixtures.js";
import { type RegisteredWorker, RouterHarness } from "./helpers/router-harness.js";

const w = testWorkspace.workflow;
const decision = {
  question: "저장 방식?",
  options: [
    { id: "sql", title: "SQLite", pros: ["검색"], cons: [] },
    { id: "json", title: "JSON", pros: [], cons: [] },
  ],
  recommendation: "sql",
};
describe("Slack conversations and execution consent", () => {
  let router: RouterHarness;
  let slack: SlackService;
  let worker: RegisteredWorker;
  let serial: number;
  let sent: Record<string, unknown>[];
  let failSlack: boolean;
  const fakeFetch: typeof fetch = async (url, init) => {
    if (failSlack) return new Response('{"ok":false,"error":"ratelimited"}');
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    if (String(url).endsWith("conversations.open"))
      return new Response('{"ok":true,"channel":{"id":"D1"}}');
    sent.push(body);
    return new Response(JSON.stringify({ ok: true, ts: `${sent.length}.0001` }));
  };
  function service() {
    return new SlackService({
      db: router.db,
      jira: router.jira,
      config: router.config,
      secrets: { botToken: "fake", signingSecret: "secret" },
      now: router.clock.now,
      fetch: fakeFetch,
    });
  }
  beforeEach(async () => {
    serial = 0;
    sent = [];
    failSlack = false;
    router = new RouterHarness({
      config: {
        slack: SlackConfigSchema.parse({
          enabled: true,
          teamId: "T1",
          workspaceIds: ["ws1"],
          users: [{ jiraAccountId: "owner", slackUserId: "U1" }],
        }),
      },
    });
    slack = service();
    worker = await router.connectWorker("worker-1");
    router.jira.setCreatedIssueTransitions(WORKFLOW_TRANSITIONS);
    router.jira.seedIssue(
      {
        key: "KAN-1",
        summary: "Feature",
        description: "Build feature",
        statusName: w.requestStatus,
        assigneeAccountId: "owner",
      },
      WORKFLOW_TRANSITIONS,
    );
  });
  afterEach(async () => {
    await router.close();
  });
  async function process() {
    const report = await processReportJournal({
      db: router.db,
      jira: router.jira,
      now: router.clock.now,
    });
    expect(report.blocked).toEqual([]);
  }
  async function start(): Promise<JobEnvelope> {
    await router.reconcile();
    const next = await router.next(worker, `slack-${++serial}`);
    expect(next.statusCode, next.body).toBe(200);
    const job = next.json() as JobEnvelope;
    const response = await router.jobCall(worker, job.jobId, "start", {
      attemptId: job.attemptId,
      leaseToken: job.leaseToken,
    });
    expect(response.statusCode, response.body).toBe(200);
    await process();
    return job;
  }
  async function finish(job: JobEnvelope, plan?: object, status = "planned") {
    const response = await router.post(
      `/api/v1/jobs/${job.jobId}/result`,
      {
        protocolVersion: PROTOCOL_VERSION,
        jobId: job.jobId,
        attemptId: job.attemptId,
        resultId: `r-${job.attemptId}`,
        status,
        summary: "Plan",
        ...(plan ? { plan } : {}),
      },
      worker.token,
    );
    expect(response.statusCode, response.body).toBe(200);
    await process();
  }
  async function ask() {
    await finish(await start(), singlePlan({ needsDecision: true, decision }), "needs_decision");
    await slack.tick();
    return router.db
      .prepare(
        "SELECT q.*, t.thread_ts FROM slack_questions q JOIN slack_threads t ON t.id=q.thread_id ORDER BY q.rowid DESC LIMIT 1",
      )
      .get() as Record<string, string>;
  }
  function answer(question: Record<string, string>, text: string, user = "U1", eventId = "Ev1") {
    slack.ingest({
      type: "event_callback",
      team_id: "T1",
      event_id: eventId,
      event: {
        type: "message",
        channel_type: "im",
        channel: "D1",
        user,
        thread_ts: question.thread_ts,
        text,
      },
    });
  }
  it("mirrors a choice, continues in one thread, then automatically starts a final plan once", async () => {
    const question = await ask();
    expect(sent.some((message) => String(message.text).includes("SQLite"))).toBe(true);
    answer(question, "2.");
    answer(question, "2.");
    await slack.tick();
    expect(
      router.jira.comments.filter((comment) => comment.body.includes("Slack 답변")),
    ).toHaveLength(1);
    const followup = await start();
    expect(followup.kind).toBe("planning");
    expect(latestPlanningRequest(router.db, "KAN-1")?.decision).toContain('"optionId":"json"');
    await finish(followup, singlePlan());
    await slack.tick();
    await slack.tick();
    expect((await router.jira.getIssue("KAN-1")).statusName).toBe(w.inProgressStatus);
    expect(router.db.prepare("SELECT COUNT(*) n FROM slack_threads").get()?.n).toBe(1);
    expect(
      listAudit(router.db).filter((entry) => entry.action === "slack.implementation-approved"),
    ).toHaveLength(1);
    const implementation = await start();
    expect(implementation.kind).toBe("implementation");
    await slack.tick();
    expect(sent.some((message) => String(message.text).includes("구현 시작"))).toBe(true);
    await finish(implementation, undefined, "succeeded");
    await slack.tick();
    expect(sent.some((message) => String(message.text).includes("구현 · 완료"))).toBe(true);
    expect(sent.some((message) => String(message.text).includes("검토 대기"))).toBe(false);
  });
  it("supports readable button answers and free text follow-up questions", async () => {
    const first = await ask();
    slack.ingest({
      type: "block_actions",
      team: { id: "T1" },
      user: { id: "U1" },
      container: { channel_id: "D1" },
      actions: [
        {
          action_id: "ggjira_choice_0",
          action_ts: "1",
          value: JSON.stringify({ question: first.id, option: "sql" }),
        },
      ],
    });
    await slack.tick();
    expect(sent.some((message) => String(message.text).includes("답변 · <@U1>"))).toBe(true);
    await finish(
      await start(),
      singlePlan({ needsDecision: true, decision: { ...decision, question: "추가 요구?" } }),
      "needs_decision",
    );
    await slack.tick();
    const latest = router.db
      .prepare(
        "SELECT q.*,t.thread_ts FROM slack_questions q JOIN slack_threads t ON t.id=q.thread_id ORDER BY q.rowid DESC LIMIT 1",
      )
      .get() as Record<string, string>;
    answer(latest, "기존 데이터 이전도 포함해주세요", "U1", "Ev2");
    await slack.tick();
    await start();
    expect(latestPlanningRequest(router.db, "KAN-1")?.decision).toContain("기존 데이터 이전");
    expect(router.db.prepare("SELECT COUNT(*) n FROM slack_threads").get()?.n).toBe(1);
  });
  it("approves published child tasks while the scheduler enforces dependencies", async () => {
    await finish(
      await start(),
      singlePlan({
        tasks: [
          {
            taskId: "a",
            title: "A",
            description: "Build A",
            acceptance: ["Works"],
            verification: ["Test"],
          },
          {
            taskId: "b",
            title: "B",
            description: "Build B",
            acceptance: ["Works"],
            verification: ["Test"],
            dependencies: ["a"],
          },
        ],
      }),
    );
    await slack.tick();
    const report = await router.reconcile();
    expect(report.held).toEqual([]);
    expect((await router.jira.getIssue("KAN-1001")).statusName).toBe(w.inProgressStatus);
    expect((await router.jira.getIssue("KAN-1002")).statusName).toBe(w.inProgressStatus);
    expect(getOpenJobForIssue(router.db, "KAN-1001")?.kind, JSON.stringify(report)).toBe(
      "implementation",
    );
    expect(getOpenJobForIssue(router.db, "KAN-1002")?.state).toBe("waiting");
  });
  it("holds auto execution until Slack delivery succeeds and resumes after restart", async () => {
    await finish(await start(), singlePlan());
    failSlack = true;
    await slack.tick();
    expect((await router.jira.getIssue("KAN-1")).statusName).toBe(w.planningInProgressStatus);
    expect(slack.status().pending).toBeGreaterThan(0);
    await router.restart();
    slack = service();
    failSlack = false;
    router.clock.advance(31_000);
    await slack.tick();
    expect((await router.jira.getIssue("KAN-1")).statusName).toBe(w.inProgressStatus);
    expect(
      router.jira.comments.filter((comment) => comment.body.includes("[GGJIRA:SLACK:plan:")),
    ).toHaveLength(1);
  });
  it("rejects other users, invalid choices and stale answers", async () => {
    const question = await ask();
    answer(question, "1", "U2", "wrong-user");
    answer(question, "9", "U1", "invalid");
    answer(question, "9.", "U1", "invalid-dot");
    answer(question, "0", "U1", "invalid-zero");
    answer(question, "-1", "U1", "invalid-negative");
    await slack.tick();
    expect(router.db.prepare("SELECT COUNT(*) n FROM slack_answers").get()?.n).toBe(0);
    await router.jira.assignIssue("KAN-1", "new-owner");
    answer(question, "1", "U1", "stale");
    await slack.tick();
    expect(router.db.prepare("SELECT COUNT(*) n FROM slack_answers").get()?.n).toBe(0);
  });
  it("does not auto approve requests made before enabling Slack or unmapped owners", async () => {
    await finish(await start(), singlePlan());
    router.clock.advance(1000);
    router.db.prepare("DELETE FROM slack_activation").run();
    slack = service();
    await slack.tick();
    expect(router.db.prepare("SELECT COUNT(*) n FROM slack_threads").get()?.n).toBe(0);
    expect((await router.jira.getIssue("KAN-1")).statusName).toBe(w.planningInProgressStatus);
  });
  it("retries a Jira mirror failure without losing or duplicating an answer", async () => {
    const question = await ask();
    answer(question, "1");
    const original = router.jira.addComment.bind(router.jira);
    const spy = vi
      .spyOn(router.jira, "addComment")
      .mockRejectedValueOnce(new Error("Jira unavailable"));
    await slack.tick();
    expect(router.db.prepare("SELECT mirrored FROM slack_answers").get()?.mirrored).toBe(0);
    spy.mockImplementation(original);
    await slack.tick();
    await slack.tick();
    expect(router.db.prepare("SELECT mirrored FROM slack_answers").get()?.mirrored).toBe(1);
    expect(
      router.jira.comments.filter((comment) => comment.body.includes("Slack 답변")),
    ).toHaveLength(1);
  });
  it("holds final-plan approval on Jira mirror failure without blocking other durable work", async () => {
    await finish(await start(), singlePlan());
    const original = router.jira.addComment.bind(router.jira);
    const spy = vi
      .spyOn(router.jira, "addComment")
      .mockRejectedValueOnce(new Error("Jira unavailable"));
    await slack.tick();
    expect((await router.jira.getIssue("KAN-1")).statusName).toBe(w.planningInProgressStatus);
    expect(slack.status().errors.length).toBeGreaterThan(0);
    spy.mockImplementation(original);
    await slack.tick();
    expect((await router.jira.getIssue("KAN-1")).statusName).toBe(w.inProgressStatus);
    expect(slack.status().errors).toEqual([]);
  });
  it("hands a pending question to a newly mapped owner and invalidates the old owner's reply", async () => {
    const old = await ask();
    router.config.slack?.users.push({ jiraAccountId: "new-owner", slackUserId: "U2" });
    await router.jira.assignIssue("KAN-1", "new-owner");
    await slack.tick();
    const question = router.db
      .prepare(
        "SELECT q.*,t.thread_ts FROM slack_questions q JOIN slack_threads t ON t.id=q.thread_id WHERE t.owner='new-owner'",
      )
      .get() as Record<string, string>;
    expect(question).toBeDefined();
    answer(old, "1", "U1", "old-owner");
    await slack.tick();
    expect(router.db.prepare("SELECT COUNT(*) n FROM slack_answers").get()?.n).toBe(0);
    answer(question, "2", "U2", "new-owner");
    await slack.tick();
    expect(router.db.prepare("SELECT mirrored FROM slack_answers").get()?.mirrored).toBe(1);
  });
  it("keeps existing Jira approval behavior when Slack is disabled or the owner is unmapped", async () => {
    await finish(await start(), singlePlan());
    slack.setConfig({ ...router.config, slack: SlackConfigSchema.parse({ enabled: false }) });
    await slack.tick();
    expect(sent).toHaveLength(0);
    expect((await router.jira.getIssue("KAN-1")).statusName).toBe(w.planningInProgressStatus);
    slack.setConfig({
      ...router.config,
      slack: SlackConfigSchema.parse({ ...router.config.slack, users: [] }),
    });
    await slack.tick();
    expect(sent).toHaveLength(0);
  });
  it.each([false, true])(
    "replans an implementation decision in the same thread (child=%s)",
    async (child) => {
      await finish(
        await start(),
        singlePlan(
          child
            ? {
                tasks: [
                  {
                    taskId: "a",
                    title: "A",
                    description: "Original scope",
                    acceptance: ["Old acceptance"],
                    verification: ["Test"],
                  },
                ],
              }
            : {},
        ),
      );
      await slack.tick();
      const job = await start();
      const response = await router.post(
        `/api/v1/jobs/${job.jobId}/result`,
        {
          protocolVersion: PROTOCOL_VERSION,
          jobId: job.jobId,
          attemptId: job.attemptId,
          resultId: `stop-${job.attemptId}`,
          status: "needs_decision",
          summary: "Need a choice",
          implementation: { outcome: "needs_decision", summary: "Need a choice", decision },
        },
        worker.token,
      );
      expect(response.statusCode, response.body).toBe(200);
      await process();
      await slack.tick();
      const question = router.db
        .prepare(
          "SELECT q.*,t.thread_ts FROM slack_questions q JOIN slack_threads t ON t.id=q.thread_id WHERE q.kind='implementation'",
        )
        .get() as Record<string, string>;
      expect(question).toBeDefined();
      answer(question, "1");
      await slack.tick();
      const next = await start();
      expect(next.kind).toBe("planning");
      expect(latestPlanningRequest(router.db, child ? "KAN-1001" : "KAN-1")?.decision).toContain(
        "SQLite",
      );
      await finish(next, singlePlan({ acceptanceCriteria: ["New acceptance after decision"] }));
      await slack.tick();
      expect(router.db.prepare("SELECT COUNT(*) n FROM slack_threads").get()?.n).toBe(1);
      const resumed = await start();
      expect(resumed.kind).toBe("implementation");
      expect(resumed.executionContract?.acceptance).toContain("New acceptance after decision");
    },
  );
  it("verifies raw HTTP signatures for JSON and interactive form requests", async () => {
    const app = buildRouterServer({
      db: router.db,
      webhookSecret: "fake",
      siteId: "site",
      now: router.clock.now,
      slack: { service: slack, signingSecret: () => "secret" },
    });
    const timestamp = String(Date.parse(router.clock.now()) / 1000);
    const body = JSON.stringify({ type: "url_verification", challenge: "challenge" });
    const signature = `v0=${createHmac("sha256", "secret").update(`v0:${timestamp}:${body}`).digest("hex")}`;
    try {
      const valid = await app.inject({
        method: "POST",
        url: "/webhooks/slack",
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": signature,
        },
        payload: body,
      });
      expect(valid.json()).toEqual({ challenge: "challenge" });
      const question = await ask();
      const form = new URLSearchParams({
        payload: JSON.stringify({
          type: "block_actions",
          team: { id: "T1" },
          user: { id: "U1" },
          container: { channel_id: "D1" },
          actions: [
            {
              action_id: "ggjira_choice_0",
              action_ts: "form-1",
              value: JSON.stringify({ question: question.id, option: "sql" }),
            },
          ],
        }),
      }).toString();
      const formSignature = `v0=${createHmac("sha256", "secret").update(`v0:${timestamp}:${form}`).digest("hex")}`;
      const interactive = await app.inject({
        method: "POST",
        url: "/webhooks/slack",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": formSignature,
        },
        payload: form,
      });
      expect(interactive.statusCode).toBe(200);
      await slack.tick();
      expect(router.db.prepare("SELECT mirrored FROM slack_answers").get()?.mirrored).toBe(1);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/webhooks/slack",
            headers: { "content-type": "application/json" },
            payload: body,
          })
        ).statusCode,
      ).toBe(401);
      expect(
        verifySlackSignature(
          Buffer.from(body),
          timestamp,
          signature,
          "secret",
          Date.parse(router.clock.now()) + 301_000,
        ),
      ).toBe(false);
    } finally {
      await app.close();
    }
  });
  it("applies write-only secrets immediately and connects the daemon report pass to auto execution", async () => {
    const daemon = new RouterDaemon({
      db: router.db,
      jira: router.jira,
      config: router.config,
      siteId: "fake",
      webhookSecret: "fake-webhook",
      adminToken: "fake-admin",
      secretsPath: `${router.dataDir}/slack.env`,
      now: router.clock.now,
      nowMs: () => Date.parse(router.clock.now()),
      slack: { fetch: fakeFetch },
    });
    try {
      for (const key of ["slack-token", "slack-signing-secret"]) {
        const response = await daemon.app.inject({
          method: "PUT",
          url: `/api/v1/admin/secrets/${key}`,
          headers: { authorization: "Bearer fake-admin" },
          payload: { value: `fake-private-${key}` },
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.body).not.toContain(`fake-private-${key}`);
      }
      const status = await daemon.app.inject({
        method: "GET",
        url: "/api/v1/admin/slack",
        headers: { authorization: "Bearer fake-admin" },
      });
      expect(status.json()).toMatchObject({
        token: { set: true },
        signingSecret: { set: true },
        status: { ready: true },
      });
      await finish(await start(), singlePlan());
      await daemon.reportTick();
      expect((await router.jira.getIssue("KAN-1")).statusName).toBe(w.inProgressStatus);
      await daemon.syncTick();
      expect(getOpenJobForIssue(router.db, "KAN-1")?.kind).toBe("implementation");
    } finally {
      await daemon.stop();
    }
  });
});
