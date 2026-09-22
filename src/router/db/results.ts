import type Database from "better-sqlite3";
import { isUniqueConstraintViolation } from "./errors.js";

export interface ResultRow {
  id: string;
  jobId: string;
  attemptId: string;
  payload: string;
  receivedAt: string;
  /** False when the result was kept only as an audit record and did not move job state. */
  applied: boolean;
}

/** Same `resultId`, different content (§3 "동일 resultId의 다른 내용은 409로 거부한다"). */
export class ResultConflictError extends Error {
  constructor(readonly resultId: string) {
    super(`Result ${resultId} was already submitted with different content`);
    this.name = "ResultConflictError";
  }
}

export interface RecordResultInput {
  resultId: string;
  jobId: string;
  attemptId: string;
  /** Canonical serialized result. Compared byte-for-byte against an earlier submission. */
  payload: string;
  applied: boolean;
  now: string;
}

function toResultRow(row: Record<string, unknown>): ResultRow {
  return {
    id: row.id as string,
    jobId: row.job_id as string,
    attemptId: row.attempt_id as string,
    payload: row.payload as string,
    receivedAt: row.received_at as string,
    applied: (row.applied as number) === 1,
  };
}

export function getResult(db: Database.Database, resultId: string): ResultRow | undefined {
  const row = db.prepare("SELECT * FROM results WHERE id = ?").get(resultId) as
    | Record<string, unknown>
    | undefined;
  return row ? toResultRow(row) : undefined;
}

/**
 * Stores a worker result keyed by its client-generated `resultId`. An identical resend returns
 * `"duplicate"` with the originally stored row (so the caller can answer with the same
 * `applied` value); a different payload under the same id throws `ResultConflictError`.
 */
export function recordResult(
  db: Database.Database,
  input: RecordResultInput,
): { outcome: "recorded" | "duplicate"; row: ResultRow } {
  const existing = getResult(db, input.resultId);
  if (existing) {
    if (existing.payload !== input.payload) throw new ResultConflictError(input.resultId);
    return { outcome: "duplicate", row: existing };
  }
  try {
    db.prepare(
      "INSERT INTO results (id, job_id, attempt_id, payload, received_at, applied) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      input.resultId,
      input.jobId,
      input.attemptId,
      input.payload,
      input.now,
      input.applied ? 1 : 0,
    );
  } catch (error) {
    if (isUniqueConstraintViolation(error)) throw new ResultConflictError(input.resultId);
    throw error;
  }
  const row = getResult(db, input.resultId);
  if (!row) throw new Error(`recordResult: row for ${input.resultId} not found after insert`);
  return { outcome: "recorded", row };
}

export function listResultsForAttempt(db: Database.Database, attemptId: string): ResultRow[] {
  const rows = db
    .prepare("SELECT * FROM results WHERE attempt_id = ? ORDER BY received_at ASC")
    .all(attemptId) as Record<string, unknown>[];
  return rows.map(toResultRow);
}
