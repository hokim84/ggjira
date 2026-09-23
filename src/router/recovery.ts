import type Database from "better-sqlite3";
import type { JiraGateway } from "../jira/gateway.js";
import type { RouterConfig } from "./config.js";
import { getAttempt, transitionAttemptState } from "./db/attempts.js";
import { appendAudit } from "./db/audit.js";
import { getJob, type JobRow, restampJobApproval, transitionJobState } from "./db/jobs.js";
import {
  insertReportBatch,
  listBatchReportSteps,
  requeueBlockedReportSteps,
} from "./db/report-steps.js";
import { checkJobAgainstJira, storeApproval } from "./issue-check.js";
import { buildRecoveredSteps, recoveredBatchId } from "./report-journal.js";

/**
 * The admin side of recovery (docs/router-service-implementation-plan.md §3 "임대와 작업 상태",
 * "실행 결과와 Jira 반영 분리"): releasing a `recovery_required` job, retrying a failed job with a
 * new attempt, and retrying a blocked report batch. Every action is recorded in `audit_log`.
 * Stage 5's admin API / `ggjira router jobs resolve|retry` and `reports retry` call these.
 */

export class RecoveryError extends Error {
  constructor(
    readonly code: "unknown_job" | "not_recoverable" | "approval_revoked" | "unknown_batch",
    message: string,
  ) {
    super(message);
    this.name = "RecoveryError";
  }
}

const RETRYABLE_STATES = new Set(["failed", "timed_out", "recovery_required"]);

function requireJob(db: Database.Database, jobId: string): JobRow {
  const job = getJob(db, jobId);
  if (!job) throw new RecoveryError("unknown_job", `no job ${jobId}`);
  return job;
}

/** Closes the current `recovery_required` attempt on an admin's word that its process is gone. */
function confirmStop(
  db: Database.Database,
  job: JobRow,
  actor: string,
  now: string,
  attemptTo: "cancelled" | "superseded",
): void {
  if (!job.currentAttemptId) return;
  const attempt = getAttempt(db, job.currentAttemptId);
  if (attempt?.state !== "recovery_required") return;
  transitionAttemptState(db, attempt.id, attemptTo, now);
  appendAudit(db, {
    at: now,
    actor,
    action: "recovery.stop_confirmed",
    subject: job.id,
    detail: { attemptId: attempt.id },
  });
}

/**
 * `ggjira router jobs resolve`: an admin confirms a `recovery_required` job's process is stopped
 * (§3 "recovery_required는 ... 관리자의 중단 확인 기록이 있어야 해제한다") and closes the job.
 * The issue stays where it is; a human re-requests it in Jira to run it again.
 */
export function resolveRecoveryJob(
  db: Database.Database,
  config: RouterConfig,
  input: { jobId: string; actor: string; now: string },
): JobRow {
  const run = db.transaction((): JobRow => {
    const job = requireJob(db, input.jobId);
    if (job.state !== "recovery_required") {
      throw new RecoveryError(
        "not_recoverable",
        `job ${job.id} is ${job.state}, not recovery_required`,
      );
    }
    confirmStop(db, job, input.actor, input.now, "cancelled");
    const closed = transitionJobState(db, job.id, "cancelled", input.now);
    appendAudit(db, { at: input.now, actor: input.actor, action: "job.resolved", subject: job.id });
    if (job.currentAttemptId && config.workspaces.some((w) => w.id === job.workspaceId)) {
      insertReportBatch(db, {
        batchId: recoveredBatchId(job.currentAttemptId),
        jobId: job.id,
        attemptId: job.currentAttemptId,
        issueKey: job.issueKey,
        steps: buildRecoveredSteps(job, job.currentAttemptId, { admin: input.actor }),
        now: input.now,
      });
    }
    return closed;
  });
  return run();
}

/**
 * `ggjira router jobs retry`: runs a failed / timed-out / recovery-required job again as a new
 * attempt (§3 "수동 재시도는 새로운 attempt를 만든다"). The issue's approval is re-checked in Jira
 * first (§3 "새 실행 전 Jira 요청 상태의 승인을 다시 확인한다"): a job whose issue a human moved
 * away, re-approved, or edited is refused — that change is itself a new request, handled by
 * reconcile. For a `recovery_required` job the retry is also the admin's stop confirmation.
 */
export async function retryJob(
  deps: { db: Database.Database; jira: JiraGateway; config: RouterConfig; now: () => string },
  input: { jobId: string; actor: string },
): Promise<JobRow> {
  const before = requireJob(deps.db, input.jobId);
  if (!RETRYABLE_STATES.has(before.state)) {
    throw new RecoveryError(
      "not_recoverable",
      `job ${before.id} is ${before.state}; nothing to retry`,
    );
  }
  // Outside any transaction: never hold the DB while waiting on Jira.
  const check = await checkJobAgainstJira(deps.jira, deps.config, before);
  if (check.verdict === "revoked") {
    throw new RecoveryError("approval_revoked", `cannot retry ${before.id}: ${check.reason}`);
  }

  const run = deps.db.transaction((): JobRow => {
    const now = deps.now();
    const job = requireJob(deps.db, input.jobId);
    if (job.state !== before.state || job.currentAttemptId !== before.currentAttemptId) {
      throw new RecoveryError("not_recoverable", `job ${job.id} changed while retrying; try again`);
    }
    if (job.state === "recovery_required")
      confirmStop(deps.db, job, input.actor, now, "superseded");
    storeApproval(deps.db, check.approval, now);
    restampJobApproval(deps.db, job.id, {
      approvalId: check.approval.approvalId,
      inputHash: check.approval.inputHash,
      kind: job.kind,
      requiredCapabilities: check.approval.requirements.requiredCapabilities,
      now,
    });
    const queued = transitionJobState(deps.db, job.id, "queued", now);
    appendAudit(deps.db, {
      at: now,
      actor: input.actor,
      action: "job.retried",
      subject: job.id,
      detail: { from: job.state, previousAttemptId: job.currentAttemptId },
    });
    return queued;
  });
  return run();
}

/**
 * `ggjira router reports retry`: puts a batch's `failed`/`recovery_required` steps back to
 * `pending`. Re-runs only the Jira side effects — never the worker (§3 "Jira 보고 재시도는 AI 워커를
 * 다시 실행하지 않는다"). For an unconfirmed subtask creation this is the admin's go-ahead after
 * checking Jira: the step still looks for its marker before creating.
 */
export function retryReportBatch(
  db: Database.Database,
  input: { batchId: string; actor: string; now: string },
): number {
  const run = db.transaction((): number => {
    const steps = listBatchReportSteps(db, input.batchId);
    if (steps.length === 0)
      throw new RecoveryError("unknown_batch", `no report batch ${input.batchId}`);
    const requeued = requeueBlockedReportSteps(db, input.batchId, input.now);
    appendAudit(db, {
      at: input.now,
      actor: input.actor,
      action: "report.retried",
      subject: input.batchId,
      detail: { requeued },
    });
    return requeued;
  });
  return run();
}
