import type Database from "better-sqlite3";
import { JiraApiError } from "../jira/client.js";
import type { JiraIssue } from "../jira/types.js";
import {
  PLAN_PROPERTY_KEY,
  PlanMetadataError,
  PlanMetadataSchema,
  readPlanTaskMetadata,
} from "../pm/metadata.js";
import { computeDelegationApprovalIds } from "./approval.js";
import { COMMENT_TEXT, type PlanRefusal } from "./comment-text.js";
import type { WorkspaceConfig } from "./config.js";
import { recordAttention, resolveAttention } from "./db/attention.js";
import { appendAudit } from "./db/audit.js";
import { getApprovalHoldActor } from "./db/holds.js";
import { hasSucceededJobForApproval, type JobRow } from "./db/jobs.js";
import {
  activatePlanDeployment,
  closePlanReview,
  getPlanDeployment,
  listLivePlanDeployments,
  listOpenPlanReviews,
  type PlanDeploymentRow,
  type PlanReviewRow,
  recordPlanDeployment,
  setPlanDeploymentState,
} from "./db/plan-delegation.js";
import { insertReportBatch, isReportStepSettled, listBatchReportSteps } from "./db/report-steps.js";
import { isLatestReviewConfirmed } from "./db/review-targets.js";
import {
  buildPlanApprovalRefusedSteps,
  buildPlanCompletedSteps,
  buildPlanDeploymentSteps,
  parseTaskApprovalId,
  planApprovalRefusedBatchId,
  planCompletedBatchId,
  planDeploymentBatchId,
} from "./report-journal.js";
import type { SchedulerDeps, SchedulerReport } from "./scheduler.js";
import { isDependencyResolved } from "./workflow-mode.js";
import { latestPlanningRequest, planningFingerprint } from "./planning-requests.js";

/**
 * The plan half of the reconcile pass (ADR 0044). A plan Router applied waits for a
 * human in the plan-review status; the human's move from there to the shared in-progress status
 * approves it. This pass finds those moves for the plans Router knows about — never by scanning
 * the in-progress status, where people work too — records each approval once before anything runs
 * under it, starts the plan's tasks (or the issue itself, for a plan without tasks), and withdraws
 * the approval when the issue leaves in progress. Tasks inherit the approval; nothing it starts is
 * planned again.
 */
export async function reconcileDelegatedPlans(
  deps: SchedulerDeps,
  workspace: WorkspaceConfig,
  report: SchedulerReport,
  reconcile: (issue: JiraIssue) => Promise<void>,
): Promise<void> {
  for (const review of listOpenPlanReviews(deps.db, workspace.id)) {
    await reconcilePlan(deps, workspace, review, report, reconcile);
  }
}

