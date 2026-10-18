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
