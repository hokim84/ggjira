import { randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  AdminCreatePairingCodeResponse,
  JobAuthorizeRequest,
  JobAuthorizeResponse,
  JobHeartbeatRequest,
  JobHeartbeatResponse,
  JobResultRequest,
  JobResultResponse,
  JobStartRequest,
  JobStartResponse,
  JobsNextRequest,
  WorkerHeartbeatRequest,
  WorkerHeartbeatResponse,
  WorkerRegisterRequest,
  WorkerProfile,
  WorkerRegisterResponse,
  WorkerSessionRequest,
  WorkerSessionResponse,
  WorkerUsageReportRequest,
  WorkerUsageReportResponse,
} from "../contracts/api.js";
import type { AttemptState } from "../contracts/attempt-state.js";
import type { JobEnvelope, JobResult } from "../contracts/envelope.js";
import type { JobState } from "../contracts/job-state.js";
import { buildWorkerAvailability, isWorkerDispatchable } from "./availability.js";
import type { RouterConfig } from "./config.js";
import { getApproval } from "./db/approvals.js";
import {
  type AttemptRow,
  bindAttemptToRequest,
  getActiveAttemptForWorker,
  getAttempt,
  getAttemptByRequestId,
  renewAttemptLease,
  setAttemptResultId,
  transitionAttemptState,
} from "./db/attempts.js";
import { getJob, type JobRow, transitionJobState } from "./db/jobs.js";
import { consumePairingCode, createPairingCode, PairingCodeRejectedError } from "./db/pairing.js";
import { appendAudit } from "./db/audit.js";
import { saveProviderUsage } from "./db/provider-usage.js";
import { recordPullRequest } from "./db/pull-requests.js";
import { insertReportBatch } from "./db/report-steps.js";
import { recordResult, ResultConflictError } from "./db/results.js";
import {
  findWorkerByTokenHash,
  getWorker,
  hashWorkerToken,
  recordWorkerHeartbeat,
  registerWorker,
  startWorkerSession,
  touchWorkerHeartbeat,
  type WorkerRow,
} from "./db/workers.js";
import { buildJobEnvelope } from "./envelope.js";
import type { ApprovalSnapshot } from "./issue-check.js";
import { expireLeases } from "./leases.js";
import {
  buildRecoveredSteps,
  buildResultSteps,
  buildStartSteps,
  recoveredBatchId,
  startBatchId,
} from "./report-journal.js";
import { assignQueuedJobs, LEASE_DURATION_MS } from "./scheduler.js";

/** §3 "long polling: 25초". */
export const LONG_POLL_MS = 25_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

export type WorkerApiErrorStatus = 400 | 401 | 403 | 404 | 409 | 426;

/**
 * Every refusal the worker API makes, mapped 1:1 onto an HTTP status by `src/router/server.ts`
 * (§3: other worker's job → 403, stale/expired execution authority → 409, same resultId with
 * different content → 409, protocol mismatch → explicit compatibility error).
 */
export class WorkerApiError extends Error {
  constructor(
    readonly status: WorkerApiErrorStatus,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WorkerApiError";
  }
}

export interface WorkerServiceDeps {
  db: Database.Database;
  config: RouterConfig;
  now?: () => string;
  genId?: () => string;
  /** Worker token generator (32 random bytes by default). */
  genToken?: () => string;
  /** How long `jobs/next` holds the request open before answering 204. */
  longPollMs?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

type ClosedJobState = Extract<JobState, "succeeded" | "failed" | "timed_out" | "cancelled">;

const RUNNING_ATTEMPT_STATES: ReadonlySet<AttemptState> = new Set(["running", "cancel_requested"]);

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The SQLite-backed half of `/api/v1/*`. Each method validates identity → session → attempt →
 * lease inside a single synchronous DB transaction (better-sqlite3 is synchronous, so two
 * concurrent HTTP requests can never interleave inside one), and only `nextJob`'s long-poll
 * wait happens outside a transaction (§3 "네트워크 호출을 DB 트랜잭션 안에서 기다리지 않는다").
 */
export class WorkerService {
  private readonly db: Database.Database;
  private config: RouterConfig;
  private readonly now: () => string;
  private readonly genId: () => string;
  private readonly genToken: () => string;
  private readonly longPollMs: number;
  private readonly pollIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(deps: WorkerServiceDeps) {
    this.db = deps.db;
    this.config = deps.config;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.genId = deps.genId ?? randomUUID;
    this.genToken = deps.genToken ?? (() => randomBytes(32).toString("base64url"));
    this.longPollMs = deps.longPollMs ?? LONG_POLL_MS;
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.sleep = deps.sleep ?? defaultSleep;
  }

