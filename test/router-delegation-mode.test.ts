import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JobEnvelope } from "../src/contracts/envelope.js";
import { PROTOCOL_VERSION } from "../src/contracts/protocol.js";
import { listAttentionItems } from "../src/router/db/attention.js";
import { getJob, getOpenJobForIssue } from "../src/router/db/jobs.js";
import { getLatestPlanReview, listPlanDeployments } from "../src/router/db/plan-delegation.js";
import { listJobReportSteps } from "../src/router/db/report-steps.js";
import { RuleDecisionProvider } from "../src/router/decision.js";
import { handlePullRequestClosed } from "../src/router/github.js";
import { processReportJournal } from "../src/router/report-processor.js";
import { verifyActiveJobs } from "../src/router/scheduler.js";
import {
  DELEGATION_DONE_STATUS,
  DELEGATION_REQUEST_STATUS,
  DELEGATION_TODO_STATUS,
  DELEGATION_TRANSITIONS,
  delegationWorkspace,
  issueDescription,
  PLAN_REVIEW_STATUS,
  RESULT_REVIEW_STATUS,
  SHARED_IN_PROGRESS_STATUS,
} from "./helpers/router-fixtures.js";
import { type RegisteredWorker, RouterHarness } from "./helpers/router-harness.js";

function lease(envelope: JobEnvelope) {
  return { attemptId: envelope.attemptId, leaseToken: envelope.leaseToken };
}

/** A plan that keeps the work in the issue itself and fills its contract in. */
const SINGLE_PLAN = {
  needsDecision: false,
  summary: "One outcome; contract filled in",
  acceptanceCriteria: ["The button says Save"],
  verification: ["Open the form and read the button"],
  requiredCapabilities: ["programming"],
  tasks: [],
  keepTaskKeys: [],
};

/** A plan that splits the issue into an API task and a UI task that depends on it. */
const SPLIT_PLAN = {
  needsDecision: false,
  summary: "Split into API and UI",
  tasks: [
    {
      taskId: "api",
      title: "Build the API",
      description: "Endpoints",
      acceptance: ["returns 200"],
      verification: ["npm run test -- api"],
      requiredCapabilities: ["programming"],
    },
    {
      taskId: "ui",
      title: "Build the UI",
      description: "Screens",
      acceptance: ["shows the list"],
      verification: ["npm run test -- ui"],
      dependencies: ["api"],
      requiredCapabilities: ["programming"],
    },
  ],
  keepTaskKeys: [],
};

const DECISION_PLAN = {
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
};

/**
 * ADR 0044: a `delegation`-mode workspace — delegated by moving the issue, always planned first,
 * approved by moving the plan from review to the shared in-progress status. Driven end to end
 * through Router's scheduler, Worker API and Jira journal, one test per scenario of
 * docs/M4_STATUS_DELEGATION_CHANGE_REVIEW.md §5.
 */
