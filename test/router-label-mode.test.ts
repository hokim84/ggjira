import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JobEnvelope } from "../src/contracts/envelope.js";
import { PROTOCOL_VERSION } from "../src/contracts/protocol.js";
import { renderSections } from "../src/issue/description.js";
import { getJob, getOpenJobForIssue } from "../src/router/db/jobs.js";
import { listOpenReadinessHolds } from "../src/router/db/readiness-holds.js";
import { listJobReportSteps } from "../src/router/db/report-steps.js";
import { RuleDecisionProvider } from "../src/router/decision.js";
import { processReportJournal } from "../src/router/report-processor.js";
import { verifyActiveJobs } from "../src/router/scheduler.js";
import {
  issueDescription,
  LABEL_IN_PROGRESS_STATUS,
  LABEL_REVIEW_STATUS,
  LABEL_TRANSITIONS,
  labelWorkspace,
  OPT_IN_LABEL,
  TODO_STATUS,
} from "./helpers/router-fixtures.js";
import { type RegisteredWorker, RouterHarness } from "./helpers/router-harness.js";

/** A request with no Acceptance Criteria/Verification: the PM fills its contract in first. */
const NO_CONTRACT = renderSections([{ heading: "Required Capabilities", items: ["programming"] }]);

function lease(envelope: JobEnvelope) {
  return { attemptId: envelope.attemptId, leaseToken: envelope.leaseToken };
}

/**
 * ADR 0037: a `label`-mode workspace on the ordinary To Do / In Progress / Review / Done workflow,
 * driven end to end through Router's scheduler, Worker API and Jira journal (decision table rows).
 */