  /** Swaps in an applied config; calls already in flight finish on the one they read. */
  setConfig(config: RouterConfig): void {
    this.config = config;
  }

  // --- admin ---------------------------------------------------------------------------

  createPairingCode(workerId: string): AdminCreatePairingCodeResponse {
    if (!this.config.workers.some((policy) => policy.workerId === workerId)) {
      throw new WorkerApiError(
        404,
        "unknown_worker",
        `workerId "${workerId}" is not declared in Router config workers[]`,
      );
    }
    const row = createPairingCode(this.db, { workerId, now: this.now() });
    return { pairingCode: row.code, workerId, expiresAt: row.expiresAt };
  }

  // --- identity ------------------------------------------------------------------------

  /** Resolves the bearer token to a live (non-revoked) worker, or throws 401. */
  authenticate(token: string | undefined): WorkerRow {
    if (!token) throw new WorkerApiError(401, "unauthenticated", "missing worker token");
    const worker = findWorkerByTokenHash(this.db, hashWorkerToken(token));
    if (!worker || worker.revokedAt) {
      throw new WorkerApiError(401, "unauthenticated", "unknown or revoked worker token");
    }
    return worker;
  }

  register(request: WorkerRegisterRequest): WorkerRegisterResponse {
    const now = this.now();
    const token = this.genToken();
    const run = this.db.transaction((): string => {
      let workerId: string;
      try {
        workerId = consumePairingCode(this.db, request.pairingCode, now);
      } catch (error) {
        if (error instanceof PairingCodeRejectedError) {
          // One generic answer for unknown/expired/used codes.
          throw new WorkerApiError(401, "invalid_pairing_code", "pairing code rejected");
        }
        throw error;
      }
      if (!this.config.workers.some((policy) => policy.workerId === workerId)) {
        throw new WorkerApiError(
          403,
          "unknown_worker",
          `workerId "${workerId}" is no longer declared in Router config`,
        );
      }
      registerWorker(this.db, {
        workerId,
        name: request.workerName,
        tokenHash: hashWorkerToken(token),
        now,
      });
      return workerId;
    });
    const workerId = run();
    return { workerId, workerToken: token, profile: this.profileFor(workerId) };
  }

  /** The worker's policy as `worker start` needs it: allowed capabilities and repositories (with
   *  clone URLs) and the provider id Router will name in its envelopes (ADR 0025). */
  private profileFor(workerId: string): WorkerProfile {
    const policy = this.config.workers.find((entry) => entry.workerId === workerId);
    const repositories = new Map(this.config.repositories.map((repo) => [repo.id, repo]));
    return {
      capabilities: policy?.allowedCapabilities ?? [],
      providerId: policy?.providerId ?? "default",
      repositories: (policy?.allowedRepositoryIds ?? []).map((id) => {
        const repo = repositories.get(id);
        return {
          id,
          ...(repo?.cloneUrl ? { cloneUrl: repo.cloneUrl } : {}),
          ...(repo?.baseBranch ? { baseBranch: repo.baseBranch } : {}),
        };
      }),
    };
  }

  openSession(worker: WorkerRow, request: WorkerSessionRequest): WorkerSessionResponse {
    this.assertSameWorker(worker, request.workerId);
    const now = this.now();
    expireLeases(this.db, now);
    const sessionId = this.genId();
    startWorkerSession(this.db, { sessionId, workerId: worker.id, now });
    const active = getActiveAttemptForWorker(this.db, worker.id);
    return {
      sessionId,
      pendingAttempts: active
        ? [{ jobId: active.jobId, attemptId: active.id, state: active.state }]
        : [],
    };
  }

  heartbeat(worker: WorkerRow, request: WorkerHeartbeatRequest): WorkerHeartbeatResponse {
    this.assertSameWorker(worker, request.workerId);
    this.assertCurrentSession(worker.id, request.sessionId);
    const now = this.now();
    expireLeases(this.db, now);
    recordWorkerHeartbeat(this.db, {
      workerId: worker.id,
      capabilities: request.availability.capabilities,
      repositoryIds: request.availability.repositoryIds,
      now,
    });
    const active = getActiveAttemptForWorker(this.db, worker.id);
    return {
      cancelAttemptIds: active?.state === "cancel_requested" ? [active.id] : [],
    };
  }

