import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JobEnvelope } from "../src/contracts/envelope.js";
import { PROTOCOL_VERSION } from "../src/contracts/protocol.js";
import { PLAN_PROPERTY_KEY, PLAN_TASK_PROPERTY_KEY } from "../src/pm/metadata.js";
import { listAudit } from "../src/router/db/audit.js";
import { getJob, getOpenJobForIssue } from "../src/router/db/jobs.js";
import { listBlockedReportSteps, listJobReportSteps } from "../src/router/db/report-steps.js";
import {
  RecoveryError,
  resolveRecoveryJob,
  retryJob,
  retryReportBatch,
} from "../src/router/recovery.js";
import { RuleDecisionProvider } from "../src/router/decision.js";
import { processReportJournal } from "../src/router/report-processor.js";
import { verifyActiveJobs } from "../src/router/scheduler.js";
import {
  IN_PROGRESS_STATUS,
  issueDescription,
  PLANNING_STATUS,
  REQUEST_STATUS,
  REVIEW_STATUS,
} from "./helpers/router-fixtures.js";
import { type RegisteredWorker, RouterHarness } from "./helpers/router-harness.js";

const TRANSITIONS = [
  { id: "t-progress", name: "Start", toStatusName: IN_PROGRESS_STATUS },
  { id: "t-review", name: "Review", toStatusName: REVIEW_STATUS },
  { id: "t-request", name: "Request", toStatusName: REQUEST_STATUS },
  { id: "t-plan", name: "Plan", toStatusName: PLANNING_STATUS },
  { id: "t-todo", name: "Back", toStatusName: "To Do" },
];

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

const twoTaskPlan = {
  needsDecision: false,
  summary: "Split into API and UI",
  tasks: [
    {
      taskId: "api",
      title: "Build the API",
      description: "Endpoints",
      acceptance: ["returns 200"],
      requiredCapabilities: ["programming"],
    },
    {
      taskId: "ui",
      title: "Build the UI",
      description: "Screens",
      acceptance: [],
      dependencies: ["api"],
      requiredCapabilities: ["programming"],
    },
  ],
  keepTaskKeys: [],
  agentProfiles: [],
  disableAgentIds: [],
};

