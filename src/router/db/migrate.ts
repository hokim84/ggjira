import type Database from "better-sqlite3";
import {
  ADMIN_OPERATIONS_STATEMENTS,
  ATTENTION_STATEMENTS,
  EXECUTION_RECORD_STATEMENTS,
  GITHUB_STATEMENTS,
  JOB_ASSESSMENT_STATEMENTS,
  PLAN_DELEGATION_STATEMENTS,
  READINESS_HOLD_CLOSE_STATEMENTS,
  PROVIDER_USAGE_STATEMENTS,
  PULL_REQUEST_CHECK_STATEMENTS,
  READINESS_HOLD_STATEMENTS,
  REPORT_JOURNAL_STATEMENTS,
  REVIEW_TARGET_STATEMENTS,
  WORKER_REPOSITORY_PATH_STATEMENTS,
  SCHEMA_STATEMENTS,
  WORKER_PROTOCOL_STATEMENTS,
} from "./schema.js";

interface Migration {
  version: number;
  description: string;
  up(db: Database.Database): void;
}

/**
 * Append-only migration list. Each entry runs exactly once, in a transaction,
 * recorded in `schema_migrations` (docs/router-service-implementation-plan.md §3 "SQLite
 * migration"). Never edit a migration that has already shipped — add a new one.
 */
const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description:
      "initial schema: events, approvals, jobs, attempts, workers, results, jira_writes, audit_log",
    up(db) {
      for (const statement of SCHEMA_STATEMENTS) db.exec(statement);
    },
  },
  {
    version: 2,
    description:
      "worker protocol: pairing worker_id, worker availability/session columns, worker_sessions, attempt session/request ids, results.applied",
    up(db) {
      for (const statement of WORKER_PROTOCOL_STATEMENTS) db.exec(statement);
    },
  },
  {
    version: 3,
    description: "Jira reporting journal: report_steps (replaces the never-used jira_writes)",
    up(db) {
      for (const statement of REPORT_JOURNAL_STATEMENTS) db.exec(statement);
    },
  },
  {
    version: 4,
    description: "admin operations: admin_holds (an admin-cancelled approval is not re-dispatched)",
    up(db) {
      for (const statement of ADMIN_OPERATIONS_STATEMENTS) db.exec(statement);
    },
  },
  {
    version: 5,
    description: "GitHub pull requests: pull_requests, github_deliveries (ADR 0027)",
    up(db) {
      for (const statement of GITHUB_STATEMENTS) db.exec(statement);
    },
  },
  {
    version: 6,
    description: "worker plan usage: worker_provider_usage (ADR 0028)",
    up(db) {
      for (const statement of PROVIDER_USAGE_STATEMENTS) db.exec(statement);
    },
  },
  {
    version: 7,
    description: "Jev shadow assessments: job_assessments (ADR 0030)",
    up(db) {
      for (const statement of JOB_ASSESSMENT_STATEMENTS) db.exec(statement);
    },
  },
  {
    version: 8,
    description: "workers.reported_repository_paths (local paths shown in the admin view)",
    up(db) {
      for (const statement of WORKER_REPOSITORY_PATH_STATEMENTS) db.exec(statement);
    },
  },
  {
    version: 9,
    description: "pull_requests.last_checked_at/last_error (GitHub poll status, ADR 0032)",
    up(db) {
      for (const statement of PULL_REQUEST_CHECK_STATEMENTS) db.exec(statement);
    },
  },
  {
    version: 10,
    description:
      "readiness_holds (implementation requests held for an incomplete contract, ADR 0034)",
    up(db) {
      for (const statement of READINESS_HOLD_STATEMENTS) db.exec(statement);
    },
  },
  {
    version: 11,
    description: "review_targets, review_records (what a human reviews, pinned to a result; M4-11)",
    up(db) {
      for (const statement of REVIEW_TARGET_STATEMENTS) db.exec(statement);
    },
  },
  {
    version: 12,
    description: "attention_items (what a human must look at, grouped by incident; M4-09)",
    up(db) {
      for (const statement of ATTENTION_STATEMENTS) db.exec(statement);
    },
  },
  {
    version: 13,
    description: "execution_records (provider call and usage behind every result; M4-12)",
    up(db) {
      for (const statement of EXECUTION_RECORD_STATEMENTS) db.exec(statement);
    },
  },
  {
    version: 14,
    description: "plan_reviews, plan_deployments (status delegation, plan approval; ADR 0044)",
    up(db) {
      for (const statement of PLAN_DELEGATION_STATEMENTS) db.exec(statement);
    },
  },
  {
    version: 15,
    description: "close open readiness holds and their attention items (ADR 0047)",
    up(db) {
      for (const statement of READINESS_HOLD_CLOSE_STATEMENTS) db.exec(statement);
    },
  },
  {
    version: 16,
    description: "single AI review: durable planning requests and upgrade baseline",
    up(db) {
      db.exec(`CREATE TABLE planning_requests (
        id TEXT PRIMARY KEY, issue_key TEXT NOT NULL, entry_id TEXT NOT NULL,
        input_hash TEXT NOT NULL, input_snapshot TEXT NOT NULL DEFAULT '{}',
        source_comment_id TEXT, decision TEXT,
        created_at TEXT NOT NULL, ready_history TEXT,
        UNIQUE(issue_key, source_comment_id));
        CREATE INDEX planning_requests_issue ON planning_requests(issue_key);
        CREATE TABLE planning_baselines (issue_key TEXT PRIMARY KEY, cutoff TEXT NOT NULL);`);
      const cutoff = new Date().toISOString();
      db.prepare("INSERT INTO planning_baselines SELECT DISTINCT issue_key, ? FROM jobs").run(
        cutoff,
      );
      db.prepare(
        "UPDATE plan_reviews SET closed_at = ?, closed_reason = 'single AI review upgrade; delegate again' WHERE closed_at IS NULL",
      ).run(cutoff);
      db.prepare(
        "UPDATE plan_deployments SET state = 'revoked', reason = 'single AI review upgrade; delegate again', updated_at = ? WHERE state IN ('active','waiting_plan_apply')",
      ).run(cutoff);
    },
  },
];

interface MigrationRow {
  version: number;
}

export function runMigrations(db: Database.Database): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const applied = new Set(
    db
      .prepare("SELECT version FROM schema_migrations")
      .all()
      .map((row) => (row as MigrationRow).version),
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    const apply = db.transaction(() => {
      migration.up(db);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        migration.version,
        new Date().toISOString(),
      );
    });
    apply();
  }
}

export function currentSchemaVersion(db: Database.Database): number {
  const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as
    | { version: number | null }
    | undefined;
  return row?.version ?? 0;
}