  /** `workers/usage`: the plan usage a worker read on connect or after a job (ADR 0028). Stored
   *  for the admin workers view only; it does not affect routing. */
  reportUsage(worker: WorkerRow, request: WorkerUsageReportRequest): WorkerUsageReportResponse {
    this.assertSameWorker(worker, request.workerId);
    this.assertCurrentSession(worker.id, request.sessionId);
    saveProviderUsage(this.db, { workerId: worker.id, usage: request.usage, now: this.now() });
    return { accepted: true };
  }

  // --- jobs/next -----------------------------------------------------------------------

  /**
   * Returns this worker's reservation, or `null` (→ 204) once `longPollMs` passes with nothing
   * to hand out. Resending the same `requestId` returns the same reservation, so a lost response
   * never leases a second job (§3 "requestId를 필수로 받아...동일 예약을 반환한다").
   */
  async nextJob(worker: WorkerRow, request: JobsNextRequest): Promise<JobEnvelope | null> {
    this.assertSameWorker(worker, request.workerId);
    this.assertCurrentSession(worker.id, request.sessionId);
    const deadline = Date.parse(this.now()) + this.longPollMs;

    for (;;) {
      const envelope = this.tryReserve(worker.id, request.sessionId, request.requestId);
      if (envelope !== undefined) return envelope;
      // A newer session took over while we were waiting; this request is dead.
      if (getWorker(this.db, worker.id)?.currentSessionId !== request.sessionId) return null;
      if (Date.parse(this.now()) >= deadline) return null;
      await this.sleep(this.pollIntervalMs);
    }
  }

  /** One synchronous reservation attempt. `undefined` means "nothing yet, keep polling";
   *  `null` means "answer 204 now". */
  private tryReserve(
    workerId: string,
    sessionId: string,
    requestId: string,
  ): JobEnvelope | null | undefined {
    const run = this.db.transaction((): JobEnvelope | null | undefined => {
      const now = this.now();
      touchWorkerHeartbeat(this.db, workerId, now);

      const replay = getAttemptByRequestId(this.db, workerId, requestId);
      if (replay) {
        // Same request seen before. Hand back the same reservation while it is still live;
        // once it is gone (expired/cancelled) the worker must poll with a fresh requestId.
        if (replay.state === "leased" || RUNNING_ATTEMPT_STATES.has(replay.state)) {
          return this.envelopeFor(replay);
        }
        return null;
      }

      const active = getActiveAttemptForWorker(this.db, workerId);
      if (active) {
        if (active.state !== "leased") {
          throw new WorkerApiError(
            409,
            "worker_busy",
            `worker already runs attempt ${active.id}; finish or report it before polling`,
          );
        }
        // Leased by the background scheduler (or to an earlier session) but never started:
        // bind it to this session/request and hand it out.
        bindAttemptToRequest(this.db, active.id, sessionId, requestId);
        return this.envelopeFor({ ...active, sessionId, requestId });
      }

      const worker = getWorker(this.db, workerId);
      if (!worker || !isWorkerDispatchable(worker, this.config, now)) return undefined;
      // Every online worker is passed so this one can step aside for a worker with more LLM plan
      // headroom; only this one can be leased a job here (ADR 0029).
      const [assignment] = assignQueuedJobs(
        { db: this.db, config: this.config, now: () => now, genId: this.genId },
        buildWorkerAvailability(this.db, this.config, now),
        undefined,
        { requesterId: workerId },
      );
      if (!assignment) return undefined;
      bindAttemptToRequest(this.db, assignment.attemptId, sessionId, requestId);
      const attempt = getAttempt(this.db, assignment.attemptId);
      if (!attempt) throw new Error(`attempt ${assignment.attemptId} vanished after lease`);
      return this.envelopeFor(attempt);
    });
    // Outside the transaction: a refusal thrown below must not roll the expiry back.
    expireLeases(this.db, this.now());
    return run();
  }

  private envelopeFor(attempt: AttemptRow): JobEnvelope {
    const job = getJob(this.db, attempt.jobId);
    if (!job) throw new Error(`attempt ${attempt.id} references missing job ${attempt.jobId}`);
    return buildJobEnvelope(this.db, this.config, job, attempt);
  }

  // --- jobs/{id}/* ---------------------------------------------------------------------