async function reconcilePlan(
  deps: SchedulerDeps,
  workspace: WorkspaceConfig,
  review: PlanReviewRow,
  report: SchedulerReport,
  reconcile: (issue: JiraIssue) => Promise<void>,
): Promise<void> {
  const { db } = deps;
  const { requestStatus, inProgressStatus, doneStatus } = workspace.workflow;
  const now = deps.now();
  let issue: JiraIssue;
  try {
    issue = await deps.jira.getIssue(review.issueKey);
  } catch (error) {
    if (error instanceof JiraApiError && error.status === 404) {
      endLiveDeployments(db, review.issueKey, `${review.issueKey} no longer exists`, now);
      closePlanReview(db, review.id, "the issue no longer exists", now);
      return;
    }
    throw error;
  }

  if (doneStatus && issue.statusName === doneStatus) {
    endLiveDeployments(db, issue.key, `${issue.key} reached "${doneStatus}"`, now);
    closePlanReview(db, review.id, `the issue reached "${doneStatus}"`, now);
    return;
  }
  if (issue.statusName !== inProgressStatus) {
    // Waiting for review, being planned again, or taken back by a human: nothing runs under a plan
    // while the issue is out of in progress.
    endLiveDeployments(db, issue.key, `${issue.key} moved to "${issue.statusName}"`, now);
    return;
  }

  const ids = await computeDelegationApprovalIds(deps.jira, issue, {
    requestStatus,
    inProgressStatus,
  });
  for (const live of listLivePlanDeployments(db, issue.key)) {
    if (live.approvalId === ids.planApprovalId) continue;
    setPlanDeploymentState(db, live.id, "revoked", `${issue.key} was approved again`, now);
  }
  // In progress without a move from plan review: a person works on it; nothing to do.
  if (!ids.planApprovalId) return;

  const heldBy = getApprovalHoldActor(db, issue.key, ids.planApprovalId);
  let deployment = getPlanDeployment(db, issue.key, ids.planApprovalId);
  if (!deployment) {
    if (heldBy) {
      report.held.push({
        issueKey: issue.key,
        target: "human",
        reason: `the move to "${inProgressStatus}" is held (${heldBy}); it approves nothing`,
      });
      return;
    }
    const request = latestPlanningRequest(db, issue.key);
    const refusal =
      refusalOf(review, request?.id ?? ids.requestApprovalId) ??
      (!request?.ready_history ||
      request.entry_id !== ids.requestApprovalId ||
      request.input_hash !== planningFingerprint(issue) ||
      (JSON.parse(request.ready_history) as string[]).includes(ids.planApprovalId)
        ? { kind: "not_applied" as const, planVersion: review.planVersion }
        : undefined);
    if (refusal) {
      refuse(deps, workspace, review, ids.planApprovalId, refusal, report);
      return;
    }
    const recorded = recordPlanDeployment(db, {
      issueKey: issue.key,
      planReviewId: review.id,
      planVersion: review.planVersion,
      approvalId: ids.planApprovalId,
      taskIds: review.taskIds,
      state: "waiting_plan_apply",
      now,
    });
    deployment = recorded.row;
    if (recorded.created) {
      appendAudit(db, {
        at: now,
        actor: "router",
        action: "plan.approved",
        subject: issue.key,
        detail: {
          planVersion: review.planVersion,
          approvalId: ids.planApprovalId,
          taskIds: review.taskIds,
        },
      });
      resolveAttention(db, {
        issueKey: issue.key,
        kinds: ["plan_approval_refused"],
        resolution: `plan ${review.planVersion} approved (${ids.planApprovalId})`,
        now,
      });
    }
  }
  if (deployment.state === "completed" || deployment.state === "revoked") return;
  if (heldBy) {
    // An admin withdrew this approval (`jobs cancel` on a run under it).
    setPlanDeploymentState(db, deployment.id, "revoked", `withdrawn (${heldBy})`, now);
    return;
  }

  if (deployment.state === "waiting_plan_apply") {
    const taskIds = await activate(deps, workspace, review, deployment, report);
    if (!taskIds) return;
    deployment = { ...deployment, state: "active", taskIds };
  }

  if (deployment.taskIds.length === 0) {
    if (!hasSucceededJobForApproval(db, issue.key, deployment.approvalId)) await reconcile(issue);
    return;
  }
  const tasks = await findPlanTasks(deps, issue.key, deployment);
  for (const task of tasks) {
    if (task.issue.statusName === inProgressStatus) await reconcile(task.issue);
  }
  const done = tasks.filter((task) =>
    isDependencyResolved(
      workspace,
      task.issue.statusName,
      isLatestReviewConfirmed(db, task.issue.key),
    ),
  );
  if (tasks.length === deployment.taskIds.length && done.length === tasks.length) {
    const run = db.transaction(() => {
      insertReportBatch(db, {
        batchId: planCompletedBatchId(deployment.id),
        jobId: review.jobId,
        attemptId: review.attemptId,
        issueKey: issue.key,
        steps: buildPlanCompletedSteps({
          workspace,
          parentKey: issue.key,
          approvalId: deployment.approvalId,
          taskKeys: tasks.map((task) => task.issue.key),
          language: deps.config.reporting.language,
        }),
        now,
      });
      setPlanDeploymentState(db, deployment.id, "completed", "all tasks done", now);
    });
    run();
  }
}

/**
 * Starts a recorded approval once the plan it approves is fully in Jira (the plan's report batch
 * settled) and is still the plan Jira shows: journals the approval notice and the move of each
 * task to in progress, then marks the deployment active with the plan's tasks as Jira lists them.
 * Returns those task ids, or `undefined` when it cannot start yet (or at all).
 */
async function activate(
  deps: SchedulerDeps,
  workspace: WorkspaceConfig,
  review: PlanReviewRow,
  recorded: PlanDeploymentRow,
  report: SchedulerReport,
): Promise<string[] | undefined> {
  const { db } = deps;
  const steps = listBatchReportSteps(db, review.id);
  if (steps.length === 0 || !steps.every((step) => isReportStepSettled(step.status))) {
    report.held.push({
      issueKey: review.issueKey,
      target: "human",
      reason: `plan ${review.planVersion} is approved but not fully applied to Jira yet; it starts once it is`,
    });
    return undefined;
  }
  const property = PlanMetadataSchema.safeParse(
    await deps.jira.getIssueProperty(review.issueKey, PLAN_PROPERTY_KEY),
  );
  if (!property.success || property.data.version !== review.planVersion) {
    const refusal: PlanRefusal = {
      kind: "plan_mismatch",
      planVersion: review.planVersion,
      jiraVersion: property.success ? property.data.version : null,
    };
    setPlanDeploymentState(
      db,
      recorded.id,
      "revoked",
      COMMENT_TEXT.en.plan.refusal(refusal),
      deps.now(),
    );
    refuse(deps, workspace, review, recorded.approvalId, refusal, report);
    return undefined;
  }
  // The plan's tasks as applied, including tasks a re-plan kept from the plan before.
  const deployment = { ...recorded, taskIds: property.data.taskIds };
  const { inProgressStatus, reviewStatus, doneStatus } = workspace.workflow;
  const tasks =
    deployment.taskIds.length > 0 ? await findPlanTasks(deps, review.issueKey, deployment) : [];
  const now = deps.now();
  const run = db.transaction(() => {
    insertReportBatch(db, {
      batchId: planDeploymentBatchId(deployment.id),
      jobId: review.jobId,
      attemptId: review.attemptId,
      issueKey: review.issueKey,
      steps: buildPlanDeploymentSteps({
        workspace,
        parentKey: review.issueKey,
        planVersion: review.planVersion,
        approvalId: deployment.approvalId,
        // A task already reviewed or done (kept from an earlier plan) is not run again.
        tasks: tasks
          .filter(
            (task) =>
              task.issue.statusName !== reviewStatus && task.issue.statusName !== doneStatus,
          )
          .map((task) => ({ issueKey: task.issue.key, statusName: task.issue.statusName })),
        language: deps.config.reporting.language,
      }),
      now,
    });
    activatePlanDeployment(db, deployment.id, deployment.taskIds, now);
  });
  run();
  report.skipped.push({
    issueKey: review.issueKey,
    reason: `plan ${review.planVersion} approved (${deployment.approvalId}); ${inProgressStatus} work may start`,
  });
  return deployment.taskIds;
}

