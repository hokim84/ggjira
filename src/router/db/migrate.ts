import type Database from "better-sqlite3";
import {
  ADMIN_OPERATIONS_STATEMENTS,
  ATTENTION_STATEMENTS,
  EXECUTION_RECORD_STATEMENTS,
  GITHUB_STATEMENTS,
  JOB_ASSESSMENT_STATEMENTS,
  PLAN_DELEGATION_STATEMENTS,
  PROVIDER_USAGE_STATEMENTS,
  PULL_REQUEST_CHECK_STATEMENTS,
  READINESS_HOLD_CLOSE_STATEMENTS,
  READINESS_HOLD_STATEMENTS,
  REPORT_JOURNAL_STATEMENTS,
  REVIEW_TARGET_STATEMENTS,
  SCHEMA_STATEMENTS,
  WORKER_PROTOCOL_STATEMENTS,
  WORKER_REPOSITORY_PATH_STATEMENTS,
} from "./schema.js";

interface Migration {
  version: number;
  description: string;
  rebuildJobs?: boolean;
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
  {
    version: 17,
    description: "versioned child execution and parent quality review",
    rebuildJobs: true,
    up(db) {
      // Rebuild the constrained table without renaming the original: dependent FK targets
      // remain jobs. The runner disables FK enforcement outside this transaction only.
      const table = db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='jobs'")
        .get() as { sql: string };
      const indexes = db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='jobs' AND sql IS NOT NULL",
        )
        .all() as { sql: string }[];
      db.exec(
        table.sql
          .replace(/CREATE TABLE(?: IF NOT EXISTS)? ["`]?jobs["`]?/i, "CREATE TABLE jobs_new")
          .replace(
            "'planning', 'implementation')",
            "'planning', 'implementation', 'quality_review')",
          ),
      );
      db.exec(
        "INSERT INTO jobs_new SELECT * FROM jobs; DROP TABLE jobs; ALTER TABLE jobs_new RENAME TO jobs;",
      );
      for (const index of indexes) db.exec(index.sql);
      db.exec(`ALTER TABLE planning_requests ADD COLUMN lifecycle_version INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE pull_requests ADD COLUMN merge_sha TEXT;
        ALTER TABLE pull_requests ADD COLUMN reviewed_head TEXT;
        ALTER TABLE pull_requests ADD COLUMN target_branch TEXT;
        CREATE TABLE quality_cycles (
          id TEXT PRIMARY KEY, deployment_id INTEGER NOT NULL REFERENCES plan_deployments(id),
          input_key TEXT NOT NULL, job_id TEXT NOT NULL REFERENCES jobs(id),
          state TEXT NOT NULL, context TEXT NOT NULL, report TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE INDEX quality_cycles_deployment ON quality_cycles(deployment_id);
        CREATE TABLE child_approval_baselines (
          parent_key TEXT NOT NULL, plan_version TEXT NOT NULL, task_id TEXT NOT NULL,
          entry_id TEXT NOT NULL, PRIMARY KEY(parent_key,plan_version,task_id));
        CREATE TABLE quality_decisions (
          cycle_id TEXT NOT NULL REFERENCES quality_cycles(id), finding_id TEXT NOT NULL,
          action INTEGER NOT NULL CHECK(action BETWEEN 1 AND 4), reason TEXT NOT NULL,
          source_comment_id TEXT NOT NULL, batch_id TEXT, created_at TEXT NOT NULL, actor_id TEXT NOT NULL,
          source_cycle_id TEXT,
          PRIMARY KEY(cycle_id, finding_id, source_comment_id));
        CREATE TABLE plan_extensions (
          cycle_id TEXT NOT NULL REFERENCES quality_cycles(id), finding_id TEXT NOT NULL,
          parent_key TEXT NOT NULL, plan_version TEXT NOT NULL, task_id TEXT NOT NULL,
          task TEXT NOT NULL, source_comment_id TEXT NOT NULL,
          PRIMARY KEY(cycle_id, finding_id));`);
      if ((db.pragma("foreign_key_check") as unknown[]).length)
        throw new Error("quality migration foreign key check failed");
    },
  },
  {
    version: 18,
    description: "remove worker capability distinctions",
    up(db) {
      db.exec(
        "ALTER TABLE jobs DROP COLUMN required_capabilities; ALTER TABLE workers DROP COLUMN reported_capabilities;",
      );
    },
  },
  {
    version: 19,
    description: "board lifecycle: independent integration checks and advisory reviews",
    rebuildJobs: true,
    up(db) {
      const table = db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='jobs'")
        .get() as { sql: string };
      const indexes = db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='jobs' AND sql IS NOT NULL",
        )
        .all() as { sql: string }[];
      db.exec(
        table.sql
          .replace(/CREATE TABLE(?: IF NOT EXISTS)? ["`]?jobs["`]?/i, "CREATE TABLE jobs_new")
          .replace("'quality_review')", "'quality_review', 'integration_check')"),
      );
      db.exec(
        "INSERT INTO jobs_new SELECT * FROM jobs; DROP TABLE jobs; ALTER TABLE jobs_new RENAME TO jobs;",
      );
      for (const index of indexes) db.exec(index.sql);
      db.exec(`CREATE TABLE workflow_checks (
        job_id TEXT PRIMARY KEY REFERENCES jobs(id), issue_key TEXT NOT NULL,
        source_key TEXT NOT NULL, context TEXT NOT NULL, report TEXT, verified INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE parent_progress_entries (issue_key TEXT PRIMARY KEY, entry_id TEXT NOT NULL);
        CREATE TABLE job_inputs (job_id TEXT PRIMARY KEY REFERENCES jobs(id), snapshot TEXT NOT NULL);
        CREATE TABLE workflow_retry_comments (issue_key TEXT NOT NULL, comment_id TEXT NOT NULL, PRIMARY KEY(issue_key,comment_id));`);
      if ((db.pragma("foreign_key_check") as unknown[]).length)
        throw new Error("board workflow migration foreign key check failed");
    },
  },
  {
    version: 20,
    description: "Freeze role system prompts per execution attempt",
    up(db) {
      db.exec(`CREATE TABLE attempt_prompts (
        attempt_id TEXT PRIMARY KEY REFERENCES attempts(id), system_prompt TEXT NOT NULL
      )`);
    },
  },
  {
    version: 21,
    description: "Independent versioned FCI analysis, immutable snapshots and reporting outbox",
    up(db) {
      db.exec(`
        CREATE TABLE fci_series (id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, baseline_sha TEXT NOT NULL, profile_key TEXT NOT NULL, profile TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(repository_id,baseline_sha,profile_key));
        CREATE TABLE fci_tasks (id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, series_id TEXT NOT NULL REFERENCES fci_series(id), purpose TEXT NOT NULL, before_sha TEXT NOT NULL, after_sha TEXT NOT NULL, pr_repo TEXT, pr_number INTEGER, issue_key TEXT, job_id TEXT, source_attempt_id TEXT, merge_sha TEXT, pr_commits TEXT NOT NULL DEFAULT '[]', original_base_sha TEXT, revision INTEGER NOT NULL DEFAULT 0, supersedes TEXT, status TEXT NOT NULL DEFAULT 'queued', worker_id TEXT, session_id TEXT, attempt_id TEXT, lease_token TEXT, lease_expires_at TEXT, envelope TEXT, result_id TEXT UNIQUE, outcome TEXT, error TEXT, boundary TEXT, superseded INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE UNIQUE INDEX fci_worker_active ON fci_tasks(worker_id) WHERE status='running';
        CREATE TABLE fci_snapshots (series_id TEXT NOT NULL REFERENCES fci_series(id), sha TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL, raw_score REAL, PRIMARY KEY(series_id,sha,revision));
        CREATE TABLE fci_snapshot_claims (series_id TEXT NOT NULL, sha TEXT NOT NULL, revision INTEGER NOT NULL, task_id TEXT NOT NULL, token TEXT NOT NULL, expires_at TEXT NOT NULL, PRIMARY KEY(series_id,sha,revision));
        CREATE TABLE fci_reports (task_id TEXT PRIMARY KEY REFERENCES fci_tasks(id), status TEXT NOT NULL DEFAULT 'pending', error TEXT, updated_at TEXT NOT NULL);
        CREATE TABLE fci_sources (attempt_id TEXT PRIMARY KEY REFERENCES attempts(id), sha TEXT NOT NULL, observed_at TEXT NOT NULL);
        CREATE TABLE fci_attempts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES fci_tasks(id), worker_id TEXT NOT NULL, lease_token TEXT NOT NULL, envelope TEXT NOT NULL, result_id TEXT UNIQUE, outcome TEXT, created_at TEXT NOT NULL);
        CREATE TABLE fci_poll_errors (repo TEXT NOT NULL, number INTEGER NOT NULL, error TEXT NOT NULL, observed_at TEXT NOT NULL, PRIMARY KEY(repo,number));
        CREATE TABLE fci_pr_observations (repo TEXT NOT NULL, number INTEGER NOT NULL, head_sha TEXT, base_sha TEXT, base_branch TEXT, merge_sha TEXT, state TEXT NOT NULL, commits TEXT NOT NULL DEFAULT '[]', observed_at TEXT NOT NULL, PRIMARY KEY(repo,number));
      `);
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
    const foreignKeys = db.pragma("foreign_keys", { simple: true });
    if (migration.rebuildJobs) db.pragma("foreign_keys = OFF");
    try {
      apply();
    } finally {
      if (migration.rebuildJobs) db.pragma(`foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
    }
  }
}

export function currentSchemaVersion(db: Database.Database): number {
  const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as
    | { version: number | null }
    | undefined;
  return row?.version ?? 0;
}