  /**
   * Grants execution. Re-sending `start` for an attempt that is already `running` grants again
   * (lost-response replay) without creating anything new; every other attempt of the job has
   * already lost its lease, so at most one attempt per job can ever hold a grant.
   */
  start(worker: WorkerRow, jobId: string, request: JobStartRequest): JobStartResponse {
    const run = this.db.transaction((): JobStartResponse => {
      const now = this.now();
      const { attempt, job } = this.requireLiveAttempt(worker, jobId, request);

      if (RUNNING_ATTEMPT_STATES.has(attempt.state)) {
        return { granted: true, leaseExpiresAt: this.renew(attempt.id, now) };
      }
      if (attempt.state !== "leased") {
        throw new WorkerApiError(409, "not_startable", `attempt is ${attempt.state}`);
      }
      if (job.state !== "leased" || !this.approvalCurrent(job)) {
        // The job was cancelled or its approval moved on after the lease was handed out:
        // refuse and release the worker's slot. Nothing ran, so this is a plain cancel.
        transitionAttemptState(this.db, attempt.id, "cancelled", now);
        if (job.state === "leased") transitionJobState(this.db, job.id, "cancelled", now);
        return { granted: false, leaseExpiresAt: attempt.leaseExpiresAt };
      }

      transitionAttemptState(this.db, attempt.id, "running", now);
      transitionJobState(this.db, job.id, "running", now);
      this.journalStart(job, attempt, now);
      return { granted: true, leaseExpiresAt: this.renew(attempt.id, now) };
    });
    // Outside the transaction: a refusal thrown below must not roll the expiry back.
    expireLeases(this.db, this.now());
    return run();
  }

  jobHeartbeat(
    worker: WorkerRow,
    jobId: string,
    request: JobHeartbeatRequest,
  ): JobHeartbeatResponse {
    const run = this.db.transaction((): JobHeartbeatResponse => {
      const now = this.now();
      const { attempt, job } = this.requireLiveAttempt(worker, jobId, request);
      if (!RUNNING_ATTEMPT_STATES.has(attempt.state)) {
        throw new WorkerApiError(409, "not_running", `attempt is ${attempt.state}`);
      }
      const leaseExpiresAt = this.renew(attempt.id, now);
      if (attempt.state === "running" && !this.approvalCurrent(job)) {
        this.requestCancel(job, attempt, now);
        return { cancel: true, leaseExpiresAt };
      }
      return { cancel: attempt.state === "cancel_requested", leaseExpiresAt };
    });
    // Outside the transaction: a refusal thrown below must not roll the expiry back.
    expireLeases(this.db, this.now());
    return run();
  }

  /** Re-checks execution authority right before commit/validate (§3 "커밋·검증 직전 실행 권한
   *  재확인"). A lost approval also asks the worker to stop. */
  authorize(worker: WorkerRow, jobId: string, request: JobAuthorizeRequest): JobAuthorizeResponse {
    const run = this.db.transaction((): JobAuthorizeResponse => {
      const now = this.now();
      const { attempt, job } = this.requireLiveAttempt(worker, jobId, request);
      if (attempt.state === "cancel_requested") {
        return { authorized: false, reason: "cancel requested" };
      }
      if (attempt.state !== "running") {
        throw new WorkerApiError(409, "not_running", `attempt is ${attempt.state}`);
      }
      if (!this.approvalCurrent(job)) {
        this.requestCancel(job, attempt, now);
        return { authorized: false, reason: "approval changed" };
      }
      this.renew(attempt.id, now);
      return { authorized: true };
    });
    // Outside the transaction: a refusal thrown below must not roll the expiry back.
    expireLeases(this.db, this.now());
    return run();
  }

