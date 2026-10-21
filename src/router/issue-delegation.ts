import type Database from "better-sqlite3";
import type { JiraGateway } from "../jira/gateway.js";
import type { JiraIssue } from "../jira/types.js";
import { PlanMetadataError, readPlanTaskMetadata } from "../pm/metadata.js";
import type { WorkspaceConfig } from "./config.js";
import { getApprovalHoldActor } from "./db/holds.js";
import { getOpenJobForIssue } from "./db/jobs.js";
import {
  getActivePlanDeployment,
  getLatestPlanReview,
  listPlanDeployments,
  type PlanDeploymentState,
  type PlanReviewOutcome,
} from "./db/plan-delegation.js";
import { parseTaskApprovalId } from "./report-journal.js";
import { latestPlanningRequest } from "./planning-requests.js";
import { listBatchReportSteps } from "./db/report-steps.js";

/**
 * Where an issue stands (ADR 0044), for the admin API and the web UI. Read-only:
 * delegating, approving and withdrawing are status moves in Jira; the UI only says which is next.
 *
 * - `not_delegated`: nothing of AI's — a person's issue, wherever it is.
 * - `plan_requested` / `planning`: waiting for, or being planned by, a worker.
 * - `plan_review` / `plan_needs_decision`: a plan waits for a human.
 * - `approved_waiting`: approved, the plan not fully in Jira yet.
 * - `running`: the issue itself is implemented under the approval.
 * - `coordinating`: its tasks run under the approval; the issue only tracks them.
 * - `task`: a task of an approved plan.
 * - `result_review` / `done`.
 */
export type DelegationStage =
  | "not_delegated"
  | "plan_requested"
  | "planning"
  | "plan_review"
  | "plan_needs_decision"
  | "plan_failed"
  | "plan_held"
  | "approved_waiting"
  | "running"
  | "coordinating"
  | "task"
  | "result_review"
  | "done";

export interface IssueDelegationView {
  stage: DelegationStage;
  statuses: {
    request: string;
    inProgress: string;
    review: string;
    done: string | null;
  };
  plan: {
    version: string;
    outcome: PlanReviewOutcome;
    taskIds: string[];
    createdAt: string;
    closed: boolean;
  } | null;
  deployment: {
    approvalId: string;
    state: PlanDeploymentState;
    reason: string | null;
    createdAt: string;
  } | null;
  /** The approved plan a task runs under. */
  parentKey: string | null;
  /** Who cancelled the run under the current approval (`jobs cancel`), if anyone. */
  heldBy: string | null;
}

export async function readIssueDelegation(
  deps: { db: Database.Database; jira: JiraGateway },
  workspace: WorkspaceConfig,
  issue: JiraIssue,
): Promise<IssueDelegationView> {
  const { db } = deps;
  const { requestStatus, inProgressStatus, reviewStatus, doneStatus } = workspace.workflow;
  const review = getLatestPlanReview(db, issue.key);
  const deployment = listPlanDeployments(db, issue.key)[0];
  const job = getOpenJobForIssue(db, issue.key);
  const request = latestPlanningRequest(db, issue.key);
  let parentKey: string | null = null;
  let stage: DelegationStage = "not_delegated";

  if (issue.statusName === requestStatus) {
    stage =
      job?.kind === "planning"
        ? ["failed", "timed_out"].includes(job.state)
          ? "plan_failed"
          : ["recovery_required", "cancel_requested"].includes(job.state)
            ? "plan_held"
            : job.state === "queued" || job.state === "waiting"
              ? "plan_requested"
              : "planning"
        : review && !review.closedAt && review.requestApprovalId === request?.id
          ? review.outcome === "needs_decision"
            ? "plan_needs_decision"
            : review.outcome === "not_applied"
              ? "plan_failed"
              : request.ready_history
                ? "plan_review"
                : listBatchReportSteps(db, review.id).some((step) =>
                      ["failed", "recovery_required"].includes(step.status),
                    )
                  ? "plan_held"
                  : "planning"
          : "plan_requested";
  } else if (issue.statusName === inProgressStatus) {
    if (deployment?.state === "waiting_plan_apply") {
      stage = "approved_waiting";
    } else if (deployment?.state === "active") {
      stage = deployment.taskIds.length > 0 ? "coordinating" : "running";
    } else {
      let planTask: Awaited<ReturnType<typeof readPlanTaskMetadata>> = null;
      try {
        planTask = await readPlanTaskMetadata(deps.jira, issue.key);
      } catch (error) {
        if (!(error instanceof PlanMetadataError)) throw error;
      }
      const parent = planTask ? getActivePlanDeployment(db, planTask.parentKey) : undefined;
      if (planTask && parent?.planVersion === planTask.planVersion) {
        stage = "task";
        parentKey = planTask.parentKey;
      }
    }
  } else if (issue.statusName === reviewStatus && (review || job)) {
    stage = "result_review";
  } else if (doneStatus && issue.statusName === doneStatus && review) {
    stage = "done";
  }

  // A task run is held by its own approval; a plan by the approval of its deployment.
  const runApproval = job?.approvalId;
  const planApproval = runApproval
    ? (parseTaskApprovalId(runApproval)?.planApprovalId ?? runApproval)
    : deployment?.approvalId;
  const heldBy =
    (request ? getApprovalHoldActor(db, issue.key, request.id) : undefined) ??
    (runApproval ? getApprovalHoldActor(db, issue.key, runApproval) : undefined) ??
    (planApproval ? getApprovalHoldActor(db, issue.key, planApproval) : undefined) ??
    (!request && db.prepare("SELECT 1 FROM planning_baselines LIMIT 1").get()
      ? "migration:single-review"
      : null);
  if (heldBy && issue.statusName === requestStatus) stage = "plan_held";
  return {
    stage,
    statuses: {
      request: requestStatus,
      inProgress: inProgressStatus,
      review: reviewStatus,
      done: doneStatus ?? null,
    },
    plan: review
      ? {
          version: review.planVersion,
          outcome: review.outcome,
          taskIds: review.taskIds,
          createdAt: review.createdAt,
          closed: review.closedAt !== null,
        }
      : null,
    deployment: deployment
      ? {
          approvalId: deployment.approvalId,
          state: deployment.state,
          reason: deployment.reason,
          createdAt: deployment.createdAt,
        }
      : null,
    parentKey,
    heldBy,
  };
}
