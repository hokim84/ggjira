import type Database from "better-sqlite3";
import type { JobKind } from "../../contracts/protocol.js";
import type { ReviewAssessment, ReviewClass } from "../review-gate.js";

/** One applied result as the thing a human reviews (migration 11, ADR 0040). */
export interface ReviewTargetRow {
  id: string;
  issueKey: string;
  jobId: string;
  attemptId: string;
  kind: JobKind;
  approvalId: string;
  /** `null` for a job created before input hashes existed. */
  inputHash: string | null;
  resultStatus: string;
  finalState: string;
  baseSha: string | null;
  headSha: string | null;
  commitState: ReviewAssessment["commit"]["state"];
  reviewClass: ReviewClass;
  assessment: ReviewAssessment;
  createdAt: string;
  /** Set once a newer result for the issue exists; the row then stays as history only. */
  supersededBy: string | null;
  supersededAt: string | null;
}

export type ReviewRecordOutcome = "matched" | "stale" | "unverified" | "no_target";

export interface ReviewRecordRow {
  id: number;
  targetId: string | null;
  issueKey: string;
  action: string;
  actor: string | null;
  authentication: string;
  headSha: string | null;
  outcome: ReviewRecordOutcome;
  detail: unknown;
  at: string;
}

function toTarget(row: Record<string, unknown>): ReviewTargetRow {
  return {
    id: row.id as string,
    issueKey: row.issue_key as string,
    jobId: row.job_id as string,
    attemptId: row.attempt_id as string,
    kind: row.kind as JobKind,
    approvalId: row.approval_id as string,
    inputHash: (row.input_hash as string | null) ?? null,
    resultStatus: row.result_status as string,
    finalState: row.final_state as string,
    baseSha: (row.base_sha as string | null) ?? null,
    headSha: (row.head_sha as string | null) ?? null,
    commitState: row.commit_state as ReviewTargetRow["commitState"],
    reviewClass: row.review_class as ReviewClass,
    assessment: JSON.parse(row.assessment as string) as ReviewAssessment,
    createdAt: row.created_at as string,
    supersededBy: (row.superseded_by as string | null) ?? null,
    supersededAt: (row.superseded_at as string | null) ?? null,
  };
}

function toRecord(row: Record<string, unknown>): ReviewRecordRow {
  return {
    id: row.id as number,
    targetId: (row.target_id as string | null) ?? null,
    issueKey: row.issue_key as string,
    action: row.action as string,
    actor: (row.actor as string | null) ?? null,
    authentication: row.authentication as string,
    headSha: (row.head_sha as string | null) ?? null,
    outcome: row.outcome as ReviewRecordOutcome,
    detail: row.detail ? JSON.parse(row.detail as string) : null,
    at: row.at as string,
  };
}

/**
 * Records the review target for one applied result and supersedes every earlier target of the
 * issue. Keyed by result id, so a replay inserts nothing and supersedes nothing.
 */