  /**
   * Stores the result, then applies it only if its attempt is still the job's current,
   * running attempt. Anything else — lease expired into `recovery_required`, a superseded
   * attempt, a job already closed — is kept as an audit record with `applied: false` and does
   * not move job state (§3 "늦게 도착한 결과는 감사 자료로 보존할 수 있지만 완료 처리... 에 적용하지
   * 않는다"). The result carries no session: a worker resending its spool after a restart has a new
   * one, and the token alone already proves ownership.
   */
  submitResult(worker: WorkerRow, jobId: string, result: JobResultRequest): JobResultResponse {
    if (result.jobId !== jobId) {
      throw new WorkerApiError(400, "job_mismatch", "result.jobId does not match the URL");
    }
    const run = this.db.transaction((): JobResultResponse => {
      const now = this.now();
      const attempt = getAttempt(this.db, result.attemptId);
      if (!attempt || attempt.jobId !== jobId) {
        throw new WorkerApiError(404, "unknown_attempt", "no such attempt for this job");
      }
      if (attempt.workerId !== worker.id) {
        throw new WorkerApiError(403, "forbidden", "attempt belongs to another worker");
      }
      const job = getJob(this.db, jobId);
      if (!job) throw new WorkerApiError(404, "unknown_job", "no such job");

      const current = job.currentAttemptId === attempt.id;
      const applicable = current && RUNNING_ATTEMPT_STATES.has(attempt.state);
      let recorded: ReturnType<typeof recordResult>;
      try {
        recorded = recordResult(this.db, {
          resultId: result.resultId,
          jobId,
          attemptId: attempt.id,
          payload: JSON.stringify(result),
          applied: applicable,
          now,
        });
      } catch (error) {
        if (error instanceof ResultConflictError) {
          throw new WorkerApiError(409, "result_conflict", error.message);
        }
        throw error;
      }
      if (recorded.outcome === "duplicate") {
        return { accepted: true, applied: recorded.row.applied };
      }
      if (current && attempt.state === "recovery_required" && job.state === "recovery_required") {
        this.confirmStopFromResult(worker, job, attempt, result, now);
        return { accepted: true, applied: false };
      }
      if (!applicable) return { accepted: true, applied: false };

      setAttemptResultId(this.db, attempt.id, result.resultId);
      const finalState = this.applyResult(job, attempt, result, now);
      this.journalResult(job, attempt, result, finalState, now);
      return { accepted: true, applied: true };
    });
    // Outside the transaction: a refusal thrown below must not roll the expiry back.
    expireLeases(this.db, this.now());
    return run();
  }

  // --- helpers -------------------------------------------------------------------------

  /** Closes the job per ADR 0020 §4 and returns the state it closed in. */
  private applyResult(
    job: JobRow,
    attempt: AttemptRow,
    result: JobResultRequest,
    now: string,
  ): ClosedJobState {
    // A cancel request wins: even a successful run is closed as cancelled, since approval was
    // withdrawn while it ran.
    if (attempt.state === "cancel_requested") {
      transitionAttemptState(this.db, attempt.id, "cancelled", now);
      transitionJobState(this.db, job.id, "cancelled", now);
      return "cancelled";
    }

    let target: ClosedJobState;
    switch (result.status) {
      case "succeeded":
      case "planned":
      case "needs_decision":
        // The execution itself finished; what Jira shows for "planned"/"needs_decision" is the
        // report journal's concern (src/router/report-journal.ts).
        target = "succeeded";
        break;
      case "failed":
        target = result.timedOut ? "timed_out" : "failed";
        break;
      case "cancelled":
        // The worker stopped on its own (e.g. lost contact with Router): route through
        // cancel_requested, the only path from running to cancelled.
        transitionAttemptState(this.db, attempt.id, "cancel_requested", now);
        transitionJobState(this.db, job.id, "cancel_requested", now);
        target = "cancelled";
        break;
    }
    transitionAttemptState(this.db, attempt.id, target, now);
    transitionJobState(this.db, job.id, target, now);
    return target;
  }

  private workspaceFor(job: JobRow): RouterConfig["workspaces"][number] | undefined {
    return this.config.workspaces.find((entry) => entry.id === job.workspaceId);
  }

  /** Journals the move to `inProgressStatus` in the transaction that grants execution. A
   *  replayed `start` hits the batch's uniqueness and journals nothing new. */
  private journalStart(job: JobRow, attempt: AttemptRow, now: string): void {
    const workspace = this.workspaceFor(job);
    if (!workspace) return;
    insertReportBatch(this.db, {
      batchId: startBatchId(attempt.id),
      jobId: job.id,
      attemptId: attempt.id,
      issueKey: job.issueKey,
      steps: buildStartSteps(job, workspace),
      now,
    });
  }

  /** Journals the result's Jira side effects in the transaction that stores it (§3 "Router는 결과
   *  저장과 Jira 반영 작업 생성을 한 트랜잭션으로 처리한다"). */
  private journalResult(
    job: JobRow,
    attempt: AttemptRow,
    result: JobResult,
    finalState: ClosedJobState,
    now: string,
  ): void {
    const workspace = this.workspaceFor(job);
    if (!workspace) return;
    const snapshot = getApproval(this.db, job.issueKey)?.inputSnapshot as
      | ApprovalSnapshot
      | undefined;
    if (result.pullRequest && finalState === "succeeded") {
      recordPullRequest(this.db, {
        ...result.pullRequest,
        issueKey: job.issueKey,
        jobId: job.id,
        attemptId: attempt.id,
        now,
      });
    }
    insertReportBatch(this.db, {
      batchId: result.resultId,
      resultId: result.resultId,
      jobId: job.id,
      attemptId: attempt.id,
      issueKey: job.issueKey,
      steps: buildResultSteps({
        job,
        attemptId: attempt.id,
        finalState,
        result,
        workspace,
        config: this.config,
        snapshot,
      }),
      now,
    });
  }

