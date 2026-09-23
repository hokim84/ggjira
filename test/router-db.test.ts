import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvalidAttemptStateTransitionError } from "../src/contracts/attempt-state.js";
import { InvalidJobStateTransitionError } from "../src/contracts/job-state.js";
import {
  getActiveAttemptForWorker,
  getAttempt,
  leaseAttempt,
  transitionAttemptState,
  WorkerAlreadyLeasedError,
} from "../src/router/db/attempts.js";
import { currentSchemaVersion } from "../src/router/db/migrate.js";
import { openRouterDb } from "../src/router/db/connection.js";
import {
  createJob,
  DuplicateOpenJobError,
  getJob,
  getOpenJobForIssue,
  transitionJobState,
} from "../src/router/db/jobs.js";

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

  describe("openRouterDb / migrations", () => {
    it("creates the database file and enables WAL and foreign keys", () => {
      expect(existsSync(dbPath)).toBe(true);
      expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    });

    it("applies every migration and records it in schema_migrations", () => {
      expect(currentSchemaVersion(db)).toBe(4);
    });

    it("is idempotent: reopening an existing database does not re-run migrations", () => {
      db.close();
      const reopened = openRouterDb(dbPath);
      expect(currentSchemaVersion(reopened)).toBe(4);
      reopened.close();
      // Reopen once more so the outer afterEach's db.close() has a live handle.
      db = openRouterDb(dbPath);
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
        requiredCapabilities: ["backend"],
        now: "2026-01-01T00:00:00.000Z",
      });

      expect(job.state).toBe("queued");
      expect(job.requiredCapabilities).toEqual(["backend"]);
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
});
