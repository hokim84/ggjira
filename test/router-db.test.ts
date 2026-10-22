import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvalidAttemptStateTransitionError } from "../src/contracts/attempt-state.js";
import { InvalidJobStateTransitionError } from "../src/contracts/job-state.js";
import {
  WorkerAlreadyLeasedError,
  getActiveAttemptForWorker,
  getAttempt,
  leaseAttempt,
  transitionAttemptState,
} from "../src/router/db/attempts.js";
import { openRouterDb } from "../src/router/db/connection.js";
import {
  DuplicateOpenJobError,
  createJob,
  getJob,
  getOpenJobForIssue,
  transitionJobState,
} from "../src/router/db/jobs.js";
import { currentSchemaVersion } from "../src/router/db/migrate.js";
import { createPairingCode } from "../src/router/db/pairing.js";

describe("Router SQLite store", () => {
  let dataDir: string;
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "ggjira-router-db-test-"));
    dbPath = path.join(dataDir, "router.sqlite3");
    db = openRouterDb(dbPath);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function removeQualityMigration() {
    db.exec(
      "DROP TABLE IF EXISTS fci_snapshot_claims; DROP TABLE IF EXISTS fci_reports; DROP TABLE IF EXISTS fci_snapshots; DROP TABLE IF EXISTS fci_attempts; DROP TABLE IF EXISTS fci_tasks; DROP TABLE IF EXISTS fci_series; DROP TABLE IF EXISTS fci_sources; DROP TABLE IF EXISTS fci_pr_observations; DROP TABLE IF EXISTS fci_poll_errors; DELETE FROM schema_migrations WHERE version=21; DROP TABLE IF EXISTS attempt_prompts; DELETE FROM schema_migrations WHERE version=20; DROP TABLE IF EXISTS workflow_checks; DROP TABLE IF EXISTS parent_progress_entries; DROP TABLE IF EXISTS workflow_retry_comments; DROP TABLE IF EXISTS job_inputs",
    );
    db.exec(
      "ALTER TABLE jobs ADD COLUMN required_capabilities TEXT NOT NULL DEFAULT '[]'; ALTER TABLE workers ADD COLUMN reported_capabilities TEXT NOT NULL DEFAULT '[]'; DELETE FROM schema_migrations WHERE version=18;",
    );
    db.exec(
      "DROP TABLE child_approval_baselines; DROP TABLE plan_extensions; DROP TABLE quality_decisions; DROP TABLE quality_cycles; ALTER TABLE pull_requests DROP COLUMN merge_sha; ALTER TABLE pull_requests DROP COLUMN reviewed_head; ALTER TABLE pull_requests DROP COLUMN target_branch;",
    );
  }
  describe("openRouterDb / migrations", () => {
    it("removes v17 capability columns while preserving jobs and approvals", () => {
      createJob(db, {
        id: "universal",
        issueKey: "KAN-18",
        workspaceId: "ws",
        repositoryId: "repo",
        kind: "implementation",
        approvalId: "human-entry",
        now: "2026-10-21",
      });
      db.exec(
        "ALTER TABLE jobs ADD COLUMN required_capabilities TEXT NOT NULL DEFAULT '[]'; ALTER TABLE workers ADD COLUMN reported_capabilities TEXT NOT NULL DEFAULT '[]'; DELETE FROM schema_migrations WHERE version=18; UPDATE jobs SET required_capabilities='[\"ui\"]';",
      );
      db.close();
      db = openRouterDb(dbPath);
      expect(getJob(db, "universal")).toMatchObject({ approvalId: "human-entry", state: "queued" });
      for (const [table, column] of [
        ["jobs", "required_capabilities"],
        ["workers", "reported_capabilities"],
      ])
        expect(
          (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((row) => row.name),
        ).not.toContain(column);
      expect(db.pragma("foreign_key_check")).toEqual([]);
    });
    it("upgrades a v16 active plan in place without revoking or adopting it into v2", () => {
      createJob(db, {
        id: "legacy-plan-job",
        issueKey: "KAN-16",
        workspaceId: "ws",
        repositoryId: "repo",
        kind: "planning",
        approvalId: "legacy-request",
        state: "succeeded",
        now: "2026-10-01T00:00:00Z",
      });
      db.exec(`INSERT INTO planning_requests (id,issue_key,entry_id,input_hash,created_at) VALUES ('legacy-request','KAN-16','entry','hash','2026-10-01');
        INSERT INTO plan_reviews (id,issue_key,workspace_id,job_id,attempt_id,request_approval_id,plan_version,outcome,task_ids,created_at) VALUES ('legacy-plan','KAN-16','ws','legacy-plan-job','attempt','legacy-request','legacy-v1','planned','[]','2026-10-01');
        INSERT INTO plan_deployments (issue_key,plan_review_id,plan_version,approval_id,task_ids,state,created_at,updated_at) VALUES ('KAN-16','legacy-plan','legacy-v1','approval','[]','active','2026-10-01','2026-10-01');`);
      removeQualityMigration();
      db.exec(
        "ALTER TABLE planning_requests DROP COLUMN lifecycle_version; DELETE FROM schema_migrations WHERE version=17;",
      );
      db.close();
      db = openRouterDb(dbPath);
      expect(db.prepare("SELECT lifecycle_version FROM planning_requests").get()).toEqual({
        lifecycle_version: 1,
      });
      expect(db.prepare("SELECT state FROM plan_deployments").get()).toEqual({ state: "active" });
      expect(db.prepare("SELECT closed_at FROM plan_reviews").get()).toEqual({ closed_at: null });
      expect(db.pragma("foreign_key_check")).toEqual([]);
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(
        createJob(db, {
          id: "new-quality",
          issueKey: "KAN-17",
          workspaceId: "ws",
          repositoryId: "repo",
          kind: "quality_review",
          approvalId: "quality:new",
          now: "2026-10-21",
        }).kind,
      ).toBe("quality_review");
    });
    it("creates the database file and enables WAL and foreign keys", () => {
      expect(existsSync(dbPath)).toBe(true);
      expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    });

    it("applies every migration and records it in schema_migrations", () => {
      expect(currentSchemaVersion(db)).toBe(21);
    });

    it("is idempotent: reopening an existing database does not re-run migrations", () => {
      db.close();
      const reopened = openRouterDb(dbPath);
      expect(currentSchemaVersion(reopened)).toBe(21);
      reopened.close();
      // Reopen once more so the outer afterEach's db.close() has a live handle.
      db = openRouterDb(dbPath);
    });

    it("upgrades a version-9 database to the current version and keeps its data", () => {
      createJob(db, {
        id: "job-v9",
        issueKey: "KAN-9",
        workspaceId: "ws-1",
        repositoryId: "repo-1",
        kind: "implementation",
        approvalId: "approval-9",
        inputHash: "legacy-hash",
        state: "queued",
        now: "2026-01-01T00:00:00.000Z",
      });
      // Roll the file back to what a v9 Router left behind.
      db.exec("DROP TABLE readiness_holds");
      db.prepare("DELETE FROM schema_migrations WHERE version = 10").run();
      db.close();

      db = openRouterDb(dbPath);
      expect(currentSchemaVersion(db)).toBe(21);
      expect(getJob(db, "job-v9")?.inputHash).toBe("legacy-hash");
      expect(db.prepare("SELECT COUNT(*) AS n FROM readiness_holds").get()).toEqual({ n: 0 });
    });
  });

  describe("M4 migrations (T14)", () => {
    const M4_TABLES = ["review_targets", "review_records", "attention_items", "execution_records"];
    // Dropped child first: plan_deployments references plan_reviews.
    const DELEGATION_TABLES = ["plan_deployments", "plan_reviews"];

    function tables(): string[] {
      return (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name);
    }

    it("upgrades a pre-M4 (version 10) database in place, keeping its jobs and results", () => {
      createJob(db, {
        id: "job-m3",
        issueKey: "KAN-3",
        workspaceId: "ws-1",
        repositoryId: "repo-1",
        kind: "implementation",
        approvalId: "approval-3",
        inputHash: "v2:abc",
        state: "succeeded",
        now: "2026-10-01T00:00:00.000Z",
      });
      db.prepare(
        "INSERT INTO results (id, job_id, attempt_id, payload, received_at, applied) VALUES (?, ?, ?, ?, ?, 1)",
      ).run("result-m3", "job-m3", "attempt-m3", '{"status":"succeeded"}', "2026-10-01T00:00:00Z");
      // Roll the file back to what the M3 Router left behind.
      for (const table of [
        "planning_requests",
        "planning_baselines",
        ...DELEGATION_TABLES,
        ...M4_TABLES,
      ])
        db.exec(`DROP TABLE ${table}`);
      removeQualityMigration();
      db.prepare("DELETE FROM schema_migrations WHERE version > 10").run();
      db.close();

      db = openRouterDb(dbPath);
      expect(currentSchemaVersion(db)).toBe(21);
      expect(tables()).toEqual(expect.arrayContaining(M4_TABLES));
      expect(getJob(db, "job-m3")).toMatchObject({ state: "succeeded", inputHash: "v2:abc" });
      expect(db.prepare("SELECT COUNT(*) AS n FROM results").get()).toEqual({ n: 1 });
      // Nothing is back-filled: M3 results have no review target, attention item or usage row.
      for (const table of M4_TABLES) {
        expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(), table).toEqual({ n: 0 });
      }

      // Re-running the migrations (another restart) changes nothing.
      db.close();
      db = openRouterDb(dbPath);
      expect(currentSchemaVersion(db)).toBe(21);
    });

    it("upgrades an M4 (version 13) database to the delegation tables without touching its rows", () => {
      createJob(db, {
        id: "job-m4",
        issueKey: "KAN-4",
        workspaceId: "ws-1",
        repositoryId: "repo-1",
        kind: "planning",
        approvalId: "approval-4",
        state: "succeeded",
        now: "2026-10-01T00:00:00.000Z",
      });
      for (const table of ["planning_requests", "planning_baselines", ...DELEGATION_TABLES])
        db.exec(`DROP TABLE ${table}`);
      removeQualityMigration();
      db.prepare("DELETE FROM schema_migrations WHERE version > 13").run();
      db.close();

      db = openRouterDb(dbPath);
      expect(currentSchemaVersion(db)).toBe(21);
      expect(tables()).toEqual(expect.arrayContaining([...M4_TABLES, ...DELEGATION_TABLES]));
      expect(getJob(db, "job-m4")).toMatchObject({ state: "succeeded", kind: "planning" });
      // No plan or approval is made up for work done before delegation existed.
      for (const table of DELEGATION_TABLES) {
        expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(), table).toEqual({ n: 0 });
      }
    });

    it("closes the readiness holds still open, and their attention items (ADR 0047)", () => {
      db.prepare(
        `INSERT INTO readiness_holds (id, issue_key, approval_id, input_hash, missing, first_seen_at,
           last_seen_at, notice_status) VALUES ('h1', 'KAN-35', 'a1', 'v2:x', '["acceptance"]',
           't', 't', 'posted')`,
      ).run();
      db.prepare(
        `INSERT INTO attention_items (id, incident_key, issue_key, kind, cause, severity, reason,
           first_seen_at, last_seen_at, status) VALUES ('i1', 'k1', 'KAN-35', 'readiness_hold',
           'acceptance', 'immediate', 'r', 't', 't', 'open'),
           ('i2', 'k2', 'KAN-36', 'failed', 'x', 'immediate', 'r', 't', 't', 'open')`,
      ).run();
      db.exec("DROP TABLE planning_requests; DROP TABLE planning_baselines");
      removeQualityMigration();
      db.prepare("DELETE FROM schema_migrations WHERE version > 14").run();
      db.close();

      db = openRouterDb(dbPath);
      expect(currentSchemaVersion(db)).toBe(21);
      expect(
        db.prepare("SELECT resolved_at IS NOT NULL AS closed FROM readiness_holds").get(),
      ).toEqual({ closed: 1 });
      expect(
        db.prepare("SELECT id, status, resolution FROM attention_items ORDER BY id").all(),
      ).toEqual([
        { id: "i1", status: "resolved", resolution: "readiness holds were removed (ADR 0047)" },
        { id: "i2", status: "open", resolution: null },
      ]);
    });
  });

  describe("jobs", () => {
    it("creates a job and reads it back", () => {
      const job = createJob(db, {
        id: "job-1",
        issueKey: "KAN-1",
        workspaceId: "ws-1",
        repositoryId: "repo-1",
        kind: "implementation",
        approvalId: "approval-1",
        now: "2026-01-01T00:00:00.000Z",
      });

      expect(job.state).toBe("queued");
      expect(getJob(db, "job-1")).toEqual(job);
    });

    it("rejects a second open job for the same issue (one-non-terminal-job-per-issue)", () => {
      createJob(db, {
        id: "job-1",
        issueKey: "KAN-1",
        workspaceId: "ws-1",
        repositoryId: "repo-1",
        kind: "implementation",
        approvalId: "approval-1",
        now: "2026-01-01T00:00:00.000Z",
      });

      expect(() =>
        createJob(db, {
          id: "job-2",
          issueKey: "KAN-1",
          workspaceId: "ws-1",
          repositoryId: "repo-1",
          kind: "implementation",
          approvalId: "approval-2",
          now: "2026-01-01T00:00:01.000Z",
        }),
      ).toThrow(DuplicateOpenJobError);
    });

    it("allows a new job for an issue once the prior job closed", () => {
      createJob(db, {
        id: "job-1",
        issueKey: "KAN-1",
        workspaceId: "ws-1",
        repositoryId: "repo-1",
        kind: "implementation",
        approvalId: "approval-1",
        state: "waiting",
        now: "2026-01-01T00:00:00.000Z",
      });
      transitionJobState(db, "job-1", "cancelled", "2026-01-01T00:00:01.000Z");

      const job2 = createJob(db, {
        id: "job-2",
        issueKey: "KAN-1",
        workspaceId: "ws-1",
        repositoryId: "repo-1",
        kind: "implementation",
        approvalId: "approval-2",
        now: "2026-01-01T00:00:02.000Z",
      });
      expect(job2.id).toBe("job-2");
      expect(getOpenJobForIssue(db, "KAN-1")?.id).toBe("job-2");
    });

    it("transitions state, stamping updated_at and (only on close) closed_at", () => {
      createJob(db, {
        id: "job-1",
        issueKey: "KAN-1",
        workspaceId: "ws-1",
        repositoryId: "repo-1",
        kind: "implementation",
        approvalId: "approval-1",
        state: "waiting",
        now: "2026-01-01T00:00:00.000Z",
      });

      const queued = transitionJobState(db, "job-1", "queued", "2026-01-01T00:01:00.000Z");
      expect(queued.state).toBe("queued");
      expect(queued.closedAt).toBeNull();

      transitionJobState(db, "job-1", "leased", "2026-01-01T00:02:00.000Z");
      transitionJobState(db, "job-1", "running", "2026-01-01T00:03:00.000Z");
      const succeeded = transitionJobState(db, "job-1", "succeeded", "2026-01-01T00:04:00.000Z");
      expect(succeeded.closedAt).toBe("2026-01-01T00:04:00.000Z");
    });

    it("rejects an invalid job state transition", () => {
      createJob(db, {
        id: "job-1",
        issueKey: "KAN-1",
        workspaceId: "ws-1",
        repositoryId: "repo-1",
        kind: "implementation",
        approvalId: "approval-1",
        state: "waiting",
        now: "2026-01-01T00:00:00.000Z",
      });

      expect(() => transitionJobState(db, "job-1", "running", "2026-01-01T00:01:00.000Z")).toThrow(
        InvalidJobStateTransitionError,
      );
      // The rejected transition must not have partially applied.
      expect(getJob(db, "job-1")?.state).toBe("waiting");
    });
  });

  describe("attempts", () => {
    function seedQueuedJob(id: string, issueKey: string) {
      return createJob(db, {
        id,
        issueKey,
        workspaceId: "ws-1",
        repositoryId: "repo-1",
        kind: "implementation",
        approvalId: `approval-${id}`,
        now: "2026-01-01T00:00:00.000Z",
      });
    }

    it("leases an attempt and stamps the job's current_attempt_id/attempt_count", () => {
      seedQueuedJob("job-1", "KAN-1");

      const attempt = leaseAttempt(db, {
        id: "attempt-1",
        jobId: "job-1",
        workerId: "worker-a",
        leaseToken: "lease-token-1",
        leaseExpiresAt: "2026-01-01T00:00:30.000Z",
        now: "2026-01-01T00:00:00.000Z",
      });

      expect(attempt.state).toBe("leased");
      const job = getJob(db, "job-1");
      expect(job?.currentAttemptId).toBe("attempt-1");
      expect(job?.attemptCount).toBe(1);
    });

    it("rejects a second active lease for the same worker (one-active-attempt-per-worker)", () => {
      seedQueuedJob("job-1", "KAN-1");
      seedQueuedJob("job-2", "KAN-2");
      leaseAttempt(db, {
        id: "attempt-1",
        jobId: "job-1",
        workerId: "worker-a",
        leaseToken: "lease-token-1",
        leaseExpiresAt: "2026-01-01T00:00:30.000Z",
        now: "2026-01-01T00:00:00.000Z",
      });

      expect(() =>
        leaseAttempt(db, {
          id: "attempt-2",
          jobId: "job-2",
          workerId: "worker-a",
          leaseToken: "lease-token-2",
          leaseExpiresAt: "2026-01-01T00:01:00.000Z",
          now: "2026-01-01T00:00:01.000Z",
        }),
      ).toThrow(WorkerAlreadyLeasedError);
      // The rejected lease must not have bumped the second job's bookkeeping.
      expect(getJob(db, "job-2")?.attemptCount).toBe(0);
    });

    it("allows a second lease for the same worker once the first attempt closed", () => {
      seedQueuedJob("job-1", "KAN-1");
      seedQueuedJob("job-2", "KAN-2");
      leaseAttempt(db, {
        id: "attempt-1",
        jobId: "job-1",
        workerId: "worker-a",
        leaseToken: "lease-token-1",
        leaseExpiresAt: "2026-01-01T00:00:30.000Z",
        now: "2026-01-01T00:00:00.000Z",
      });
      transitionAttemptState(db, "attempt-1", "running", "2026-01-01T00:00:05.000Z");
      transitionAttemptState(db, "attempt-1", "succeeded", "2026-01-01T00:00:10.000Z");

      const attempt2 = leaseAttempt(db, {
        id: "attempt-2",
        jobId: "job-2",
        workerId: "worker-a",
        leaseToken: "lease-token-2",
        leaseExpiresAt: "2026-01-01T00:01:00.000Z",
        now: "2026-01-01T00:00:11.000Z",
      });
      expect(attempt2.workerId).toBe("worker-a");
      expect(getActiveAttemptForWorker(db, "worker-a")?.id).toBe("attempt-2");
    });

    it("stamps started_at on first entry to running and ended_at on terminal states", () => {
      seedQueuedJob("job-1", "KAN-1");
      leaseAttempt(db, {
        id: "attempt-1",
        jobId: "job-1",
        workerId: "worker-a",
        leaseToken: "lease-token-1",
        leaseExpiresAt: "2026-01-01T00:00:30.000Z",
        now: "2026-01-01T00:00:00.000Z",
      });

      const running = transitionAttemptState(
        db,
        "attempt-1",
        "running",
        "2026-01-01T00:00:05.000Z",
      );
      expect(running.startedAt).toBe("2026-01-01T00:00:05.000Z");
      expect(running.endedAt).toBeNull();

      const failed = transitionAttemptState(db, "attempt-1", "failed", "2026-01-01T00:00:20.000Z");
      expect(failed.endedAt).toBe("2026-01-01T00:00:20.000Z");
    });

    it("rejects an invalid attempt state transition and leaves the row untouched", () => {
      seedQueuedJob("job-1", "KAN-1");
      leaseAttempt(db, {
        id: "attempt-1",
        jobId: "job-1",
        workerId: "worker-a",
        leaseToken: "lease-token-1",
        leaseExpiresAt: "2026-01-01T00:00:30.000Z",
        now: "2026-01-01T00:00:00.000Z",
      });
      transitionAttemptState(db, "attempt-1", "running", "2026-01-01T00:00:05.000Z");
      transitionAttemptState(db, "attempt-1", "succeeded", "2026-01-01T00:00:10.000Z");

      expect(() =>
        transitionAttemptState(db, "attempt-1", "running", "2026-01-01T00:00:11.000Z"),
      ).toThrow(InvalidAttemptStateTransitionError);
      expect(getAttempt(db, "attempt-1")?.state).toBe("succeeded");
    });
  });

  describe("pairing codes", () => {
    it("never start with a dash, which the CLI would read as an option", () => {
      // About 1 in 64 random base64url codes starts with "-"; 2000 codes all but surely include one.
      for (let i = 0; i < 2000; i++) {
        const { code } = createPairingCode(db, {
          workerId: `worker-${i}`,
          now: "2026-01-01T00:00:00.000Z",
        });
        expect(code.startsWith("-")).toBe(false);
      }
    });
  });
});