  /**
   * A result for the current attempt of a `recovery_required` job is the worker's confirmation
   * that the process is gone (§3 "recovery_required는 워커의 중단 확인... 이 있어야 해제한다"). The
   * result itself arrived after the lease expired, so it is not applied (§3 "늦게 도착한 결과는...
   * 적용하지 않는다"); the job closes as cancelled and Jira is told the run needs a new request.
   */
  private confirmStopFromResult(
    worker: WorkerRow,
    job: JobRow,
    attempt: AttemptRow,
    result: JobResult,
    now: string,
  ): void {
    transitionAttemptState(this.db, attempt.id, "cancelled", now);
    transitionJobState(this.db, job.id, "cancelled", now);
    appendAudit(this.db, {
      at: now,
      actor: `worker:${worker.id}`,
      action: "recovery.stop_confirmed",
      subject: job.id,
      detail: { attemptId: attempt.id, resultId: result.resultId, status: result.status },
    });
    const workspace = this.workspaceFor(job);
    if (!workspace) return;
    insertReportBatch(this.db, {
      batchId: recoveredBatchId(attempt.id),
      jobId: job.id,
      attemptId: attempt.id,
      issueKey: job.issueKey,
      steps: buildRecoveredSteps(job, attempt.id, result),
      now,
    });
  }

  private requestCancel(job: JobRow, attempt: AttemptRow, now: string): void {
    transitionAttemptState(this.db, attempt.id, "cancel_requested", now);
    if (job.state === "running") transitionJobState(this.db, job.id, "cancel_requested", now);
  }

  /** The job's approval id and input hash still match what the last reconcile saw in Jira. */
  private approvalCurrent(job: JobRow): boolean {
    const approval = getApproval(this.db, job.issueKey);
    if (!approval || approval.approvalId !== job.approvalId) return false;
    return job.inputHash === null || approval.inputHash === job.inputHash;
  }

  private renew(attemptId: string, now: string): string {
    const leaseExpiresAt = new Date(Date.parse(now) + LEASE_DURATION_MS).toISOString();
    renewAttemptLease(this.db, attemptId, leaseExpiresAt);
    return leaseExpiresAt;
  }

  private assertSameWorker(worker: WorkerRow, claimedWorkerId: string): void {
    if (worker.id !== claimedWorkerId) {
      throw new WorkerApiError(403, "forbidden", "workerId does not match the presented token");
    }
  }

  private assertCurrentSession(workerId: string, sessionId: string): void {
    if (getWorker(this.db, workerId)?.currentSessionId !== sessionId) {
      throw new WorkerApiError(409, "stale_session", "session is not the worker's current session");
    }
  }

  /** identity → session → attempt ownership → lease token → lease freshness. */
  private requireLiveAttempt(
    worker: WorkerRow,
    jobId: string,
    request: { sessionId: string; attemptId: string; leaseToken: string },
  ): { attempt: AttemptRow; job: JobRow } {
    this.assertCurrentSession(worker.id, request.sessionId);
    const attempt = getAttempt(this.db, request.attemptId);
    if (!attempt || attempt.jobId !== jobId) {
      throw new WorkerApiError(404, "unknown_attempt", "no such attempt for this job");
    }
    if (attempt.workerId !== worker.id) {
      throw new WorkerApiError(403, "forbidden", "attempt belongs to another worker");
    }
    if (attempt.leaseToken !== request.leaseToken) {
      throw new WorkerApiError(409, "stale_lease", "lease token does not match");
    }
    if (attempt.sessionId !== request.sessionId) {
      throw new WorkerApiError(409, "stale_session", "attempt was handed to a different session");
    }
    if (attempt.state === "recovery_required") {
      throw new WorkerApiError(409, "lease_expired", "attempt lease expired; awaiting recovery");
    }
    if (attempt.state === "cancelled" || attempt.state === "superseded") {
      throw new WorkerApiError(409, "attempt_closed", `attempt is ${attempt.state}`);
    }
    const job = getJob(this.db, jobId);
    if (!job) throw new WorkerApiError(404, "unknown_job", "no such job");
    return { attempt, job };
  }
}
