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

/**
 * Where a `delegation`-mode issue stands (ADR 0044), for the admin API and the web UI. Read-only:
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
    planReview: string;
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
  const { requestStatus, planReviewStatus, inProgressStatus, reviewStatus, doneStatus } =
    workspace.workflow;
  const review = getLatestPlanReview(db, issue.key);
  const deployment = listPlanDeployments(db, issue.key)[0];
  const job = getOpenJobForIssue(db, issue.key);
  let parentKey: string | null = null;
  let stage: DelegationStage = "not_delegated";

  if (issue.statusName === requestStatus) {
    stage = job?.kind === "planning" && job.state !== "queued" ? "planning" : "plan_requested";
  } else if (issue.statusName === planReviewStatus && review && !review.closedAt) {
    stage = review.outcome === "needs_decision" ? "plan_needs_decision" : "plan_review";
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
    (runApproval ? getApprovalHoldActor(db, issue.key, runApproval) : undefined) ??
    (planApproval ? getApprovalHoldActor(db, issue.key, planApproval) : undefined) ??
    null;
  return {
    stage,
    statuses: {
      request: requestStatus,
      planReview: planReviewStatus ?? "",
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
