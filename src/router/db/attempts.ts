import type Database from "better-sqlite3";
import {
  ACTIVE_ATTEMPT_STATES,
  assertAttemptStateTransition,
  type AttemptState,
  isAttemptStateTerminal,
} from "../../contracts/attempt-state.js";
import { isUniqueConstraintViolation } from "./errors.js";

export interface AttemptRow {
  id: string;
  jobId: string;
  workerId: string;
  leaseToken: string;
  leasedAt: string;
  leaseExpiresAt: string;
  startedAt: string | null;
  endedAt: string | null;
  state: AttemptState;
  resultId: string | null;
}

export interface LeaseAttemptInput {
  id: string;
  jobId: string;
  workerId: string;
  leaseToken: string;
  leaseExpiresAt: string;
  /** ISO timestamp. Caller-supplied so tests can use a fake clock. */
  now: string;
}

/** Thrown when a worker already holds an active attempt lease
 *  (docs/router-service-implementation-plan.md §3 "워커당 활성 attempt 하나" — enforced
 *  by the `idx_attempts_active_per_worker` partial unique index). */
export class WorkerAlreadyLeasedError extends Error {
  constructor(readonly workerId: string) {
    super(`Worker ${workerId} already holds an active attempt lease`);
    this.name = "WorkerAlreadyLeasedError";
  }
}

function toAttemptRow(row: Record<string, unknown>): AttemptRow {
  return {
    id: row.id as string,
    jobId: row.job_id as string,
    workerId: row.worker_id as string,
    leaseToken: row.lease_token as string,
    leasedAt: row.leased_at as string,
    leaseExpiresAt: row.lease_expires_at as string,
    startedAt: (row.started_at as string | null) ?? null,
    endedAt: (row.ended_at as string | null) ?? null,
    state: row.state as AttemptState,
    resultId: (row.result_id as string | null) ?? null,
  };
}

/**
 * Creates a new attempt row leased to `input.workerId` and stamps the job's
 * `current_attempt_id`/`attempt_count` bookkeeping in the same transaction.
 * Does not touch `jobs.state` — the caller (Router's scheduler, stage 2)
 * decides when to move the job to `leased` via `transitionJobState`; this is
 * a storage-layer primitive, not a scheduling decision.
 */
export function leaseAttempt(db: Database.Database, input: LeaseAttemptInput): AttemptRow {
  const insertAndBookkeep = db.transaction(() => {
    try {
      db.prepare(
        `INSERT INTO attempts (
          id, job_id, worker_id, lease_token, leased_at, lease_expires_at,
          started_at, ended_at, state, result_id
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 'leased', NULL)`,
      ).run(
        input.id,
        input.jobId,
        input.workerId,
        input.leaseToken,
        input.now,
        input.leaseExpiresAt,
      );
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        throw new WorkerAlreadyLeasedError(input.workerId);
      }
      throw error;
    }
    db.prepare(
      "UPDATE jobs SET current_attempt_id = ?, attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?",
    ).run(input.id, input.now, input.jobId);
  });
  insertAndBookkeep();

  const attempt = getAttempt(db, input.id);
  if (!attempt) {
    throw new Error(`leaseAttempt: row for ${input.id} not found immediately after insert`);
  }
  return attempt;
}

export function getAttempt(db: Database.Database, attemptId: string): AttemptRow | undefined {
  const row = db.prepare("SELECT * FROM attempts WHERE id = ?").get(attemptId) as
    | Record<string, unknown>
    | undefined;
  return row ? toAttemptRow(row) : undefined;
}

/** The active attempt (if any) occupying this worker's one-active-attempt slot. */
export function getActiveAttemptForWorker(
  db: Database.Database,
  workerId: string,
): AttemptRow | undefined {
  const placeholders = [...ACTIVE_ATTEMPT_STATES].map(() => "?").join(", ");
  const row = db
    .prepare(`SELECT * FROM attempts WHERE worker_id = ? AND state IN (${placeholders})`)
    .get(workerId, ...ACTIVE_ATTEMPT_STATES) as Record<string, unknown> | undefined;
  return row ? toAttemptRow(row) : undefined;
}

/**
 * Moves an attempt along the state machine in `contracts/attempt-state.ts`,
 * throwing `InvalidAttemptStateTransitionError` for any arrow not in that
 * diagram. Stamps `started_at` on the first move into `running` and
 * `ended_at` on any terminal state.
 */
export function transitionAttemptState(
  db: Database.Database,
  attemptId: string,
  to: AttemptState,
  now: string,
): AttemptRow {
  const attempt = getAttempt(db, attemptId);
  if (!attempt) throw new Error(`transitionAttemptState: no attempt with id ${attemptId}`);
  assertAttemptStateTransition(attempt.state, to);

  const startedAt = to === "running" && !attempt.startedAt ? now : attempt.startedAt;
  const endedAt = isAttemptStateTerminal(to) ? now : attempt.endedAt;
  db.prepare("UPDATE attempts SET state = ?, started_at = ?, ended_at = ? WHERE id = ?").run(
    to,
    startedAt,
    endedAt,
    attemptId,
  );
  return { ...attempt, state: to, startedAt, endedAt };
}
