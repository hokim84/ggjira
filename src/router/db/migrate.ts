import type Database from "better-sqlite3";
import {
  ADMIN_OPERATIONS_STATEMENTS,
  REPORT_JOURNAL_STATEMENTS,
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
