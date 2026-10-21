import type Database from "better-sqlite3";

/** Existing workflow regression suites explicitly simulate requests created before v2. */
export function legacyLifecycle(db: Database.Database): void {
  db.exec(
    "UPDATE planning_requests SET lifecycle_version=1; UPDATE approvals SET input_snapshot=json_set(input_snapshot,'$.planning.lifecycleVersion',1) WHERE json_extract(input_snapshot,'$.planning') IS NOT NULL;",
  );
}
