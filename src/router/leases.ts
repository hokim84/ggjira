import type Database from "better-sqlite3";
import { canTransitionJobState } from "../contracts/job-state.js";
import { listExpiredActiveAttempts, transitionAttemptState } from "./db/attempts.js";
import { getJob, transitionJobState } from "./db/jobs.js";

export interface LeaseExpiryReport {
  /** Attempts whose lease ran out before `start`: cancelled, and the job requeued. */
  requeued: Array<{ jobId: string; attemptId: string }>;
  /** Attempts whose lease ran out after `start`: parked for a confirmed stop. */
  recoveryRequired: Array<{ jobId: string; attemptId: string }>;
}

/**
 * The lease-expiry sweep (docs/router-service-implementation-plan.md §3 "임대와 작업 상태"):
 *
 * - `leased` past expiry → the worker never got a `start` grant, so nothing ran: the attempt is
 *   `cancelled` and the job goes back to `queued` for a fresh lease ("leased → queued (start 허가가
 *   전혀 없었던 경우만)").
 * - `running`/`cancel_requested` past expiry → something may still be running on that worker:
 *   attempt and job both go to `recovery_required` and are never re-assigned automatically
 *   (§3 "start 승인 이후의 만료·불명확한 연결 종료는 recovery_required로 둔다").
 *
 * Idempotent and purely DB-driven, so calling it at the top of every worker API call and on a
 * timer is safe; a Router restart changes nothing because leases live in SQLite
 * (§3 "Router 재시작은 임대를 지우거나 실행을 자동 재개하지 않는다").
 */
export function expireLeases(db: Database.Database, now: string): LeaseExpiryReport {
  const report: LeaseExpiryReport = { requeued: [], recoveryRequired: [] };

  for (const attempt of listExpiredActiveAttempts(db, now)) {
    const run = db.transaction(() => {
      const job = getJob(db, attempt.jobId);
      const isCurrent = job?.currentAttemptId === attempt.id;

      if (attempt.state === "leased") {
        transitionAttemptState(db, attempt.id, "cancelled", now);
        if (job && isCurrent && job.state === "leased") {
          transitionJobState(db, job.id, "queued", now);
        }
        report.requeued.push({ jobId: attempt.jobId, attemptId: attempt.id });
        return;
      }

      transitionAttemptState(db, attempt.id, "recovery_required", now);
      if (job && isCurrent && canTransitionJobState(job.state, "recovery_required")) {
        transitionJobState(db, job.id, "recovery_required", now);
      }
      report.recoveryRequired.push({ jobId: attempt.jobId, attemptId: attempt.id });
    });
    run();
  }

  return report;
}
