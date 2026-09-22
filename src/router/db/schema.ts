import { ACTIVE_ATTEMPT_STATES, ATTEMPT_STATES } from "../../contracts/attempt-state.js";
import type { JobState } from "../../contracts/job-state.js";
import { JOB_STATES } from "../../contracts/job-state.js";

/**
 * SQLite schema for Router's execution store (docs/router-service-implementation-plan.md §3
 * "SQLite에는 다음을 저장"). Jira remains the source of truth for work status and
 * human approval; this DB is the source of truth for job/attempt/lease state.
 *
 * The two DB-enforced invariants the plan calls out by name:
 *   - "이슈당 비종결 작업 하나": a partial unique index on jobs(issue_key), scoped
 *     to states that still occupy the slot (contracts/job-state.ts's `isJobStateClosed`).
 *   - "워커당 활성 attempt 하나": a partial unique index on attempts(worker_id),
 *     scoped to states in which the job is actually leased to that worker
 *     (contracts/job-state.ts's `ACTIVE_ATTEMPT_JOB_STATES`).
 */

const jobStateList = JOB_STATES.map((state) => `'${state}'`).join(", ");
const closedJobStates: readonly JobState[] = ["succeeded", "cancelled"];
const closedJobStateList = closedJobStates.map((state) => `'${state}'`).join(", ");
const activeAttemptStateList = [...ACTIVE_ATTEMPT_STATES].map((state) => `'${state}'`).join(", ");
const attemptStateList = ATTEMPT_STATES.map((state) => `'${state}'`).join(", ");

export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`,

  // Webhook deliveries, deduplicated by (site_id, webhook_delivery_id) per §2 "웹훅과 보완 조회".
  `CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL,
    webhook_delivery_id TEXT NOT NULL,
    received_at TEXT NOT NULL,
    processed_at TEXT,
    payload TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_events_delivery
    ON events (site_id, webhook_delivery_id)`,

  // One row per issue: its current approval identifier and the input snapshot/hash it was
  // computed from (§3 "이슈별 승인 식별자·작업 입력 스냅샷").
  `CREATE TABLE IF NOT EXISTS approvals (
    issue_key TEXT PRIMARY KEY,
    approval_id TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    input_snapshot TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    issue_key TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    repository_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('planning', 'implementation')),
    approval_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN (${jobStateList})),
    pinned_worker_id TEXT,
    required_capabilities TEXT NOT NULL DEFAULT '[]',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    current_attempt_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    closed_at TEXT
  )`,
  // The one-non-terminal-job-per-issue constraint: any number of closed rows may exist for an
  // issue, but at most one row may sit in a state that still occupies the slot.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_open_per_issue
    ON jobs (issue_key)
    WHERE state NOT IN (${closedJobStateList})`,
  "CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs (state)",

  `CREATE TABLE IF NOT EXISTS attempts (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs (id),
    worker_id TEXT NOT NULL,
    lease_token TEXT NOT NULL,
    leased_at TEXT NOT NULL,
    lease_expires_at TEXT NOT NULL,
    started_at TEXT,
    ended_at TEXT,
    state TEXT NOT NULL CHECK (state IN (${attemptStateList})),
    result_id TEXT
  )`,
  // The one-active-attempt-per-worker constraint.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_attempts_active_per_worker
    ON attempts (worker_id)
    WHERE state IN (${activeAttemptStateList})`,
  "CREATE INDEX IF NOT EXISTS idx_attempts_job ON attempts (job_id)",

  `CREATE TABLE IF NOT EXISTS workers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    last_seen_at TEXT,
    revoked_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS pairing_codes (
    code TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  )`,

  // Worker-submitted results, keyed by the client-generated resultId so a resend of the exact
  // same result is a no-op (§3 "같은 결과의 재전송은 성공 처리한다").
  `CREATE TABLE IF NOT EXISTS results (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs (id),
    attempt_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    received_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_results_job ON results (job_id)",

  // Jira-reflection journal: a result's effect on Jira is applied and retried independently of
  // the execution result itself (§3 "Jira 반영 상태는 실행 상태와 별개로 관리한다").
  `CREATE TABLE IF NOT EXISTS jira_writes (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs (id),
    result_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'failed')),
    created_at TEXT NOT NULL,
    applied_at TEXT,
    error TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS idx_jira_writes_status ON jira_writes (status)",

  `CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    actor TEXT,
    action TEXT NOT NULL,
    subject TEXT,
    detail TEXT
  )`,
];