describe("delegation mode (ADR 0044)", () => {
  let router: RouterHarness;
  let worker: RegisteredWorker;
  let requestCounter = 0;

  beforeEach(async () => {
    router = new RouterHarness({ config: { workspaces: [delegationWorkspace] } });
    router.jira.setCreatedIssueTransitions(DELEGATION_TRANSITIONS);
    worker = await router.connectWorker("worker-1");
  });

  afterEach(async () => {
    await router.close();
  });

  function seed(
    key: string,
    opts: { status?: string; description?: string; parentKey?: string; labels?: string[] } = {},
  ): void {
    router.jira.seedIssue(
      {
        key,
        summary: `Work on ${key}`,
        statusName: opts.status ?? DELEGATION_TODO_STATUS,
        projectKey: "KAN",
        assigneeAccountId: "user-1",
        description: opts.description ?? issueDescription(),
        labels: opts.labels ?? [],
        ...(opts.parentKey
          ? { parentKey: opts.parentKey, isSubtask: true, issueTypeName: "Sub-task" }
          : {}),
      },
      DELEGATION_TRANSITIONS,
    );
  }

  /** A human drag on the board: a status move recorded in the changelog. */
  function move(key: string, status: string): Promise<void> {
    return router.jira.transitionIssueToStatus(key, status);
  }

  function process() {
    return processReportJournal({ db: router.db, jira: router.jira, now: router.clock.now });
  }

  function verify() {
    return verifyActiveJobs({
      db: router.db,
      jira: router.jira,
      config: router.config,
      decisionProvider: new RuleDecisionProvider(router.config.executionAgent),
      now: router.clock.now,
    });
  }

  /** Leases whatever is queued to the worker and starts it. */
  async function nextAndStart(): Promise<JobEnvelope> {
    requestCounter += 1;
    const response = await router.next(worker, `req-${requestCounter}`);
    expect(response.statusCode).toBe(200);
    const envelope = response.json() as JobEnvelope;
    const start = await router.jobCall(worker, envelope.jobId, "start", lease(envelope));
    expect(start.json()).toMatchObject({ granted: true });
    return envelope;
  }

  async function startJob(): Promise<JobEnvelope> {
    await router.reconcile();
    return nextAndStart();
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

  async function status(key: string): Promise<string> {
    return (await router.jira.getIssue(key)).statusName;
  }

  function commentsOn(key: string): string[] {
    return router.jira.comments.filter((comment) => comment.key === key).map((c) => c.body);
  }

  function jobsFor(key: string): Array<{ id: string; kind: string; state: string }> {
    return router.db
      .prepare("SELECT id, kind, state FROM jobs WHERE issue_key = ? ORDER BY rowid")
      .all(key) as Array<{ id: string; kind: string; state: string }>;
  }

  /** Requests a plan for `key`, has the worker return `plan`, and applies it to Jira. */
  async function planned(key: string, plan: Record<string, unknown>): Promise<JobEnvelope> {
    await move(key, DELEGATION_REQUEST_STATUS);
    const envelope = await startJob();
    expect(envelope.kind).toBe("planning");
    await submit(envelope, {
      status: plan.needsDecision ? "needs_decision" : "planned",
      summary: plan.summary,
      plan,
    });
    expect((await process()).blocked).toEqual([]);
    return envelope;
  }

  /** The human approves the plan: from plan review to the shared in-progress status. */
  async function approve(key: string): Promise<void> {
    await move(key, SHARED_IN_PROGRESS_STATUS);
    await router.reconcile();
    expect((await process()).blocked).toEqual([]);
  }

  it("never plans, runs or withdraws anything because of a label (1)", async () => {
    seed("KAN-1", { labels: ["ai-enabled"] });
    await router.jira.removeLabel("KAN-1", "ai-enabled");
    await router.jira.addLabel("KAN-1", "ai-enabled");
    expect((await router.reconcile()).jobsCreated).toEqual([]);

    // A running plan is not withdrawn by a label either.
    await move("KAN-1", DELEGATION_REQUEST_STATUS);
    const envelope = await startJob();
    await router.jira.removeLabel("KAN-1", "ai-enabled");
    await router.jira.addLabel("KAN-1", "other");
    const report = await verify();
    expect(report.jobsCancelRequested).toEqual([]);
    expect(getJob(router.db, envelope.jobId)?.state).toBe("running");
  });

  it("makes one planning job for a request, even with a full contract, and never retries a failed plan (2)", async () => {
    seed("KAN-1");
    await move("KAN-1", DELEGATION_REQUEST_STATUS);
    await router.reconcile();
    await router.reconcile();
    expect(jobsFor("KAN-1").map((job) => job.kind)).toEqual(["planning"]);

    const envelope = await nextAndStart();
    await process();
    // Planning happens in the request status: the start moves nothing, the card says it runs.
    expect(await status("KAN-1")).toBe(DELEGATION_REQUEST_STATUS);
    expect(commentsOn("KAN-1").join("\n")).toContain("GGJIRA started planning this request");

    await submit(envelope, { status: "failed", summary: "broke", failureReason: "no idea" });
    await process();
    const issue = await router.jira.getIssue("KAN-1");
    expect(issue.statusName).toBe(DELEGATION_REQUEST_STATUS);
    expect(issue.labels).toEqual(["ggjira-failed"]);
    expect(commentsOn("KAN-1").join("\n")).toContain(
      `the issue stays in "${DELEGATION_REQUEST_STATUS}"`,
    );
    expect((await router.reconcile()).jobsCreated).toEqual([]);
    expect((await router.reconcile()).jobsCreated).toEqual([]);
  });

  it("treats request → withdraw → request as two delegations, and replays as one (3)", async () => {
    seed("KAN-1");
    await move("KAN-1", DELEGATION_REQUEST_STATUS);
    await router.reconcile();
    const first = getOpenJobForIssue(router.db, "KAN-1");

    await move("KAN-1", DELEGATION_TODO_STATUS);
    expect((await router.reconcile()).jobsCancelled).toEqual([first?.id]);
    await move("KAN-1", DELEGATION_REQUEST_STATUS);
    await router.reconcile();
    const second = getOpenJobForIssue(router.db, "KAN-1");
    expect(second?.id).not.toBe(first?.id);
    expect(second?.approvalId).not.toBe(first?.approvalId);

    // A redelivered webhook, a restart and the background poll all find the same request.
    await router.restart();
    await router.reconcile();
    await router.reconcile();
    expect(jobsFor("KAN-1").filter((job) => job.state !== "cancelled")).toHaveLength(1);
  });

  it("plans a delegated subtask, but not into subtasks of its own", async () => {
    seed("KAN-1");
    seed("KAN-2", { parentKey: "KAN-1" });
    await move("KAN-2", DELEGATION_REQUEST_STATUS);
    const envelope = await startJob();
    expect(envelope.kind).toBe("planning");
    await submit(envelope, { status: "planned", summary: SPLIT_PLAN.summary, plan: SPLIT_PLAN });
    await process();

    expect(router.jira.createdIssues).toEqual([]);
    expect(await status("KAN-2")).toBe(DELEGATION_REQUEST_STATUS);
    expect(commentsOn("KAN-2").join("\n")).toContain("is a subtask");
    expect(getLatestPlanReview(router.db, "KAN-2")?.outcome).toBe("not_applied");
  });

  it("puts a finished plan in plan review and starts nothing (4)", async () => {
    seed("KAN-1");
    const envelope = await planned("KAN-1", SINGLE_PLAN);

    expect(await status("KAN-1")).toBe(PLAN_REVIEW_STATUS);
    const comments = commentsOn("KAN-1").join("\n");
    expect(comments).toContain("Plan applied.");
    expect(comments).toContain(
      `To approve this plan: move the issue from "${PLAN_REVIEW_STATUS}" to "${SHARED_IN_PROGRESS_STATUS}".`,
    );
    expect(getLatestPlanReview(router.db, "KAN-1")).toMatchObject({
      outcome: "planned",
      planVersion: `plan-${envelope.attemptId}`,
      taskIds: [],
    });
    expect((await router.reconcile()).jobsCreated).toEqual([]);
    expect(listPlanDeployments(router.db, "KAN-1")).toEqual([]);
  });

  it("runs nothing when a human moves their own issue from To Do to In Progress (5)", async () => {
    seed("KAN-1");
    await move("KAN-1", SHARED_IN_PROGRESS_STATUS);
    // Even from plan review: without a plan Router applied, it is just a person's move.
    seed("KAN-2", { status: PLAN_REVIEW_STATUS });
    await move("KAN-2", SHARED_IN_PROGRESS_STATUS);

    const report = await router.reconcile();
    expect(report.jobsCreated).toEqual([]);
    expect(report.candidatesSeen).toBe(0);
    expect(router.jira.comments).toEqual([]);
  });

  it("deploys the current plan on approval and implements the issue itself (6)", async () => {
    seed("KAN-1");
    await planned("KAN-1", SINGLE_PLAN);
    await approve("KAN-1");

    const [deployment] = listPlanDeployments(router.db, "KAN-1");
    expect(deployment).toMatchObject({ state: "active", taskIds: [] });
    expect(commentsOn("KAN-1").join("\n")).toContain("approved: GGJIRA recorded the move");
    await router.reconcile();
    const job = getOpenJobForIssue(router.db, "KAN-1");
    expect(job).toMatchObject({ kind: "implementation", approvalId: deployment?.approvalId });

    const envelope = await nextAndStart();
    await process();
    expect(await status("KAN-1")).toBe(SHARED_IN_PROGRESS_STATUS);
    // A valid AI run in the shared status is not withdrawn by being there (9).
    expect((await verify()).jobsCancelRequested).toEqual([]);

    await submit(envelope);
    expect((await process()).blocked).toEqual([]);
    expect(await status("KAN-1")).toBe(RESULT_REVIEW_STATUS);
    await router.reconcile();
    // Router's own move to review completes the plan; it is not a withdrawal (10).
    expect(listPlanDeployments(router.db, "KAN-1")[0]?.state).toBe("completed");
    expect((await router.reconcile()).jobsCreated).toEqual([]);
  });

  it("does not approve a plan that waits for a decision (6)", async () => {
    seed("KAN-1");
    await planned("KAN-1", DECISION_PLAN);
    expect(await status("KAN-1")).toBe(PLAN_REVIEW_STATUS);
    expect(commentsOn("KAN-1").join("\n")).toContain(
      `move it back to "${DELEGATION_REQUEST_STATUS}"`,
    );

    await move("KAN-1", SHARED_IN_PROGRESS_STATUS);
    await router.reconcile();
    await router.reconcile();
    await process();

    expect(listPlanDeployments(router.db, "KAN-1")).toEqual([]);
    expect(getOpenJobForIssue(router.db, "KAN-1")).toBeUndefined();
    const refusals = commentsOn("KAN-1").filter((body) => body.includes("did not take the move"));
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain("answer the decision request");
    expect(
      listAttentionItems(router.db, { status: "open", kind: "plan_approval_refused" }),
    ).toHaveLength(1);
  });

  it("does not approve a plan for an earlier request (6)", async () => {
    seed("KAN-1");
    await planned("KAN-1", SINGLE_PLAN);
    // Requested again, then dragged on before the new plan exists.
    await move("KAN-1", DELEGATION_REQUEST_STATUS);
    await router.reconcile();
    await move("KAN-1", PLAN_REVIEW_STATUS);
    await move("KAN-1", SHARED_IN_PROGRESS_STATUS);
    await router.reconcile();
    await process();

    expect(listPlanDeployments(router.db, "KAN-1")).toEqual([]);
    expect(jobsFor("KAN-1").filter((job) => job.kind === "implementation")).toEqual([]);
    expect(commentsOn("KAN-1").join("\n")).toContain("answers an earlier request");
  });

  it("waits for a plan still being applied, then deploys it once, through restarts (7)", async () => {
    seed("KAN-1");
    await move("KAN-1", DELEGATION_REQUEST_STATUS);
    const envelope = await startJob();
    await submit(envelope, { status: "planned", summary: SPLIT_PLAN.summary, plan: SPLIT_PLAN });
    // The human approves before Router has written the plan to Jira.
    await move("KAN-1", PLAN_REVIEW_STATUS);
    await move("KAN-1", SHARED_IN_PROGRESS_STATUS);
    const early = await router.reconcile();
    expect(early.held.map((held) => held.reason).join("\n")).toContain("not fully applied");
    expect(listPlanDeployments(router.db, "KAN-1")[0]?.state).toBe("waiting_plan_apply");

    await process();
    // The plan's own move to plan review gave way to the human's move.
    expect(await status("KAN-1")).toBe(SHARED_IN_PROGRESS_STATUS);
    await router.restart();
    await router.reconcile();
    await router.reconcile();
    await process();

    expect(listPlanDeployments(router.db, "KAN-1")).toHaveLength(1);
    expect(listPlanDeployments(router.db, "KAN-1")[0]?.state).toBe("active");
    expect(router.jira.createdIssues).toHaveLength(2);
    const approvals = commentsOn("KAN-1").filter((body) => body.includes("approved: GGJIRA"));
    expect(approvals).toHaveLength(1);
  });

  it("runs the tasks of an approved plan without planning them again, and finishes the parent (7, 8)", async () => {
    seed("KAN-1");
    await planned("KAN-1", SPLIT_PLAN);
    const [apiKey, uiKey] = ["KAN-1001", "KAN-1002"];
    // Created wherever Jira starts a new subtask (the fake: "To Do").
    expect(await status(apiKey)).toBe("To Do");
    // A subtask a person added by hand, in progress, is never taken.
    seed("KAN-50", { parentKey: "KAN-1", status: SHARED_IN_PROGRESS_STATUS });
    // Before the approval nothing runs, not even the tasks.
    expect((await router.reconcile()).jobsCreated).toEqual([]);

    await approve("KAN-1");
    expect(await status(apiKey)).toBe(SHARED_IN_PROGRESS_STATUS);
    expect(await status(uiKey)).toBe(SHARED_IN_PROGRESS_STATUS);
    await router.reconcile();
    await router.reconcile();

    expect(getOpenJobForIssue(router.db, "KAN-1")).toBeUndefined();
    expect(getOpenJobForIssue(router.db, "KAN-50")).toBeUndefined();
    expect(getOpenJobForIssue(router.db, apiKey)).toMatchObject({
      kind: "implementation",
      state: "queued",
    });
    expect(getOpenJobForIssue(router.db, uiKey)).toMatchObject({ state: "waiting" });

    const api = await nextAndStart();
    await submit(api);
    await process();
    expect(await status(apiKey)).toBe(RESULT_REVIEW_STATUS);
    // Review alone does not complete a dependency.
    await router.reconcile();
    expect(getOpenJobForIssue(router.db, uiKey)?.state).toBe("waiting");

    await move(apiKey, DELEGATION_DONE_STATUS);
    await router.reconcile();
    expect(getOpenJobForIssue(router.db, uiKey)?.state).toBe("queued");
    const ui = await nextAndStart();
    await submit(ui);
    await process();
    await move(uiKey, DELEGATION_DONE_STATUS);
    await router.reconcile();
    expect((await process()).blocked).toEqual([]);

    expect(await status("KAN-1")).toBe(RESULT_REVIEW_STATUS);
    expect(listPlanDeployments(router.db, "KAN-1")[0]?.state).toBe("completed");
    expect(commentsOn("KAN-1").join("\n")).toContain("All subtasks of the approved plan are done");
    expect(jobsFor("KAN-1").map((job) => job.kind)).toEqual(["planning"]);
    expect(jobsFor(apiKey).map((job) => job.kind)).toEqual(["implementation"]);
  });

  it("withdraws a plan when its parent leaves in progress, and the late result changes nothing (10)", async () => {
    seed("KAN-1");
    await planned("KAN-1", SPLIT_PLAN);
    await approve("KAN-1");
    await router.reconcile();
    const api = await nextAndStart();
    await process();

    await move("KAN-1", DELEGATION_TODO_STATUS);
    await router.reconcile();
    expect(listPlanDeployments(router.db, "KAN-1")[0]?.state).toBe("revoked");
    expect(getJob(router.db, api.jobId)?.state).toBe("cancel_requested");
    const authorize = await router.jobCall(worker, api.jobId, "authorize", lease(api), {
      stage: "commit",
    });
    expect(authorize.json()).toMatchObject({ authorized: false });

    await submit(api);
    await process();
    expect(getJob(router.db, api.jobId)?.state).toBe("cancelled");
    expect(await status("KAN-1001")).toBe(SHARED_IN_PROGRESS_STATUS);
    // Moving it back is not a new approval of the old plan: only plan review → in progress is.
    await move("KAN-1", SHARED_IN_PROGRESS_STATUS);
    expect((await router.reconcile()).jobsCreated).toEqual([]);
  });

  it("asks a running implementation to stop when the issue is taken back (10)", async () => {
    seed("KAN-1");
    await planned("KAN-1", SINGLE_PLAN);
    await approve("KAN-1");
    const envelope = await startJob();

    await move("KAN-1", DELEGATION_DONE_STATUS);
    expect((await verify()).jobsCancelRequested).toEqual([envelope.jobId]);
    await submit(envelope);
    await process();
    expect(await status("KAN-1")).toBe(DELEGATION_DONE_STATUS);
    const finish = listJobReportSteps(router.db, envelope.jobId).filter(
      (step) => step.kind === "transition",
    );
    expect(finish).toEqual([]);
  });

  it("shows where an issue stands in the admin view, and has no label toggle", async () => {
    seed("KAN-1");
    const stage = async () =>
      (
        (await router.adminCall("GET", "/issues/KAN-1/opt-in")).json() as {
          mode: string;
          delegation: { stage: string; plan: { taskIds: string[] } | null };
        }
      ).delegation;
    expect((await stage()).stage).toBe("not_delegated");

    await planned("KAN-1", SPLIT_PLAN);
    expect(await stage()).toMatchObject({ stage: "plan_review", plan: { taskIds: ["api", "ui"] } });
    await approve("KAN-1");
    expect((await stage()).stage).toBe("coordinating");

    const toggle = await router.adminCall("PUT", "/issues/KAN-1/opt-in", { enabled: true });
    expect(toggle.statusCode).toBe(409);
    expect(toggle.json()).toMatchObject({ error: "not_label_mode" });
  });

  it("says why a run failed and what to do; removing the label resumes nothing (11)", async () => {
    seed("KAN-1");
    await planned("KAN-1", SINGLE_PLAN);
    await approve("KAN-1");
    const envelope = await startJob();
    await submit(envelope, { status: "failed", summary: "broke", failureReason: "tests red" });
    await process();

    const failure = commentsOn("KAN-1").find(
      (body) => body.startsWith("[GGJIRA:REPORT") && body.includes("Execution failed."),
    );
    expect(failure).toContain(`stays in "${SHARED_IN_PROGRESS_STATUS}"`);
    expect(failure).toContain(
      `Next: fix the cause, then move the issue to "${PLAN_REVIEW_STATUS}" and then to "${SHARED_IN_PROGRESS_STATUS}"`,
    );
    await router.jira.removeLabel("KAN-1", "ggjira-failed");
    expect((await router.reconcile()).jobsCreated).toEqual([]);

    // Re-approving the same plan is a new, in-scope run of it.
    await move("KAN-1", PLAN_REVIEW_STATUS);
    await approve("KAN-1");
    await router.reconcile();
    const retry = getOpenJobForIssue(router.db, "KAN-1");
    expect(retry).toMatchObject({ kind: "implementation", state: "queued" });
    expect(retry?.approvalId).not.toBe(getJob(router.db, envelope.jobId)?.approvalId);
    expect(listPlanDeployments(router.db, "KAN-1").map((d) => d.state)).toEqual([
      "active",
      "revoked",
    ]);
  });

  it("moves review → done when the reviewed pull request is merged (12)", async () => {
    seed("KAN-1");
    await planned("KAN-1", SINGLE_PLAN);
    await approve("KAN-1");
    const envelope = await startJob();
    const head = "c".repeat(40);
    await submit(envelope, {
      branch: "ggjira/KAN-1-x",
      pullRequest: { repo: "acme/app", number: 7, url: "https://github.com/acme/app/pull/7" },
      git: { repository: "git", baseSha: "a".repeat(40), headSha: head, committed: true },
    });
    await process();
    expect(await status("KAN-1")).toBe(RESULT_REVIEW_STATUS);

    handlePullRequestClosed(
      router.db,
      router.config,
      { repo: "acme/app", number: 7, merged: true, by: "lead", headSha: head },
      router.clock.now(),
    );
    expect((await process()).blocked).toEqual([]);
    expect(await status("KAN-1")).toBe(DELEGATION_DONE_STATUS);
    await router.reconcile();
    expect(getLatestPlanReview(router.db, "KAN-1")?.closedAt).not.toBeNull();
    expect((await router.reconcile()).jobsCreated).toEqual([]);
  });

  it("creates nothing new when Router's own writes trigger another pass", async () => {
    seed("KAN-1");
    await planned("KAN-1", SPLIT_PLAN);
    await approve("KAN-1");
    const comments = router.jira.comments.length;

    const first = await router.reconcile();
    const second = await router.reconcile();
    await process();
    const third = await router.reconcile();

    expect(first.jobsCreated).toHaveLength(2);
    expect([...second.jobsCreated, ...third.jobsCreated]).toEqual([]);
    expect(router.jira.comments).toHaveLength(comments);
  });
});
