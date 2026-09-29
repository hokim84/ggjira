import type Database from "better-sqlite3";
import { type JevAnswer, JevAnswerSchema } from "../jev.js";
import type { JobRow } from "./jobs.js";
import { getJob } from "./jobs.js";

export interface JobAssessmentRow {
  jobId: string;
  model: string | null;
  answers: Record<string, JevAnswer> | null;
  error: string | null;
  tries: number;
  inputTokens: number | null;
  latencyMs: number | null;
  createdAt: string;
  updatedAt: string;
}

function parseAnswers(json: string | null): Record<string, JevAnswer> | null {
  if (!json) return null;
  const answers: Record<string, JevAnswer> = {};
  for (const [key, value] of Object.entries(JSON.parse(json) as Record<string, unknown>)) {
    const parsed = JevAnswerSchema.safeParse(value);
    if (parsed.success) answers[key] = parsed.data;
  }
  return answers;
}

function toRow(row: Record<string, unknown>): JobAssessmentRow {
  return {
    jobId: row.job_id as string,
    model: (row.model as string | null) ?? null,
    answers: parseAnswers((row.answers_json as string | null) ?? null),
    error: (row.error as string | null) ?? null,
    tries: row.tries as number,
    inputTokens: (row.input_tokens as number | null) ?? null,
    latencyMs: (row.latency_ms as number | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function getAssessment(db: Database.Database, jobId: string): JobAssessmentRow | undefined {
  const row = db.prepare("SELECT * FROM job_assessments WHERE job_id = ?").get(jobId) as
    | Record<string, unknown>
    | undefined;
  return row ? toRow(row) : undefined;
}

/**
 * Jobs created at or after `since` that have no answer yet and have failed fewer than `maxTries`
 * times, oldest first.
 */
export function listJobsToAssess(
  db: Database.Database,
  input: { since: string; maxTries: number; limit: number },
): JobRow[] {
  const ids = db
    .prepare(
      `SELECT j.id FROM jobs j
       LEFT JOIN job_assessments a ON a.job_id = j.id
       WHERE j.created_at >= ?
         AND (a.job_id IS NULL OR (a.answers_json IS NULL AND a.tries < ?))
       ORDER BY j.created_at ASC
       LIMIT ?`,
    )
    .all(input.since, input.maxTries, input.limit) as Array<{ id: string }>;
  return ids.map(({ id }) => getJob(db, id)).filter((job): job is JobRow => job !== undefined);
}

export function recordAssessment(
  db: Database.Database,
  input: {
    jobId: string;
    model: string;
    answers: Record<string, JevAnswer>;
    inputTokens: number | null;
    latencyMs: number;
    now: string;
  },
): void {
  db.prepare(
    `INSERT INTO job_assessments
       (job_id, model, answers_json, error, tries, input_tokens, latency_ms, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 1, ?, ?, ?, ?)
     ON CONFLICT (job_id) DO UPDATE SET
       model = excluded.model, answers_json = excluded.answers_json, error = NULL,
       tries = job_assessments.tries + 1, input_tokens = excluded.input_tokens,
       latency_ms = excluded.latency_ms, updated_at = excluded.updated_at`,
  ).run(
    input.jobId,
    input.model,
    JSON.stringify(input.answers),
    input.inputTokens,
    input.latencyMs,
    input.now,
    input.now,
  );
}

export function recordAssessmentFailure(
  db: Database.Database,
  input: { jobId: string; error: string; now: string },
): void {
  db.prepare(
    `INSERT INTO job_assessments (job_id, error, tries, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?)
     ON CONFLICT (job_id) DO UPDATE SET
       error = excluded.error, tries = job_assessments.tries + 1, updated_at = excluded.updated_at`,
  ).run(input.jobId, input.error, input.now, input.now);
}

export interface AssessmentListItem {
  job: JobRow;
  assessment: JobAssessmentRow;
}

/** Newest assessed jobs first, with their job row, for evaluating Jev against outcomes. */
export function listAssessments(db: Database.Database, limit: number): AssessmentListItem[] {
  const rows = db
    .prepare(
      `SELECT a.* FROM job_assessments a JOIN jobs j ON j.id = a.job_id
       ORDER BY j.created_at DESC LIMIT ?`,
    )
    .all(limit) as Record<string, unknown>[];
  return rows.flatMap((row) => {
    const assessment = toRow(row);
    const job = getJob(db, assessment.jobId);
    return job ? [{ job, assessment }] : [];
  });
}
