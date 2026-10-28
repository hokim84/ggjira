import type { RouterDatabase } from "./connection.js";
import { type Plan, PlanSchema } from "../../pm/plan.js";
import { getResult } from "./results.js";

/** Plans a human reviews and the approvals that deploy them (migration 14, ADR 0044). */

export type PlanReviewOutcome = "planned" | "needs_decision" | "not_applied";

export interface PlanReviewRow {
  /** The planning result's id. */
  id: string;
  issueKey: string;
  workspaceId: string;
  jobId: string;
  attemptId: string;
  /** The request (changelog entry into the request status) this plan answered. */
  requestApprovalId: string;
  planVersion: string;
  outcome: PlanReviewOutcome;
  taskIds: string[];
  createdAt: string;
  closedAt: string | null;
  closedReason: string | null;
}

export type PlanDeploymentState = "waiting_plan_apply" | "active" | "completed" | "revoked";

export interface PlanDeploymentRow {
  id: number;
  issueKey: string;
  planReviewId: string;
  planVersion: string;
  /** The changelog entry of the human's move from the plan-review status to in progress. */
  approvalId: string;
  taskIds: string[];
  state: PlanDeploymentState;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}

function toPlanReview(row: Record<string, unknown>): PlanReviewRow {
  return {
    id: row.id as string,
    issueKey: row.issue_key as string,
    workspaceId: row.workspace_id as string,
    jobId: row.job_id as string,
    attemptId: row.attempt_id as string,
    requestApprovalId: row.request_approval_id as string,
    planVersion: row.plan_version as string,
    outcome: row.outcome as PlanReviewOutcome,
    taskIds: JSON.parse(row.task_ids as string) as string[],
    createdAt: row.created_at as string,
    closedAt: (row.closed_at as string | null) ?? null,
    closedReason: (row.closed_reason as string | null) ?? null,
  };
}