describe("label mode (ADR 0037)", () => {
  let router: RouterHarness;
  let worker: RegisteredWorker;

  beforeEach(async () => {
    router = new RouterHarness({ config: { workspaces: [labelWorkspace] } });
    worker = await router.connectWorker("worker-1");
  });

  afterEach(async () => {
    await router.close();
  });

  /** An issue in To Do; `optIn` adds the label the way a human does (a changelog entry). */
  async function seed(
    key: string,
    opts: { optIn?: boolean; description?: string; isSubtask?: boolean } = {},
  ): Promise<void> {
    router.jira.seedIssue(
      {
        key,
        summary: `Work on ${key}`,
        statusName: TODO_STATUS,
        projectKey: "KAN",
        assigneeAccountId: "user-1",
        description: opts.description ?? issueDescription(),
        ...(opts.isSubtask ? { isSubtask: true } : {}),
      },
      LABEL_TRANSITIONS,
    );
    if (opts.optIn ?? true) await router.jira.addLabel(key, OPT_IN_LABEL);
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

  async function startJob(key: string): Promise<JobEnvelope> {
    await router.reconcile();
    const response = await router.next(worker, `req-${key}-${Date.now()}`);
    expect(response.statusCode).toBe(200);
    const envelope = response.json() as JobEnvelope;
    const start = await router.jobCall(worker, envelope.jobId, "start", lease(envelope));
    expect(start.json()).toMatchObject({ granted: true });
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

  async function status(key: string): Promise<string> {
    return (await router.jira.getIssue(key)).statusName;
  }

  function commentsOn(key: string): string[] {
    return router.jira.comments.filter((comment) => comment.key === key).map((c) => c.body);
  }

  it("picks up only To Do issues that carry the opt-in label (T01)", async () => {
    await seed("KAN-1", { optIn: false });
    await seed("KAN-2");

    const report = await router.reconcile();

    expect(report.candidatesSeen).toBe(1);
    expect(getOpenJobForIssue(router.db, "KAN-1")).toBeUndefined();
    expect(getOpenJobForIssue(router.db, "KAN-2")?.kind).toBe("implementation");
  });

  it("plans a request that has no contract, but holds a subtask without one (T02)", async () => {
    await seed("KAN-1", { description: NO_CONTRACT });
    await seed("KAN-2", { description: NO_CONTRACT, isSubtask: true });

    await router.reconcile();
    await router.reconcile();

    expect(getOpenJobForIssue(router.db, "KAN-1")?.kind).toBe("planning");
    expect(getOpenJobForIssue(router.db, "KAN-2")).toBeUndefined();
    const holds = listOpenReadinessHolds(router.db);
    expect(holds.map((hold) => [hold.issueKey, hold.seenCount])).toEqual([["KAN-2", 2]]);
  });

  it("moves To Do → In Progress → Review, and Review → To Do is a new approval (T03)", async () => {
    await seed("KAN-1");
    const envelope = await startJob("KAN-1");
    await process();
    expect(await status("KAN-1")).toBe(LABEL_IN_PROGRESS_STATUS);
    const [startStep] = listJobReportSteps(router.db, envelope.jobId);
    expect(startStep?.params).toMatchObject({
      approvalStatus: TODO_STATUS,
      optInLabel: OPT_IN_LABEL,
    });

    await submit(envelope);
    expect((await process()).blocked).toEqual([]);
    expect(await status("KAN-1")).toBe(LABEL_REVIEW_STATUS);
    const firstApproval = getJob(router.db, envelope.jobId)?.approvalId;

    // Review → To Do for rework: the label is still there, the status entry is new.
    await router.jira.transitionIssueToStatus("KAN-1", TODO_STATUS);
    await router.reconcile();
    const rework = getOpenJobForIssue(router.db, "KAN-1");
    expect(rework?.state).toBe("queued");
    expect(rework?.approvalId).not.toBe(firstApproval);
  });

  it("cancels a queued job when the label is removed; adding it back is a new approval (T05)", async () => {
    await seed("KAN-1");
    await router.reconcile();
    const queued = getOpenJobForIssue(router.db, "KAN-1");
    expect(queued?.state).toBe("queued");

    await router.jira.removeLabel("KAN-1", OPT_IN_LABEL);
    const report = await router.reconcile();
    expect(report.jobsCancelled).toEqual([queued?.id]);
    expect(getOpenJobForIssue(router.db, "KAN-1")).toBeUndefined();

    await router.jira.addLabel("KAN-1", OPT_IN_LABEL);
    await router.reconcile();
    const again = getOpenJobForIssue(router.db, "KAN-1");
    expect(again?.id).not.toBe(queued?.id);
    expect(again?.approvalId).not.toBe(queued?.approvalId);
  });

  it("asks a running job to stop and refuses commit once the label is removed (T05)", async () => {
    await seed("KAN-1");
    const envelope = await startJob("KAN-1");
    await process();

    await router.jira.removeLabel("KAN-1", OPT_IN_LABEL);
    const report = await verify();

    expect(report.jobsCancelRequested).toEqual([envelope.jobId]);
    const authorize = await router.jobCall(worker, envelope.jobId, "authorize", lease(envelope), {
      stage: "commit",
    });
    expect(authorize.json()).toMatchObject({ authorized: false });
    // The issue stays where it is: removing the label never moves it.
    expect(await status("KAN-1")).toBe(LABEL_IN_PROGRESS_STATUS);
  });

  it("leaves a decision request In Progress and never re-runs it under the same approval", async () => {
    await seed("KAN-1");
    const envelope = await startJob("KAN-1");
    await process();

    await submit(envelope, {
      status: "needs_decision",
      summary: "A migration is needed",
      implementation: {
        outcome: "needs_decision",
        summary: "A migration is needed",
        scopeDeviations: [{ description: "Schema change", reason: "the API needs it" }],
        decision: {
          question: "Add a column to users?",
          options: [
            { id: "a", title: "Add the column" },
            { id: "b", title: "Derive it at read time" },
          ],
          recommendation: "b",
          impact: "A migration is outside this ticket's scope.",
        },
        verification: [],
      },
    });
    expect((await process()).blocked).toEqual([]);

    expect(await status("KAN-1")).toBe(LABEL_IN_PROGRESS_STATUS);
    expect(commentsOn("KAN-1").join("\n")).toContain(`"${TODO_STATUS}"`);
    const steps = listJobReportSteps(router.db, envelope.jobId);
    expect(steps.filter((step) => step.kind === "transition")).toHaveLength(1); // the start only

    const report = await router.reconcile();
    expect(report.jobsCreated).toEqual([]);
  });

  it("keeps a failed issue In Progress with the failure label, and does not retry it", async () => {
    await seed("KAN-1");
    const envelope = await startJob("KAN-1");
    await process();
    await submit(envelope, { status: "failed", summary: "broke", failureReason: "tests red" });
    await process();

    const issue = await router.jira.getIssue("KAN-1");
    expect(issue.statusName).toBe(LABEL_IN_PROGRESS_STATUS);
    expect(issue.labels).toEqual([OPT_IN_LABEL, "ggjira-failed"]);
    expect((await router.reconcile()).jobsCreated).toEqual([]);
  });

  it("implements a planned request once the PM filled its contract and it is requested again", async () => {
    await seed("KAN-1", { description: NO_CONTRACT });
    const envelope = await startJob("KAN-1");
    expect(envelope.kind).toBe("planning");
    await process();

    await submit(envelope, {
      status: "planned",
      summary: "One outcome; contract filled in",
      plan: {
        needsDecision: false,
        summary: "One outcome; contract filled in",
        acceptanceCriteria: ["The button says Save"],
        verification: ["Open the form and read the button"],
        requiredCapabilities: ["programming"],
        tasks: [],
        keepTaskKeys: [],
      },
    });
    expect((await process()).blocked).toEqual([]);
    expect(await status("KAN-1")).toBe(LABEL_REVIEW_STATUS);

    // The human reviews the contract and requests the work from To Do.
    await router.jira.transitionIssueToStatus("KAN-1", TODO_STATUS);
    await router.reconcile();
    expect(getOpenJobForIssue(router.db, "KAN-1")?.kind).toBe("implementation");
  });

  it("re-plans a parent that was split into tasks when it is requested again", async () => {
    await seed("KAN-1");
    await router.jira.setIssueProperty("KAN-1", "ggjira.plan", {
      version: "plan-old",
      taskIds: ["api", "ui"],
    });

    await router.reconcile();

    expect(getOpenJobForIssue(router.db, "KAN-1")?.kind).toBe("planning");
  });

  it("creates nothing new when Router's own writes trigger another pass", async () => {
    await seed("KAN-1");
    const envelope = await startJob("KAN-1");
    await process();
    await submit(envelope);
    await process();
    const comments = commentsOn("KAN-1").length;

    const first = await router.reconcile();
    const second = await router.reconcile();
    await process();

    expect([...first.jobsCreated, ...second.jobsCreated]).toEqual([]);
    expect(commentsOn("KAN-1")).toHaveLength(comments);
  });
});