/** Why a move to in progress does not approve the issue's latest plan, if it does not. */
function refusalOf(review: PlanReviewRow, requestApprovalId: string): PlanRefusal | undefined {
  const { planVersion } = review;
  if (review.outcome === "needs_decision") return { kind: "needs_decision", planVersion };
  if (review.outcome === "not_applied") return { kind: "not_applied", planVersion };
  if (review.requestApprovalId !== requestApprovalId) {
    return { kind: "earlier_request", planVersion };
  }
  return undefined;
}

/** Tells the human once, per move, that it approved nothing, and keeps it as an attention item. */
function refuse(
  deps: SchedulerDeps,
  workspace: WorkspaceConfig,
  review: PlanReviewRow,
  approvalId: string,
  refusal: PlanRefusal,
  report: SchedulerReport,
): void {
  const now = deps.now();
  // Recorded in English, so an attention item stays one incident whatever the comment language.
  const reason = COMMENT_TEXT.en.plan.refusal(refusal);
  const run = deps.db.transaction(() => {
    recordAttention(deps.db, {
      issueKey: review.issueKey,
      approvalId,
      kind: "plan_approval_refused",
      cause: reason,
      severity: "immediate",
      reason: "a move to in progress was not taken as approval of a plan; nothing runs",
      evidence: { planVersion: review.planVersion, reason },
      now,
    });
    insertReportBatch(deps.db, {
      batchId: planApprovalRefusedBatchId(review.issueKey, approvalId),
      jobId: review.jobId,
      attemptId: review.attemptId,
      issueKey: review.issueKey,
      steps: buildPlanApprovalRefusedSteps({
        workspace,
        refusal,
        language: deps.config.reporting.language,
      }),
      now,
    });
  });
  run();
  report.held.push({ issueKey: review.issueKey, target: "human", reason });
}

/**
 * Ends every live deployment of the issue. One that already did its work — a plan without tasks
 * whose run succeeded, now waiting in review — completes; any other is withdrawn, and the next
 * check of its open jobs cancels them.
 */
function endLiveDeployments(
  db: Database.Database,
  issueKey: string,
  reason: string,
  now: string,
): void {
  for (const live of listLivePlanDeployments(db, issueKey)) {
    const finished =
      live.state === "active" &&
      live.taskIds.length === 0 &&
      hasSucceededJobForApproval(db, issueKey, live.approvalId);
    setPlanDeploymentState(db, live.id, finished ? "completed" : "revoked", reason, now);
  }
}

/** The subtasks Jira holds for a deployed plan: stamped with its version and one of its tasks. */
async function findPlanTasks(
  deps: SchedulerDeps,
  parentKey: string,
  deployment: PlanDeploymentRow,
): Promise<Array<{ issue: JiraIssue; taskId: string }>> {
  const subtasks = await deps.jira.searchIssues(`parent = "${parentKey}"`, { all: true });
  const tasks: Array<{ issue: JiraIssue; taskId: string }> = [];
  for (const subtask of subtasks) {
    let planTask: Awaited<ReturnType<typeof readPlanTaskMetadata>>;
    try {
      planTask = await readPlanTaskMetadata(deps.jira, subtask.key);
    } catch (error) {
      if (error instanceof PlanMetadataError) continue;
      throw error;
    }
    if (
      planTask &&
      planTask.parentKey === parentKey &&
      planTask.planVersion === deployment.planVersion &&
      deployment.taskIds.includes(planTask.taskId)
    ) {
      tasks.push({ issue: subtask, taskId: planTask.taskId });
    }
  }
  return tasks;
}

/**
 * Whether the deployment an implementation job runs under is still active — Router's own
 * record, so the Worker API checks it without asking Jira. A task run's approval names the plan
 * approval of its parent (`taskApprovalId`).
 */
export function planDeploymentAuthorizes(
  db: Database.Database,
  job: Pick<JobRow, "issueKey" | "approvalId">,
  parentKey: string | null,
): boolean {
  const run = parseTaskApprovalId(job.approvalId);
  const deployment = run
    ? parentKey
      ? getPlanDeployment(db, parentKey, run.planApprovalId)
      : undefined
    : getPlanDeployment(db, job.issueKey, job.approvalId);
  return deployment?.state === "active";
}