function toDeployment(row: Record<string, unknown>): PlanDeploymentRow {
  return {
    id: row.id as number,
    issueKey: row.issue_key as string,
    planReviewId: row.plan_review_id as string,
    planVersion: row.plan_version as string,
    approvalId: row.approval_id as string,
    taskIds: JSON.parse(row.task_ids as string) as string[],
    state: row.state as PlanDeploymentState,
    reason: (row.reason as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/**
 * Stores an applied planning result as the plan now waiting for review, in the transaction that
 * stores the result. A resent result is ignored; every earlier open plan of the issue is closed as
 * superseded, along with any deployment still live under it.
 */
export function recordPlanReview(
  db: RouterDatabase,
  input: Omit<PlanReviewRow, "createdAt" | "closedAt" | "closedReason"> & { now: string },
): void {
  const inserted = db
    .prepare(
      `INSERT OR IGNORE INTO plan_reviews (
        id, issue_key, workspace_id, job_id, attempt_id, request_approval_id, plan_version,
        outcome, task_ids, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.issueKey,
      input.workspaceId,
      input.jobId,
      input.attemptId,
      input.requestApprovalId,
      input.planVersion,
      input.outcome,
      JSON.stringify(input.taskIds),
      input.now,
    );
  if (inserted.changes === 0) return;
  const reason = `superseded by plan ${input.planVersion}`;
  db.prepare(
    `UPDATE plan_deployments SET state = 'revoked', reason = ?, updated_at = ?
     WHERE issue_key = ? AND state IN ('waiting_plan_apply', 'active')`,
  ).run(reason, input.now, input.issueKey);
  db.prepare(
    `UPDATE plan_reviews SET closed_at = ?, closed_reason = ?
     WHERE issue_key = ? AND id != ? AND closed_at IS NULL`,
  ).run(input.now, reason, input.issueKey, input.id);
}

/** The issue's newest plan, closed or not. */
export function getLatestPlanReview(
  db: RouterDatabase,
  issueKey: string,
): PlanReviewRow | undefined {
  const row = db
    .prepare(
      "SELECT * FROM plan_reviews WHERE issue_key = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
    )
    .get(issueKey) as Record<string, unknown> | undefined;
  return row ? toPlanReview(row) : undefined;
}

export function getPlanReview(db: RouterDatabase, id: string): PlanReviewRow | undefined {
  const row = db.prepare("SELECT * FROM plan_reviews WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? toPlanReview(row) : undefined;
}

/** Issues of a workspace whose newest plan is still open: waiting for review, or deployed. */
export function listOpenPlanReviews(db: RouterDatabase, workspaceId: string): PlanReviewRow[] {
  const rows = db
    .prepare(
      "SELECT * FROM plan_reviews WHERE workspace_id = ? AND closed_at IS NULL ORDER BY created_at ASC, rowid ASC",
    )
    .all(workspaceId) as Record<string, unknown>[];
  return rows.map(toPlanReview);
}

export function closePlanReview(db: RouterDatabase, id: string, reason: string, now: string): void {
  db.prepare(
    "UPDATE plan_reviews SET closed_at = ?, closed_reason = ? WHERE id = ? AND closed_at IS NULL",
  ).run(now, reason, id);
}

/**
 * Records a human's approval of a plan, once: a second call for the same changelog entry returns
 * the row the first one made, whatever state it is in now.
 */
export function recordPlanDeployment(
  db: RouterDatabase,
  input: {
    issueKey: string;
    planReviewId: string;
    planVersion: string;
    approvalId: string;
    taskIds: readonly string[];
    state: Extract<PlanDeploymentState, "waiting_plan_apply" | "active">;
    now: string;
  },
): { row: PlanDeploymentRow; created: boolean } {
  const inserted = db
    .prepare(
      `INSERT OR IGNORE INTO plan_deployments (
        issue_key, plan_review_id, plan_version, approval_id, task_ids, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.issueKey,
      input.planReviewId,
      input.planVersion,
      input.approvalId,
      JSON.stringify(input.taskIds),
      input.state,
      input.now,
      input.now,
    );
  const row = getPlanDeployment(db, input.issueKey, input.approvalId);
  if (!row) throw new Error(`plan deployment for ${input.issueKey} vanished`);
  return { row, created: inserted.changes > 0 };
}

export function getPlanDeployment(
  db: RouterDatabase,
  issueKey: string,
  approvalId: string,
): PlanDeploymentRow | undefined {
  const row = db
    .prepare("SELECT * FROM plan_deployments WHERE issue_key = ? AND approval_id = ?")
    .get(issueKey, approvalId) as Record<string, unknown> | undefined;
  return row ? toDeployment(row) : undefined;
}

/** The deployment tasks and the parent may run under right now, if any. */
export function getActivePlanDeployment(
  db: RouterDatabase,
  issueKey: string,
): PlanDeploymentRow | undefined {
  const row = db
    .prepare(
      "SELECT * FROM plan_deployments WHERE issue_key = ? AND state = 'active' ORDER BY id DESC LIMIT 1",
    )
    .get(issueKey) as Record<string, unknown> | undefined;
  return row ? toDeployment(row) : undefined;
}

/** Deployments of the issue that are waiting to start or running, newest first. */
export function listLivePlanDeployments(db: RouterDatabase, issueKey: string): PlanDeploymentRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM plan_deployments WHERE issue_key = ?
       AND state IN ('waiting_plan_apply', 'active') ORDER BY id DESC`,
    )
    .all(issueKey) as Record<string, unknown>[];
  return rows.map(toDeployment);
}

export function listPlanDeployments(db: RouterDatabase, issueKey: string): PlanDeploymentRow[] {
  const rows = db
    .prepare("SELECT * FROM plan_deployments WHERE issue_key = ? ORDER BY id DESC")
    .all(issueKey) as Record<string, unknown>[];
  return rows.map(toDeployment);
}

export function setPlanDeploymentState(
  db: RouterDatabase,
  id: number,
  state: PlanDeploymentState,
  reason: string | null,
  now: string,
): void {
  db.prepare("UPDATE plan_deployments SET state = ?, reason = ?, updated_at = ? WHERE id = ?").run(
    state,
    reason,
    now,
    id,
  );
}

/** Starts a recorded approval with the tasks the plan has in Jira (kept tasks of a re-plan are
 *  only known once the plan is applied). */
export function activatePlanDeployment(
  db: RouterDatabase,
  id: number,
  taskIds: readonly string[],
  now: string,
): void {
  db.prepare(
    "UPDATE plan_deployments SET state = 'active', task_ids = ?, reason = NULL, updated_at = ? WHERE id = ?",
  ).run(JSON.stringify(taskIds), now, id);
}

/** The issue's applied plans, newest first. */
export function listPlannedReviews(db: RouterDatabase, issueKey: string): PlanReviewRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM plan_reviews WHERE issue_key = ? AND outcome = 'planned'
       ORDER BY created_at DESC, rowid DESC`,
    )
    .all(issueKey) as Record<string, unknown>[];
  return rows.map(toPlanReview);
}

/** The plan a planning result returned: the contract its approved runs are held to (ADR 0047). */
export function getReviewedPlan(db: RouterDatabase, reviewId: string): Plan | undefined {
  const result = getResult(db, reviewId);
  if (!result) return undefined;
  const parsed = PlanSchema.safeParse((JSON.parse(result.payload) as { plan?: unknown }).plan);
  return parsed.success ? parsed.data : undefined;
}
