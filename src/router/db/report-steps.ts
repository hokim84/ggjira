import type Database from "better-sqlite3";
import type { REPORT_STEP_STATUSES } from "./schema.js";

export type ReportStepStatus = (typeof REPORT_STEP_STATUSES)[number];

/** Terminal for the processor: nothing more happens to the step without an admin retry. */
const SETTLED_STATUSES: ReadonlySet<ReportStepStatus> = new Set(["applied", "skipped"]);
/** Waiting for a human (`ggjira router reports retry`); the rest of its batch waits too. */
const BLOCKED_STATUSES: ReadonlySet<ReportStepStatus> = new Set(["failed", "recovery_required"]);

export interface ReportStepRow {
  id: string;
  batchId: string;
  resultId: string | null;
  jobId: string;
  attemptId: string;
  issueKey: string;
  seq: number;
  kind: string;
  params: Record<string, unknown>;
  status: ReportStepStatus;
  /** What the step produced (e.g. `{ key }` of a created subtask), read by later steps. */
  outcome: Record<string, unknown> | null;
  tries: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewReportStep {
  kind: string;
  params: Record<string, unknown>;
}

function toReportStepRow(row: Record<string, unknown>): ReportStepRow {
  return {
    id: row.id as string,
    batchId: row.batch_id as string,
    resultId: (row.result_id as string | null) ?? null,
    jobId: row.job_id as string,
    attemptId: row.attempt_id as string,
    issueKey: row.issue_key as string,
    seq: row.seq as number,
    kind: row.kind as string,
    params: JSON.parse(row.params as string) as Record<string, unknown>,
    status: row.status as ReportStepStatus,
    outcome: row.outcome ? (JSON.parse(row.outcome as string) as Record<string, unknown>) : null,
    tries: row.tries as number,
    lastError: (row.last_error as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/**
 * Writes one batch of Jira side effects up front. For a result batch this runs inside the same
 * transaction that stores the result (§3 "Router는 결과 저장과 Jira 반영 작업 생성을 한 트랜잭션으로
 * 처리한다"), so a stored result can never lack its journal; `(batch_id, seq)` uniqueness means a
 * resent result or a replayed `start` can never journal twice (`INSERT OR IGNORE`).
 */
export function insertReportBatch(
  db: Database.Database,
  input: {
    batchId: string;
    resultId?: string;
    jobId: string;
    attemptId: string;
    issueKey: string;
    steps: readonly NewReportStep[];
    now: string;
  },
): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO report_steps (
      id, batch_id, result_id, job_id, attempt_id, issue_key, seq, kind, params, status, outcome,
      tries, last_error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, 0, NULL, ?, ?)`,
  );
  input.steps.forEach((step, seq) => {
    insert.run(
      `${input.batchId}:${seq}`,
      input.batchId,
      input.resultId ?? null,
      input.jobId,
      input.attemptId,
      input.issueKey,
      seq,
      step.kind,
      JSON.stringify(step.params),
      input.now,
      input.now,
    );
  });
}

/** Every step of a job's journal, in execution (insertion) order. */
export function listJobReportSteps(db: Database.Database, jobId: string): ReportStepRow[] {
  const rows = db
    .prepare("SELECT * FROM report_steps WHERE job_id = ? ORDER BY rowid ASC")
    .all(jobId) as Record<string, unknown>[];
  return rows.map(toReportStepRow);
}

export function listBatchReportSteps(db: Database.Database, batchId: string): ReportStepRow[] {
  const rows = db
    .prepare("SELECT * FROM report_steps WHERE batch_id = ? ORDER BY seq ASC")
    .all(batchId) as Record<string, unknown>[];
  return rows.map(toReportStepRow);
}

export function getReportStep(db: Database.Database, stepId: string): ReportStepRow | undefined {
  const row = db.prepare("SELECT * FROM report_steps WHERE id = ?").get(stepId) as
    | Record<string, unknown>
    | undefined;
  return row ? toReportStepRow(row) : undefined;
}

/** Jobs whose journal still has a step the processor can act on (`pending`/`uncertain`), in the
 *  order their oldest such step was written. */
export function listJobIdsWithReportWork(db: Database.Database): string[] {
  const rows = db
    .prepare(
      `SELECT job_id, MIN(rowid) AS first FROM report_steps
       WHERE status IN ('pending', 'uncertain')
       GROUP BY job_id ORDER BY first ASC`,
    )
    .all() as Array<{ job_id: string }>;
  return rows.map((row) => row.job_id);
}

/** Steps a human must look at (`failed` or `recovery_required`), across all jobs. */
export function listBlockedReportSteps(db: Database.Database): ReportStepRow[] {
  const rows = db
    .prepare(
      "SELECT * FROM report_steps WHERE status IN ('failed', 'recovery_required') ORDER BY rowid ASC",
    )
    .all() as Record<string, unknown>[];
  return rows.map(toReportStepRow);
}

export function updateReportStep(
  db: Database.Database,
  stepId: string,
  update: {
    status: ReportStepStatus;
    outcome?: Record<string, unknown> | null;
    error?: string | null;
    countTry?: boolean;
    now: string;
  },
): void {
  db.prepare(
    `UPDATE report_steps SET
       status = ?,
       outcome = COALESCE(?, outcome),
       last_error = ?,
       tries = tries + ?,
       updated_at = ?
     WHERE id = ?`,
  ).run(
    update.status,
    update.outcome ? JSON.stringify(update.outcome) : null,
    update.error ?? null,
    update.countTry ? 1 : 0,
    update.now,
    stepId,
  );
}

/** Admin retry (§4 "ggjira router reports retry"): puts every `failed`/`recovery_required` step of
 *  a batch back to `pending`. A `pending` subtask creation looks for its marker before creating,
 *  so this is the explicit human go-ahead the plan requires before re-sending a create. */
export function requeueBlockedReportSteps(
  db: Database.Database,
  batchId: string,
  now: string,
): number {
  return db
    .prepare(
      `UPDATE report_steps SET status = 'pending', last_error = NULL, updated_at = ?
       WHERE batch_id = ? AND status IN ('failed', 'recovery_required')`,
    )
    .run(now, batchId).changes;
}

export function isReportStepSettled(status: ReportStepStatus): boolean {
  return SETTLED_STATUSES.has(status);
}

export function isReportStepBlocked(status: ReportStepStatus): boolean {
  return BLOCKED_STATUSES.has(status);
}