describe("Router Jira reporting journal", () => {
  let router: RouterHarness;
  let worker: RegisteredWorker;

  beforeEach(async () => {
    router = new RouterHarness();
    worker = await router.connectWorker("worker-1");
  });

  afterEach(async () => {
    await router.close();
  });

  function seedIssue(key: string, statusName: string, extra: Record<string, unknown> = {}): void {
    router.jira.seedIssue(
      {
        key,
        summary: `Work on ${key}`,
        statusName,
        projectKey: "KAN",
        assigneeAccountId: "user-1",
        description: issueDescription(),
        ...extra,
      },
      TRANSITIONS,
    );
    router.jira.seedChangelogEntry(key, {
      id: `${key}-approved`,
      items: [{ field: "status", fromString: "To Do", toString: statusName }],
    });
  }

  function process() {
    return processReportJournal({ db: router.db, jira: router.jira, now: router.clock.now });
  }

  async function reserve(requestId = "req-1"): Promise<JobEnvelope> {
    const response = await router.next(worker, requestId);
    expect(response.statusCode).toBe(200);
    return response.json() as JobEnvelope;
  }

  async function startJob(key: string, status = REQUEST_STATUS): Promise<JobEnvelope> {
    seedIssue(key, status);
    await router.reconcile();
    const envelope = await reserve();
    const start = await router.jobCall(worker, envelope.jobId, "start", lease(envelope));
    expect(start.json()).toMatchObject({ granted: true });
    return envelope;
  }

  function submit(envelope: JobEnvelope, overrides: Record<string, unknown> = {}) {
    return router.post(
      `/api/v1/jobs/${envelope.jobId}/result`,
      result(envelope, overrides),
      worker.token,
    );
  }

  function commentsOn(key: string): string[] {
    return router.jira.comments.filter((comment) => comment.key === key).map((c) => c.body);
  }

  async function status(key: string): Promise<string> {
    return (await router.jira.getIssue(key)).statusName;
  }

  it("moves the issue to in-progress when execution is granted, then to review on success", async () => {
    const envelope = await startJob("KAN-1");
    expect(await status("KAN-1")).toBe(REQUEST_STATUS);

    await process();
    expect(await status("KAN-1")).toBe(IN_PROGRESS_STATUS);

    await submit(envelope, { changes: ["src/a.ts"] });
    const pass = await process();
    expect(pass.blocked).toEqual([]);
    expect(await status("KAN-1")).toBe(REVIEW_STATUS);
    const comments = commentsOn("KAN-1");
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("Implementation completed.");
    expect(comments[0]).toContain("- src/a.ts");
    expect(comments[0]).toContain(`attempt: ${envelope.attemptId}`);

    // Nothing left to do: a second pass writes nothing.
    const again = await process();
    expect(again.applied).toEqual([]);
    expect(commentsOn("KAN-1")).toHaveLength(1);
  });

  it("does not journal the start move twice when start is replayed", async () => {
    const envelope = await startJob("KAN-1");
    await router.jobCall(worker, envelope.jobId, "start", lease(envelope));
    const steps = listJobReportSteps(router.db, envelope.jobId);
    expect(steps.map((step) => step.batchId)).toEqual([`start:${envelope.attemptId}`]);
  });

  it("keeps a failed issue in progress with a failure comment and label (ADR 0021)", async () => {
    const envelope = await startJob("KAN-1");
    await process();
    await submit(envelope, { status: "failed", summary: "broke", failureReason: "tests red" });
    await process();

    const issue = await router.jira.getIssue("KAN-1");
    expect(issue.statusName).toBe(IN_PROGRESS_STATUS);
    expect(issue.labels).toContain("ggjira-failed");
    expect(commentsOn("KAN-1")[0]).toContain("Failure Reason:\ntests red");
    expect(commentsOn("KAN-1")[0]).toContain(`move the issue back to "${REQUEST_STATUS}"`);
  });

  it("never overrides a status a human set while the job ran", async () => {
    const envelope = await startJob("KAN-1");
    await process();
    await router.jira.transitionIssueToStatus("KAN-1", "To Do");
    // Too late for Router to notice before the result lands.
    await submit(envelope);
    const pass = await process();

    expect(await status("KAN-1")).toBe("To Do");
    expect(pass.skipped.map((entry) => entry.reason).join("\n")).toContain("a human moved it");
  });

  it("settles an uncertain comment write by re-reading instead of posting twice", async () => {
    const envelope = await startJob("KAN-1");
    await submit(envelope);
    // The comment reaches Jira but the response is lost.
    const original = router.jira.addComment.bind(router.jira);
    let lose = true;
    router.jira.addComment = async (key, body) => {
      await original(key, body);
      if (lose) {
        lose = false;
        throw new TypeError("fetch failed");
      }
    };

    const first = await process();
    expect(first.deferred).toHaveLength(1);
    const uncertain = listJobReportSteps(router.db, envelope.jobId).find(
      (step) => step.kind === "comment",
    );
    expect(uncertain?.status).toBe("uncertain");

    await process();
    expect(commentsOn("KAN-1")).toHaveLength(1);
    expect(await status("KAN-1")).toBe(REVIEW_STATUS);
  });

  it("marks a step Jira definitively rejected as failed and blocks the rest of its batch", async () => {
    const envelope = await startJob("KAN-1");
    await process();
    await submit(envelope);
    router.jira.seedIssue(
      { ...(await router.jira.getIssue("KAN-1")) },
      // No transition to review exists any more.
      TRANSITIONS.filter((transition) => transition.toStatusName !== REVIEW_STATUS),
    );

    const pass = await process();
    expect(pass.blocked).toEqual([
      expect.objectContaining({ status: "failed", reason: expect.stringContaining(REVIEW_STATUS) }),
    ]);
    expect(listBlockedReportSteps(router.db).map((step) => step.kind)).toEqual(["transition"]);

    // An admin fixes the workflow and retries: only the Jira side effects run again.
    router.jira.seedIssue({ ...(await router.jira.getIssue("KAN-1")) }, TRANSITIONS);
    expect(
      retryReportBatch(router.db, {
        batchId: `result-${envelope.attemptId}`,
        actor: "admin",
        now: router.clock.now(),
      }),
    ).toBe(1);
    await process();
    expect(await status("KAN-1")).toBe(REVIEW_STATUS);
    expect(commentsOn("KAN-1")).toHaveLength(1);
    expect(listAudit(router.db, `result-${envelope.attemptId}`)[0]?.action).toBe("report.retried");
  });

  describe("planning results", () => {
    it("carries the planning context and PM prompt in the envelope", async () => {
      seedIssue("KAN-9", PLANNING_STATUS);
      router.jira.seedComment("KAN-9", { body: "Please keep it small", authorAccountId: "user-1" });
      await router.reconcile();
      const envelope = await reserve();
      expect(envelope.kind).toBe("planning");
      expect(envelope.systemPrompt).toContain("PM agent");
      expect(envelope.planningContext?.comments.map((c) => c.body)).toEqual([
        "Please keep it small",
      ]);
    });

    it("applies a plan: subtasks under the human owner, plan metadata, superseded leftovers, review", async () => {
      router.jira.seedIssue({
        key: "KAN-50",
        summary: "Old task",
        statusName: "To Do",
        parentKey: "KAN-9",
        projectKey: "KAN",
      });
      const envelope = await startJob("KAN-9", PLANNING_STATUS);
      await process();
      expect(await status("KAN-9")).toBe(IN_PROGRESS_STATUS);

      await submit(envelope, { status: "planned", summary: "Split", plan: twoTaskPlan });
      const pass = await process();
      expect(pass.blocked).toEqual([]);

      const created = router.jira.createdIssues;
      expect(created.map((input) => input.summary)).toEqual(["Build the API", "Build the UI"]);
      expect(created.every((input) => input.assigneeAccountId === "user-1")).toBe(true);
      expect(created.every((input) => input.parentKey === "KAN-9")).toBe(true);

      const [apiKey, uiKey] = (await router.jira.searchIssues('parent = "KAN-9"'))
        .filter((issue) => issue.key !== "KAN-50")
        .map((issue) => issue.key);
      const version = `plan-${envelope.attemptId}`;
      expect(router.jira.getStoredProperty(uiKey as string, PLAN_TASK_PROPERTY_KEY)).toEqual({
        planVersion: version,
        taskId: "ui",
        parentKey: "KAN-9",
        workspaceId: "ws1",
        dependencies: [apiKey],
      });
      expect(router.jira.getStoredProperty("KAN-9", PLAN_PROPERTY_KEY)).toEqual({
        version,
        taskIds: ["api", "ui"],
      });
      const uiDescription = (await router.jira.getIssue(uiKey as string)).description ?? "";
      expect(uiDescription.slice(uiDescription.indexOf("Dependencies"))).toContain(
        apiKey as string,
      );
      expect((await router.jira.getIssue("KAN-50")).labels).toContain("ggjira-superseded");
      expect((await router.jira.getIssue("KAN-9")).description).toContain("GGJIRA:PLAN:START");
      expect(await status("KAN-9")).toBe(REVIEW_STATUS);
      expect(commentsOn("KAN-9").at(-1)).toContain(`- ${apiKey}`);

      // Replaying the whole journal changes nothing.
      for (const step of listJobReportSteps(router.db, envelope.jobId)) {
        router.db.prepare("UPDATE report_steps SET status = 'pending' WHERE id = ?").run(step.id);
      }
      await process();
      expect(router.jira.createdIssues).toHaveLength(2);
      expect(commentsOn("KAN-9")).toHaveLength(1);
    });

    it("dispatches a created subtask only while its plan version is current", async () => {
      const envelope = await startJob("KAN-9", PLANNING_STATUS);
      await submit(envelope, { status: "planned", summary: "Split", plan: twoTaskPlan });
      await process();
      const apiKey = "KAN-1001";
      expect(router.jira.createdIssues[0]?.summary).toBe("Build the API");
      router.jira.seedIssue(
        { ...(await router.jira.getIssue(apiKey)), statusName: REQUEST_STATUS },
        TRANSITIONS,
      );

      const first = await router.reconcile();
      expect([...first.held, ...first.skipped]).toEqual([]);
      expect(getOpenJobForIssue(router.db, apiKey)).toBeDefined();

      // A replan moves the parent's plan on; the old task no longer counts as approved.
      await router.jira.setIssueProperty("KAN-9", PLAN_PROPERTY_KEY, {
        version: "plan-newer",
        taskIds: [],
      });
      const report = await router.reconcile();
      expect(report.skipped.map((entry) => entry.reason).join("\n")).toContain("plan-newer");
      expect(getOpenJobForIssue(router.db, apiKey)).toBeUndefined();
    });

    it("holds an unconfirmable subtask creation for an admin instead of re-sending it", async () => {
      const envelope = await startJob("KAN-9", PLANNING_STATUS);
      await process();
      await submit(envelope, { status: "planned", summary: "Split", plan: twoTaskPlan });
      const original = router.jira.createIssue.bind(router.jira);
      let fail = true;
      router.jira.createIssue = async (input) => {
        if (fail) {
          fail = false;
          throw new TypeError("fetch failed");
        }
        return original(input);
      };

      await process(); // uncertain
      const pass = await process(); // cannot find it by marker → recovery_required
      expect(pass.blocked).toEqual([expect.objectContaining({ status: "recovery_required" })]);
      expect(router.jira.createdIssues).toHaveLength(0);
      expect(await status("KAN-9")).toBe(IN_PROGRESS_STATUS);

      retryReportBatch(router.db, {
        batchId: `result-${envelope.attemptId}`,
        actor: "admin",
        now: router.clock.now(),
      });
      await process();
      expect(router.jira.createdIssues).toHaveLength(2);
      expect(await status("KAN-9")).toBe(REVIEW_STATUS);
    });

    it("posts a decision request and parks the issue in review without needsDecisionStatus", async () => {
      const envelope = await startJob("KAN-9", PLANNING_STATUS);
      await process();
      await submit(envelope, {
        status: "needs_decision",
        summary: "Two ways",
        plan: {
          needsDecision: true,
          summary: "Two ways",
          tasks: [],
          decision: {
            question: "SQL or NoSQL?",
            options: [
              { id: "A", title: "SQL" },
              { id: "B", title: "NoSQL" },
            ],
          },
        },
      });
      await process();

      const [comment] = commentsOn("KAN-9");
      expect(comment).toContain("[GGJIRA:DECISION-REQUEST]");
      expect(comment).toContain(`planVersion: plan-${envelope.attemptId}`);
      expect(comment).toContain(`move it back to "${PLANNING_STATUS}"`);
      expect(await status("KAN-9")).toBe(REVIEW_STATUS);
      expect(router.jira.createdIssues).toEqual([]);
    });

    it("reports a plan it must not apply as a failure, creating nothing", async () => {
      const envelope = await startJob("KAN-9", PLANNING_STATUS);
      await process();
      const cyclic = {
        ...twoTaskPlan,
        tasks: [{ ...twoTaskPlan.tasks[0], dependencies: ["ui"] }, twoTaskPlan.tasks[1]],
      };
      await submit(envelope, { status: "planned", summary: "Loop", plan: cyclic });
      await process();

      expect(router.jira.createdIssues).toEqual([]);
      expect(commentsOn("KAN-9")[0]).toContain("dependency cycle");
      expect((await router.jira.getIssue("KAN-9")).labels).toContain("ggjira-failed");
      expect(await status("KAN-9")).toBe(IN_PROGRESS_STATUS);
    });
  });

  describe("approval re-check once Router moves issues itself (ADR 0019 caveat)", () => {
    function verify() {
      return verifyActiveJobs({
        db: router.db,
        jira: router.jira,
        config: router.config,
        decisionProvider: new RuleDecisionProvider(router.config.executionAgent),
        now: router.clock.now,
      });
    }

    it("does not treat Router's own move to in-progress, or its comments, as a revocation", async () => {
      const envelope = await startJob("KAN-1");
      await process();
      expect(await status("KAN-1")).toBe(IN_PROGRESS_STATUS);
      await router.jira.addComment("KAN-1", "progress note");

      await router.reconcile(); // KAN-1 is no longer a candidate, but still approved
      const report = await verify();
      expect(report.jobsCancelRequested).toEqual([]);
      expect(getJob(router.db, envelope.jobId)?.state).toBe("running");
    });

    it("asks a running job to stop when a human moves its issue out of in-progress", async () => {
      const envelope = await startJob("KAN-1");
      await process();
      await router.jira.transitionIssueToStatus("KAN-1", "To Do");

      const report = await verify();
      expect(report.jobsCancelRequested).toEqual([envelope.jobId]);
      const heartbeat = await router.jobCall(worker, envelope.jobId, "heartbeat", lease(envelope));
      expect(heartbeat.json()).toMatchObject({ cancel: true });
    });

    it("leaves a job alone when Jira cannot be asked", async () => {
      const envelope = await startJob("KAN-1");
      router.jira.getIssue = async () => {
        throw new TypeError("fetch failed");
      };
      const report = await verify();
      expect(report.skipped[0]?.reason).toContain("approval re-check failed");
      expect(getJob(router.db, envelope.jobId)?.state).toBe("running");
    });
  });

  describe("recovery", () => {
    it("lets an admin release a recovery_required job, telling Jira nothing was applied", async () => {
      const envelope = await startJob("KAN-1");
      router.clock.advance(31_000);
      await router.heartbeat(worker.workerId, worker.token, worker.sessionId); // expires the lease
      expect(getJob(router.db, envelope.jobId)?.state).toBe("recovery_required");

      resolveRecoveryJob(router.db, router.config, {
        jobId: envelope.jobId,
        actor: "admin",
        now: router.clock.now(),
      });
      expect(getJob(router.db, envelope.jobId)?.state).toBe("cancelled");
      expect(listAudit(router.db, envelope.jobId).map((entry) => entry.action)).toEqual([
        "recovery.stop_confirmed",
        "job.resolved",
      ]);
      await process();
      expect(commentsOn("KAN-1").at(-1)).toContain(
        "An admin (admin) confirmed the run is stopped.",
      );
    });

    it("retries a failed job as a new attempt after re-checking its approval", async () => {
      const envelope = await startJob("KAN-1");
      await process();
      await submit(envelope, { status: "failed", summary: "broke" });
      await process();

      const deps = {
        db: router.db,
        jira: router.jira,
        config: router.config,
        now: router.clock.now,
      };
      const retried = await retryJob(deps, { jobId: envelope.jobId, actor: "admin" });
      expect(retried.state).toBe("queued");

      const next = await reserve("req-2");
      expect(next.jobId).toBe(envelope.jobId);
      expect(next.attemptId).not.toBe(envelope.attemptId);
      await router.jobCall(worker, next.jobId, "start", lease(next));
      await submit(next);
      await process();
      const issue = await router.jira.getIssue("KAN-1");
      expect(issue.statusName).toBe(REVIEW_STATUS);
      expect(issue.labels).not.toContain("ggjira-failed");
    });

    it("refuses to retry a job whose issue a human moved away", async () => {
      const envelope = await startJob("KAN-1");
      await process();
      await submit(envelope, { status: "failed", summary: "broke" });
      await router.jira.transitionIssueToStatus("KAN-1", "To Do");

      await expect(
        retryJob(
          { db: router.db, jira: router.jira, config: router.config, now: router.clock.now },
          { jobId: envelope.jobId, actor: "admin" },
        ),
      ).rejects.toBeInstanceOf(RecoveryError);
      expect(getJob(router.db, envelope.jobId)?.state).toBe("failed");
    });

    it("closes a failed job and dispatches a fresh one when a human re-requests the issue", async () => {
      const envelope = await startJob("KAN-1");
      await process();
      await submit(envelope, { status: "failed", summary: "broke" });
      await process();

      await router.jira.transitionIssueToStatus("KAN-1", REQUEST_STATUS);
      await router.reconcile();

      expect(getJob(router.db, envelope.jobId)?.state).toBe("cancelled");
      const fresh = getOpenJobForIssue(router.db, "KAN-1");
      expect(fresh?.id).not.toBe(envelope.jobId);
      expect(fresh?.state).toBe("queued");
    });
  });
});