export function recordReviewTarget(
  db: Database.Database,
  input: {
    resultId: string;
    issueKey: string;
    jobId: string;
    attemptId: string;
    kind: JobKind;
    approvalId: string;
    inputHash: string | null;
    resultStatus: string;
    finalState: string;
    assessment: ReviewAssessment;
    now: string;
  },
): void {
  const inserted = db
    .prepare(
      `INSERT OR IGNORE INTO review_targets (
        id, issue_key, job_id, attempt_id, kind, approval_id, input_hash, result_status,
        final_state, base_sha, head_sha, commit_state, review_class, assessment, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.resultId,
      input.issueKey,
      input.jobId,
      input.attemptId,
      input.kind,
      input.approvalId,
      input.inputHash,
      input.resultStatus,
      input.finalState,
      input.assessment.commit.baseSha ?? null,
      input.assessment.commit.headSha ?? null,
      input.assessment.commit.state,
      input.assessment.reviewClass,
      JSON.stringify(input.assessment),
      input.now,
    );
  if (inserted.changes === 0) return;
  db.prepare(
    `UPDATE review_targets SET superseded_by = ?, superseded_at = ?
     WHERE issue_key = ? AND id <> ? AND superseded_by IS NULL`,
  ).run(input.resultId, input.now, input.issueKey, input.resultId);
}

export function getReviewTarget(db: Database.Database, id: string): ReviewTargetRow | undefined {
  const row = db.prepare("SELECT * FROM review_targets WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? toTarget(row) : undefined;
}

/** The target recorded for one attempt's result (an attempt applies at most one result). */
export function getReviewTargetForAttempt(
  db: Database.Database,
  attemptId: string,
): ReviewTargetRow | undefined {
  const row = db
    .prepare("SELECT * FROM review_targets WHERE attempt_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(attemptId) as Record<string, unknown> | undefined;
  return row ? toTarget(row) : undefined;
}

/** Newest first; the first entry is current unless it too was superseded. */
export function listReviewTargets(db: Database.Database, issueKey: string): ReviewTargetRow[] {
  return (
    db
      .prepare(
        "SELECT * FROM review_targets WHERE issue_key = ? ORDER BY created_at DESC, rowid DESC",
      )
      .all(issueKey) as Array<Record<string, unknown>>
  ).map(toTarget);
}

export function appendReviewRecord(
  db: Database.Database,
  input: {
    targetId: string | null;
    issueKey: string;
    action: string;
    actor: string | null;
    authentication: string;
    headSha: string | null;
    outcome: ReviewRecordOutcome;
    detail?: unknown;
    at: string;
  },
): void {
  db.prepare(
    `INSERT INTO review_records (
      target_id, issue_key, action, actor, authentication, head_sha, outcome, detail, at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.targetId,
    input.issueKey,
    input.action,
    input.actor,
    input.authentication,
    input.headSha,
    input.outcome,
    input.detail === undefined ? null : JSON.stringify(input.detail),
    input.at,
  );
}

export function listReviewRecords(db: Database.Database, issueKey: string): ReviewRecordRow[] {
  return (
    db
      .prepare("SELECT * FROM review_records WHERE issue_key = ? ORDER BY id ASC")
      .all(issueKey) as Array<Record<string, unknown>>
  ).map(toRecord);
}

export function getReviewRecord(db: Database.Database, id: number): ReviewRecordRow | undefined {
  const row = db.prepare("SELECT * FROM review_records WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? toRecord(row) : undefined;
}

// --- review queue (F01, ADR 0043) ------------------------------------------------------------

/** What a human decided about one target from the review screen. Recording only (ADR 0043). */
export const JUDGMENT_ACTIONS = ["confirm", "hold", "rework"] as const;
export type JudgmentAction = (typeof JUDGMENT_ACTIONS)[number];

export function judgmentRecordAction(action: JudgmentAction): string {
  return `judgment.${action}`;
}

/**
 * Where a current target stands in the queue, derived from its records:
 * - `pending`: nobody judged it yet; `held`: the latest judgment is a hold.
 * - `confirmed` / `rework_requested`: judged; it leaves the queue (a rework comes back as a new
 *   target once the next result arrives).
 * - `merged`: its pull request was merged with the reviewed head (or one that could not be compared).
 * - `outdated`: the issue's approval changed since the run; judging it is refused.
 */
export const REVIEW_QUEUE_STATES = [
  "pending",
  "held",
  "confirmed",
  "rework_requested",
  "merged",
  "outdated",
] as const;
export type ReviewQueueState = (typeof REVIEW_QUEUE_STATES)[number];

export interface ReviewQueueItem {
  target: ReviewTargetRow;
  state: ReviewQueueState;
  /** The latest judgment on the target, if any. */
  judgment: ReviewRecordRow | null;
  /** From the approval snapshot the run used, as far as it is still stored (no Jira call). */
  issue: { summary: string | null; assigneeAccountId: string | null; parentKey: string | null };
  /** From the stored result. */
  result: {
    summary: string | null;
    branch: string | null;
    pullRequest: { repo: string; number: number; url: string } | null;
    changes: string[];
  };
}

export interface ReviewQueueFilter {
  reviewClass?: ReviewClass;
  /** Default: `pending` and `held`, the items still waiting on a human. */
  states?: readonly ReviewQueueState[];
  assigneeAccountId?: string;
  parentKey?: string;
}

const WAITING_STATES: readonly ReviewQueueState[] = ["pending", "held"];

/** The latest judgment recorded against one target. */
export function latestJudgment(
  db: Database.Database,
  targetId: string,
): ReviewRecordRow | undefined {
  const row = db
    .prepare(
      "SELECT * FROM review_records WHERE target_id = ? AND action LIKE 'judgment.%' ORDER BY id DESC LIMIT 1",
    )
    .get(targetId) as Record<string, unknown> | undefined;
  return row ? toRecord(row) : undefined;
}

function mergedWithTarget(db: Database.Database, targetId: string): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM review_records WHERE target_id = ? AND action = 'pull_request.merged'
         AND outcome IN ('matched', 'unverified') LIMIT 1`,
      )
      .get(targetId) !== undefined
  );
}

interface StoredSnapshot {
  issue?: { summary?: string; assigneeAccountId?: string | null; parentKey?: string | null };
}

interface StoredResult {
  summary?: string;
  branch?: string;
  pullRequest?: { repo: string; number: number; url: string };
  changes?: string[];
}

function parseJson<T>(text: string | null | undefined): T | undefined {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/**
 * The current (not superseded) review targets with where each stands, newest first. Cancelled
 * runs are not reviewable. Reads Router's DB only.
 */
export function listReviewQueue(
  db: Database.Database,
  filter: ReviewQueueFilter = {},
): ReviewQueueItem[] {
  const states = new Set(filter.states ?? WAITING_STATES);
  const rows = db
    .prepare(
      `SELECT t.*, a.approval_id AS current_approval_id, a.input_snapshot AS snapshot,
              r.payload AS result_payload
       FROM review_targets t
       LEFT JOIN approvals a ON a.issue_key = t.issue_key
       LEFT JOIN results r ON r.id = t.id
       WHERE t.superseded_by IS NULL AND t.final_state <> 'cancelled'
       ORDER BY t.created_at DESC, t.rowid DESC`,
    )
    .all() as Array<Record<string, unknown>>;
  const items: ReviewQueueItem[] = [];
  for (const row of rows) {
    const target = toTarget(row);
    if (filter.reviewClass && target.reviewClass !== filter.reviewClass) continue;
    const snapshot = parseJson<StoredSnapshot>(row.snapshot as string | null)?.issue;
    const issue = {
      summary: snapshot?.summary ?? null,
      assigneeAccountId: snapshot?.assigneeAccountId ?? null,
      parentKey: snapshot?.parentKey ?? null,
    };
    if (filter.assigneeAccountId && issue.assigneeAccountId !== filter.assigneeAccountId) continue;
    if (filter.parentKey && issue.parentKey !== filter.parentKey) continue;
    const judgment = latestJudgment(db, target.id) ?? null;
    const state = queueState(db, target, row.current_approval_id as string | null, judgment);
    if (!states.has(state)) continue;
    const result = parseJson<StoredResult>(row.result_payload as string | null);
    items.push({
      target,
      state,
      judgment,
      issue,
      result: {
        summary: result?.summary ?? null,
        branch: result?.branch ?? null,
        pullRequest: result?.pullRequest
          ? {
              repo: result.pullRequest.repo,
              number: result.pullRequest.number,
              url: result.pullRequest.url,
            }
          : null,
        changes: result?.changes ?? [],
      },
    });
  }
  return items;
}

function queueState(
  db: Database.Database,
  target: ReviewTargetRow,
  currentApprovalId: string | null,
  judgment: ReviewRecordRow | null,
): ReviewQueueState {
  if (mergedWithTarget(db, target.id)) return "merged";
  if (judgment?.action === judgmentRecordAction("confirm")) return "confirmed";
  if (judgment?.action === judgmentRecordAction("rework")) return "rework_requested";
  if (currentApprovalId !== null && currentApprovalId !== target.approvalId) return "outdated";
  if (judgment?.action === judgmentRecordAction("hold")) return "held";
  return "pending";
}

/** How many current targets still wait on a human (`pending` or `held`). */
export function countWaitingReviews(db: Database.Database): number {
  return listReviewQueue(db).length;
}

/**
 * Whether a human accepted the issue's current result: confirmed it on the review screen, or
 * merged the reviewed pull request (ADR 0044 counts that as a dependency done; reaching the review
 * status alone does not).
 */
export function isLatestReviewConfirmed(db: Database.Database, issueKey: string): boolean {
  const current = listReviewTargets(db, issueKey)[0];
  if (!current || current.supersededBy !== null || current.kind !== "implementation") return false;
  if (mergedWithTarget(db, current.id)) return true;
  return latestJudgment(db, current.id)?.action === judgmentRecordAction("confirm");
}
