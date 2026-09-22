import type Database from "better-sqlite3";
import type { JobKind } from "../../contracts/protocol.js";
import {
  assertJobStateTransition,
  isJobStateClosed,
  type JobState,
} from "../../contracts/job-state.js";
import { isUniqueConstraintViolation } from "./errors.js";

export interface JobRow {
  id: string;
  issueKey: string;
  workspaceId: string;
  repositoryId: string;
  kind: JobKind;
  approvalId: string;
  /** Input hash the job was dispatched with (null for rows created before migration 2). */
  inputHash: string | null;
  state: JobState;
  pinnedWorkerId: string | null;
  requiredCapabilities: string[];
  attemptCount: number;
  currentAttemptId: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface CreateJobInput {
  id: string;
  issueKey: string;
  workspaceId: string;
  repositoryId: string;
  kind: JobKind;
  approvalId: string;
  inputHash?: string | null;
  /** Defaults to "queued". A caller may pass "waiting" for a job that's blocked
   *  on an unmet dependency (scheduler decision, not a storage-layer one). */
  state?: JobState;
  pinnedWorkerId?: string | null;
  requiredCapabilities?: readonly string[];
  /** ISO timestamp. Caller-supplied so tests can use a fake clock. */
  now: string;
}

/** Thrown when a job would occupy a second non-terminal slot for an issue that
 *  already has one (docs/router-service-implementation-plan.md §3 "이슈당 비종결 작업
 *  하나" — enforced by the `idx_jobs_open_per_issue` partial unique index). */
export class DuplicateOpenJobError extends Error {
  constructor(readonly issueKey: string) {
    super(`Issue ${issueKey} already has an open (non-terminal) job`);
    this.name = "DuplicateOpenJobError";
  }
}

function toJobRow(row: Record<string, unknown>): JobRow {
  return {
    id: row.id as string,
    issueKey: row.issue_key as string,
    workspaceId: row.workspace_id as string,
    repositoryId: row.repository_id as string,
    kind: row.kind as JobKind,
    approvalId: row.approval_id as string,
    inputHash: (row.input_hash as string | null) ?? null,
    state: row.state as JobState,
    pinnedWorkerId: (row.pinned_worker_id as string | null) ?? null,
    requiredCapabilities: JSON.parse(row.required_capabilities as string) as string[],
    attemptCount: row.attempt_count as number,
    currentAttemptId: (row.current_attempt_id as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    closedAt: (row.closed_at as string | null) ?? null,
  };
}

export function createJob(db: Database.Database, input: CreateJobInput): JobRow {
  const state = input.state ?? "queued";
  try {
    db.prepare(
      `INSERT INTO jobs (
        id, issue_key, workspace_id, repository_id, kind, approval_id, input_hash, state,
        pinned_worker_id, required_capabilities, attempt_count, current_attempt_id,
        created_at, updated_at, closed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, NULL)`,
    ).run(
      input.id,
      input.issueKey,
      input.workspaceId,
      input.repositoryId,
      input.kind,
      input.approvalId,
      input.inputHash ?? null,
      state,
      input.pinnedWorkerId ?? null,
      JSON.stringify(input.requiredCapabilities ?? []),
      input.now,
      input.now,
    );
  } catch (error) {
    if (isUniqueConstraintViolation(error)) {
      throw new DuplicateOpenJobError(input.issueKey);
    }
    throw error;
  }
  const job = getJob(db, input.id);
  if (!job) throw new Error(`createJob: row for ${input.id} not found immediately after insert`);
  return job;
}

export function getJob(db: Database.Database, jobId: string): JobRow | undefined {
  const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as
    | Record<string, unknown>
    | undefined;
  return row ? toJobRow(row) : undefined;
}

/** The issue's one non-terminal job, if it has one (§3 "이슈당 비종결 작업 하나"). */
export function getOpenJobForIssue(db: Database.Database, issueKey: string): JobRow | undefined {
  const row = db
    .prepare("SELECT * FROM jobs WHERE issue_key = ? AND state NOT IN ('succeeded', 'cancelled')")
    .get(issueKey) as Record<string, unknown> | undefined;
  return row ? toJobRow(row) : undefined;
}

/** Jobs ready to be leased to a worker, oldest first (scheduler's assignment pass). */
export function getQueuedJobs(db: Database.Database): JobRow[] {
  const rows = db
    .prepare("SELECT * FROM jobs WHERE state = 'queued' ORDER BY created_at ASC")
    .all() as Record<string, unknown>[];
  return rows.map(toJobRow);
}

/** Every job still occupying the one-non-terminal-job-per-issue slot, regardless of state. */
export function getOpenJobs(db: Database.Database): JobRow[] {
  const rows = db
    .prepare("SELECT * FROM jobs WHERE state NOT IN ('succeeded', 'cancelled')")
    .all() as Record<string, unknown>[];
  return rows.map(toJobRow);
}

/**
 * Moves a job along the state machine in `contracts/job-state.ts`, throwing
 * `InvalidJobStateTransitionError` for any arrow not in that diagram. Does
 * not touch `attempts` — leasing/attempt bookkeeping lives in `attempts.ts`.
 */
export function transitionJobState(
  db: Database.Database,
  jobId: string,
  to: JobState,
  now: string,
): JobRow {
  const job = getJob(db, jobId);
  if (!job) throw new Error(`transitionJobState: no job with id ${jobId}`);
  assertJobStateTransition(job.state, to);
  const closedAt = isJobStateClosed(to) ? now : job.closedAt;
  db.prepare("UPDATE jobs SET state = ?, updated_at = ?, closed_at = ? WHERE id = ?").run(
    to,
    now,
    closedAt,
    jobId,
  );
  return { ...job, state: to, updatedAt: now, closedAt };
}
