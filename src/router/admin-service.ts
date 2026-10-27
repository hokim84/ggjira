import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import type { RouterDatabase } from "./db/connection.js";
import type { z } from "zod";
import type { AdminAddWorkerRequest, ProviderUsage } from "../contracts/api.js";
import type { FciConfigSchema } from "../contracts/fci.js";
import type { JobState } from "../contracts/job-state.js";
import type { AiRole } from "../contracts/prompts.js";
import type { JiraGateway } from "../jira/gateway.js";
import { isWorkerDispatchable } from "./availability.js";
import { type CheckItem, githubRepositoriesToCheck, runRouterCheck } from "./check.js";
import {
  type ConfigIssue,
  canonicalJson,
  readRawRouterConfig,
  restartOnlyChanges,
  setSecretsFileValue,
  validateRouterConfig,
  writeRouterConfig,
} from "./config-store.js";
import type { RouterConfig, RouterConfigError, WorkspaceConfig } from "./config.js";
import {
  type AttemptRow,
  getActiveAttemptForWorker,
  listAttemptsForJob,
  transitionAttemptState,
} from "./db/attempts.js";
import {
  type AttentionItemRow,
  type AttentionKind,
  countOpenAttention,
  listAttentionItems,
} from "./db/attention.js";
import { type AuditEntry, appendAudit, listAudit } from "./db/audit.js";
import { oldestUnprocessedEventAt } from "./db/events.js";
import {
  type ExecutionRecordRow,
  type ExecutionTotals,
  listExecutionRecords,
  totalExecutions,
} from "./db/execution-records.js";
import { recordAdminHold } from "./db/holds.js";
import {
  type JobPage,
  type JobRow,
  countJobsByState,
  getJob,
  getOpenJobs,
  listJobs,
  oldestQueuedJobSince,
  transitionJobState,
} from "./db/jobs.js";
import { createPairingCode } from "./db/pairing.js";
import { listProviderUsage } from "./db/provider-usage.js";
import {
  type PullRequestRow,
  listPullRequestRepos,
  listRecentPullRequests,
} from "./db/pull-requests.js";
import {
  type ReportStepRow,
  listBlockedReportSteps,
  listJobReportSteps,
} from "./db/report-steps.js";
import {
  REVIEW_QUEUE_STATES,
  type ReviewQueueItem,
  type ReviewQueueState,
  type ReviewRecordRow,
  type ReviewTargetRow,
  countWaitingReviews,
  listReviewQueue,
  listReviewRecords,
  listReviewTargets,
} from "./db/review-targets.js";
import { getWorker, listWorkers, revokeWorker, setWorkerEnabled } from "./db/workers.js";
import { FciService } from "./fci-service.js";
import type { PullRequestPollReport } from "./github.js";
import {
  type IssueView,
  IssueViewError,
  type IssueViewErrorCode,
  readIssueView,
} from "./issue-view.js";
import { getPromptCatalog } from "./prompt-catalog.js";
import { resolveRecoveryJob, retryJob, retryReportBatch } from "./recovery.js";
import { JudgmentError, judgeReviewTarget } from "./review-judgment.js";
import { type SchedulerReport, cancelStaleJob } from "./scheduler.js";
import { SecretValueSchema } from "./secrets.js";
import { type UsagePressure, usagePressure } from "./usage-routing.js";
import {
  type ProjectWorkflowInfo,
  type WorkflowHopResult,
  checkWorkflowHops,
  inspectProjectWorkflow,
} from "./workflow-check.js";

/**
 * The operations behind `/api/v1/admin/*` (docs/router-service-implementation-plan.md §4 "관리
 * CLI"). The CLI only ever reaches these through the Router's HTTP API — it never opens the live
 * database itself (§4 "실행 중인 DB를 CLI가 직접 수정하지 않는다"). Every state change is written to
 * `audit_log` with the acting admin's name.
 */

export class AdminError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 502,
    readonly code: string,
    message: string,
    readonly issues?: ConfigIssue[],
    /** A stale review target's replacement (F01), so the caller can show the current one. */
    readonly currentTargetId?: string,
  ) {
    super(message);
    this.name = "AdminError";
  }
}

export interface AdminWorkerView {
  workerId: string;
  name: string | null;
  /** Declared in Router config `workers[]`. A paired worker missing from config gets no work. */
  declared: boolean;
  policyEnabled: boolean;
  /** The admin `workers disable/enable` switch (the `workers.enabled` column). */
  enabled: boolean;
  paired: boolean;
  revokedAt: string | null;
  lastHeartbeatAt: string | null;
  /** Could be handed a job right now (session, fresh heartbeat, enabled, not revoked). */
  online: boolean;
  reportedRepositoryIds: string[];
  /** repositoryId → local path on the worker machine (display only). */
  repositoryPaths: Record<string, string>;
  activeAttempt: { attemptId: string; jobId: string; state: string } | null;
  /** The worker's latest reported plan usage per provider (ADR 0028). */
  providerUsage: ProviderUsage[];
  /** How that usage affects assignment for the provider Router names in its jobs (ADR 0029). */
  usagePressure: UsagePressure;
}

export interface AdminJobDetail {
  fci: ReturnType<FciService["forJob"]>;
  job: JobRow;
  attempts: AttemptRow[];
  reportSteps: ReportStepRow[];
  audit: AuditEntry[];
}

export interface AdminBlockedBatch {
  batchId: string;
  jobId: string;
  issueKey: string;
  steps: Array<Pick<ReportStepRow, "id" | "seq" | "kind" | "status" | "tries" | "lastError">>;
}

export interface RouterStatus {
  jobs: Partial<Record<JobState, number>>;
  queue: { oldestQueuedSince: string | null; waitMs: number | null };
  workers: { declared: number; paired: number; online: number };
  recoveryRequired: number;
  webhooks: { oldestUnprocessedAt: string | null; delayMs: number | null };
  reports: { blocked: number };
  /** Open attention items: what a human must look at now (M4-09). */
  attention: { open: number };
  /** Current review targets still waiting on a human judgment (F01). */
  reviews: { waiting: number };
}

export interface AdminConfigView {
  path: string;
  /** The file's JSON as written; null when it no longer parses. */
  file: unknown;
  /** The file changes a connection setting (`restartFields`) that applies only on restart. */
  restartRequired: boolean;
  restartFields: string[];
  /** The file differs from the config the Router is running (e.g. edited by hand, not applied). */
  pendingApply: boolean;
  /** Set when the file on disk is unreadable or invalid. */
  problem: string | null;
  /** GitHub integration state (ADR 0027, 0032); secret values are never returned. */
  github: AdminGithubView;
  /** Whether the Router has a Jev API key and where it comes from (ADR 0031); never the value. */
  jev: SecretInfo;
}

export interface AdminGithubView {
  webhook: boolean;
  token: SecretInfo;
  /** Open PRs first, then recently closed, with each one's last poll result. */
  pullRequests: PullRequestRow[];
}

/** A secret the web UI can set without seeing it (ADR 0031). */
export interface SecretInfo {
  set: boolean;
  /** `environment` wins over the secrets file, so the web UI cannot change it. */
  source: "environment" | "file" | null;
  editable: boolean;
}

export type SecretSlotId = "jev" | "githubToken";

export interface SecretSlot {
  /** The `router.env` / environment variable name. */
  envKey: string;
  fromEnvironment: boolean;
  isSet: () => boolean;
  /** Hands the new value to the running Router. */
  apply: (value: string | undefined) => void;
}

const SECRET_AUDIT_NAMES: Record<SecretSlotId, string> = {
  jev: "jev",
  githubToken: "github-token",
};

export interface BackupResult {
  path: string;
  bytes: number;
}

export interface AdminServiceDeps {
  db: RouterDatabase;
  jira: JiraGateway;
  config: RouterConfig;
  now?: () => string;
  /** Runs one reconcile pass on demand (`ggjira router reconcile`). Supplied by the daemon so an
   *  admin-triggered pass is serialized with the timer-driven ones. */
  reconcileNow?: () => Promise<SchedulerReport>;
  /** Where `backup` writes; defaults to `<db dir>/backups`. */
  backupDir?: string;
  /** The config file this Router was started from. Enables the web UI's config and check calls. */
  configPath?: string;
  /** Applies a validated config to the running Router (daemon: serialized with sync/verify, all
   *  services swapped). Without it only this service's own view changes. */
  applyConfig?: (config: RouterConfig) => Promise<void>;
  /** Whether the GitHub webhook secret is set (it only changes on restart). */
  github?: { webhook: boolean; token?: () => string | undefined };
  /** Secrets the web UI can replace, written to `secretsPath` (ADR 0031, 0032). A slot left out
   *  shows as unset and not editable. */
  secrets?: { secretsPath?: string; slots: Partial<Record<SecretSlotId, SecretSlot>> };
  /** Runs one GitHub pull-request poll now ("지금 확인"). */
  pollGithub?: () => Promise<PullRequestPollReport>;
}

export interface AdminAddWorkerResult {
  worker: AdminWorkerView;
  pairingCode: string;
  expiresAt: string;
}

export interface ConfigApplyResult extends AdminConfigView {
  /** Connection settings saved but still waiting for a restart. */
  appliedWithout: string[];
}

const MAX_PAGE_SIZE = 200;

/** The workflow fields that decide which issues are approved work (see
 *  `assertApprovalRulesUnchangedUnderLiveJobs`). */
function approvalRules(workspace: WorkspaceConfig) {
  return workspace.workflow;
}

function elapsedMs(since: string | null, now: string): number | null {
  return since ? Math.max(0, Date.parse(now) - Date.parse(since)) : null;
}

const ISSUE_VIEW_ERROR_STATUS: Record<IssueViewErrorCode, AdminError["status"]> = {
  invalid_issue_key: 400,
  unknown_project: 404,
  unknown_issue: 404,
  jira_forbidden: 502,
  jira_rate_limited: 502,
  jira_error: 502,
};

function toAdminError(error: unknown): AdminError {
  if (error instanceof AdminError) return error;
  if (error instanceof JudgmentError) {
    const status =
      error.code === "unknown_review_target" ? 404 : error.code === "invalid_judgment" ? 400 : 409;
    return new AdminError(status, error.code, error.message, undefined, error.currentTargetId);
  }
  if (error instanceof IssueViewError) {
    return new AdminError(ISSUE_VIEW_ERROR_STATUS[error.code], error.code, error.message);
  }
  return new AdminError(502, "jira_error", error instanceof Error ? error.message : String(error));
}

function backupFileName(now: string): string {
  return `router-${now.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}.sqlite3`;
}

export class AdminService {
  private readonly db: RouterDatabase;
  private readonly now: () => string;
  /** The config currently applied (changes on every apply). */
  private config: RouterConfig;
  /** The config the process started with: its connection settings are the ones in effect. */
  private readonly startedWith: RouterConfig;

  constructor(private readonly deps: AdminServiceDeps) {
    this.db = deps.db;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.config = deps.config;
    this.startedWith = deps.config;
  }

  setConfig(config: RouterConfig): void {
    this.config = config;
  }

  // --- workers -------------------------------------------------------------------------

  listWorkers(): AdminWorkerView[] {
    const now = this.now();
    const rows = new Map(listWorkers(this.db).map((worker) => [worker.id, worker]));
    const usage = listProviderUsage(this.db);
    const ids = new Set([...this.config.workers.map((w) => w.workerId), ...rows.keys()]);
    return [...ids].sort().map((workerId): AdminWorkerView => {
      const row = rows.get(workerId);
      const policy = this.config.workers.find((w) => w.workerId === workerId);
      const active = row ? getActiveAttemptForWorker(this.db, workerId) : undefined;
      return {
        workerId,
        name: row?.name ?? null,
        declared: Boolean(policy),
        policyEnabled: policy?.enabled ?? false,
        enabled: row?.enabled ?? true,
        paired: Boolean(row),
        revokedAt: row?.revokedAt ?? null,
        lastHeartbeatAt: row?.lastHeartbeatAt ?? null,
        online: row ? isWorkerDispatchable(row, this.config, now) : false,
        reportedRepositoryIds: row?.reportedRepositoryIds ?? [],
        repositoryPaths: row?.reportedRepositoryPaths ?? {},
        activeAttempt: active
          ? { attemptId: active.id, jobId: active.jobId, state: active.state }
          : null,
        providerUsage: usage.get(workerId) ?? [],
        usagePressure: usagePressure(
          usage.get(workerId)?.find((entry) => entry.providerId === (policy?.providerId ?? "")),
          now,
          this.config.scheduling.usage.deprioritizeAtPercent,
        ),
      };
    });
  }

  /** `workers disable|enable`: blocks (or re-allows) new assignments only. Work already leased
   *  or running on the worker carries on (§4 "워커 비활성화는 신규 배정을 차단하고"). */
  setWorkerEnabled(workerId: string, enabled: boolean, actor: string): AdminWorkerView {
    const run = this.db.transaction(() => {
      this.requirePairedWorker(workerId);
      setWorkerEnabled(this.db, workerId, enabled);
      appendAudit(this.db, {
        at: this.now(),
        actor,
        action: enabled ? "worker.enabled" : "worker.disabled",
        subject: workerId,
      });
    });
    run();
    return this.workerView(workerId);
  }

  /**
   * `workers revoke`: the token stops authenticating at once and the worker's active attempt is
   * cancelled too (§4 "credential 폐기는 활성 실행에도 취소를 요청한다"). A lease that never started
   * goes back to the queue; a running one is asked to stop. The revoked worker cannot heartbeat to
   * hear that, so its lease runs out and the job lands in `recovery_required` — an admin resolves
   * it once the machine is confirmed stopped.
   */
  revokeWorker(workerId: string, actor: string): AdminWorkerView {
    const run = this.db.transaction(() => {
      this.requirePairedWorker(workerId);
      const now = this.now();
      revokeWorker(this.db, workerId, now);
      const attempt = getActiveAttemptForWorker(this.db, workerId);
      const job = attempt ? getJob(this.db, attempt.jobId) : undefined;
      if (attempt && job?.currentAttemptId === attempt.id) {
        if (attempt.state === "leased") {
          transitionAttemptState(this.db, attempt.id, "cancelled", now);
          if (job.state === "leased") transitionJobState(this.db, job.id, "queued", now);
        } else if (attempt.state === "running") {
          transitionAttemptState(this.db, attempt.id, "cancel_requested", now);
          if (job.state === "running") transitionJobState(this.db, job.id, "cancel_requested", now);
        }
      }
      appendAudit(this.db, {
        at: now,
        actor,
        action: "worker.revoked",
        subject: workerId,
        detail: attempt ? { attemptId: attempt.id, jobId: attempt.jobId } : undefined,
      });
    });
    run();
    return this.workerView(workerId);
  }

  // --- jobs ----------------------------------------------------------------------------

  listJobs(input: { state?: JobState; limit?: number; cursor?: string }): JobPage {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), MAX_PAGE_SIZE);
    try {
      return listJobs(this.db, {
        limit,
        ...(input.state ? { state: input.state } : {}),
        ...(input.cursor ? { cursor: input.cursor } : {}),
      });
    } catch (error) {
      throw new AdminError(400, "invalid_cursor", (error as Error).message);
    }
  }

  showJob(jobId: string): AdminJobDetail {
    const job = this.requireJob(jobId);
    return {
      fci: this.fci().forJob(jobId),
      job,
      attempts: listAttemptsForJob(this.db, jobId),
      reportSteps: listJobReportSteps(this.db, jobId),
      audit: listAudit(this.db, jobId),
    };
  }

  /**
   * `jobs cancel`: stops a job an admin no longer wants run. Queued/waiting/leased and failed/
   * timed-out jobs close at once; a running one is asked to stop and closes when the worker
   * confirms. The approval it ran under is held, so reconcile does not re-dispatch the issue while
   * it still sits in the request status — a human re-requesting it in Jira runs it again.
   * `recovery_required` is refused: that needs a confirmed stop (`jobs resolve`).
   */
  cancelJob(jobId: string, actor: string): JobRow {
    const job = this.requireJob(jobId);
    if (job.state === "recovery_required") {
      throw new AdminError(
        409,
        "recovery_required",
        `job ${jobId} needs a confirmed stop; use "jobs resolve" once the worker is known to be stopped`,
      );
    }
    if (
      job.state === "succeeded" ||
      job.state === "cancelled" ||
      job.state === "cancel_requested"
    ) {
      throw new AdminError(409, "not_cancellable", `job ${jobId} is already ${job.state}`);
    }
    const now = this.now();
    cancelStaleJob(this.db, job, now);
    const run = this.db.transaction(() => {
      recordAdminHold(this.db, {
        issueKey: job.issueKey,
        approvalId: job.approvalId,
        jobId,
        actor,
        now,
      });
      appendAudit(this.db, {
        at: now,
        actor,
        action: "job.cancelled",
        subject: jobId,
        detail: { from: job.state },
      });
    });
    run();
    return this.requireJob(jobId);
  }

  async retryJob(jobId: string, actor: string): Promise<JobRow> {
    return retryJob(
      { db: this.db, jira: this.deps.jira, config: this.config, now: this.now },
      { jobId, actor },
    );
  }

  resolveJob(jobId: string, actor: string): JobRow {
    return resolveRecoveryJob(this.db, this.config, { jobId, actor, now: this.now() });
  }

  // --- reports -------------------------------------------------------------------------

  listBlockedReports(): AdminBlockedBatch[] {
    const batches = new Map<string, AdminBlockedBatch>();
    for (const step of listBlockedReportSteps(this.db)) {
      let batch = batches.get(step.batchId);
      if (!batch) {
        batch = { batchId: step.batchId, jobId: step.jobId, issueKey: step.issueKey, steps: [] };
        batches.set(step.batchId, batch);
      }
      batch.steps.push({
        id: step.id,
        seq: step.seq,
        kind: step.kind,
        status: step.status,
        tries: step.tries,
        lastError: step.lastError,
      });
    }
    return [...batches.values()];
  }

  retryReportBatch(batchId: string, actor: string): { requeued: number } {
    return { requeued: retryReportBatch(this.db, { batchId, actor, now: this.now() }) };
  }

  // --- sync, backup, status ------------------------------------------------------------

  async reconcile(actor: string): Promise<SchedulerReport> {
    if (!this.deps.reconcileNow) {
      throw new AdminError(409, "reconcile_unavailable", "this Router instance cannot reconcile");
    }
    appendAudit(this.db, { at: this.now(), actor, action: "sync.requested", subject: "reconcile" });
    return this.deps.reconcileNow();
  }

  /**
   * `router backup`: an online, consistent copy of the SQLite store via SQLite's backup API — safe
   * while the Router keeps serving (WAL). Restoring is a stopped-Router file swap (runbook).
   */
  async backup(actor: string): Promise<BackupResult> {
    const now = this.now();
    const dir =
      this.deps.backupDir ??
      path.join(path.dirname(path.resolve(this.startedWith.db.path)), "backups");
    mkdirSync(dir, { recursive: true });
    const target = path.join(dir, backupFileName(now));
    await this.db.backupTo(target);
    appendAudit(this.db, {
      at: now,
      actor,
      action: "db.backup",
      subject: "router",
      detail: { path: target },
    });
    return { path: target, bytes: statSync(target).size };
  }

  // --- config (web UI) -------------------------------------------------------------------

  /** The config file as it is on disk now, compared with what the Router is running (ADR 0024). */
  readConfig(): AdminConfigView {
    const configPath = this.requireConfigPath();
    let file: unknown;
    try {
      file = readRawRouterConfig(configPath);
    } catch (error) {
      return {
        path: configPath,
        file: null,
        restartRequired: false,
        restartFields: [],
        pendingApply: false,
        problem: (error as RouterConfigError).message,
        github: this.githubInfo(),
        jev: this.secretInfo("jev"),
      };
    }
    const validation = validateRouterConfig(file);
    if (!validation.ok) {
      return {
        path: configPath,
        file,
        restartRequired: false,
        restartFields: [],
        pendingApply: false,
        problem: validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
        github: this.githubInfo(),
        jev: this.secretInfo("jev"),
      };
    }
    const restartFields = restartOnlyChanges(this.startedWith, validation.config);
    return {
      path: configPath,
      file,
      restartRequired: restartFields.length > 0,
      restartFields,
      pendingApply: canonicalJson(validation.config) !== canonicalJson(this.config),
      problem: null,
      github: this.githubInfo(),
      jev: this.secretInfo("jev"),
    };
  }

  prompts() {
    return { ...getPromptCatalog(this.config.prompts), editable: Boolean(this.deps.configPath) };
  }
  fci() {
    return new FciService(this.db, this.config, this.now);
  }
  async configureFci(repositoryId: string, fci: z.infer<typeof FciConfigSchema>, actor: string) {
    const raw = readRawRouterConfig(this.requireConfigPath()) as RouterConfig;
    if (!raw.repositories.some((r) => r.id === repositoryId))
      throw new AdminError(404, "unknown_repository", "repository not configured");
    const next = {
      ...raw,
      repositories: raw.repositories.map((r) => (r.id === repositoryId ? { ...r, fci } : r)),
    };
    await this.updateConfig(next, actor);
    this.fci().sync();
    appendAudit(this.db, {
      at: this.now(),
      actor,
      action: "fci.configured",
      subject: repositoryId,
    });
    return this.fci().view(repositoryId);
  }

  async updatePrompt(role: AiRole, additionalInstructions: string, actor: string) {
    const configPath = this.requireConfigPath();
    let raw: unknown;
    try {
      raw = readRawRouterConfig(configPath);
    } catch (error) {
      throw new AdminError(409, "config_unreadable", (error as Error).message);
    }
    const validation = validateRouterConfig(raw);
    if (!validation.ok) {
      throw new AdminError(400, "invalid_config", "config is invalid", validation.issues);
    }
    const next = {
      ...(raw as Record<string, unknown>),
      prompts: {
        ...validation.config.prompts,
        [role]: { additionalInstructions },
      },
    };
    await this.updateConfig(next, actor);
    appendAudit(this.db, { at: this.now(), actor, action: "prompt.updated", subject: role });
    return this.prompts();
  }

  /** Validates, saves (keeping `.bak`) and applies to the running Router at once. */
  async updateConfig(raw: unknown, actor: string): Promise<ConfigApplyResult> {
    const configPath = this.requireConfigPath();
    const validation = validateRouterConfig(raw);
    if (!validation.ok) {
      throw new AdminError(400, "invalid_config", "config is invalid", validation.issues);
    }
    this.assertApprovalRulesUnchangedUnderLiveJobs(validation.config);
    writeRouterConfig(configPath, raw);
    return this.apply(validation.config, actor, "config.updated", configPath);
  }

  /**
   * A workspace's approval rules (the statuses that request, approve and run work) cannot change under a job that may still run — the job was approved under the old rules
   * and would be revoked, or kept, by the new ones. Drain or cancel those jobs first. Failed and
   * timed-out jobs run nothing; the next pass closes them under the new rules.
   */
  private assertApprovalRulesUnchangedUnderLiveJobs(next: RouterConfig): void {
    const live = getOpenJobs(this.db).filter(
      (job) => job.state !== "failed" && job.state !== "timed_out",
    );
    for (const workspace of next.workspaces) {
      const current = this.config.workspaces.find((entry) => entry.id === workspace.id);
      if (
        !current ||
        canonicalJson(approvalRules(current)) === canonicalJson(approvalRules(workspace))
      ) {
        continue;
      }
      const blocking = live.filter((job) => job.workspaceId === workspace.id);
      if (blocking.length === 0) continue;
      throw new AdminError(
        409,
        "workspace_busy",
        `workspace "${workspace.id}" changes how work is approved, but ${blocking.length} job(s) may still run under the current rules (${blocking.map((job) => `${job.issueKey} ${job.state}`).join(", ")}); let them finish or cancel them first`,
      );
    }
  }

  /**
   * "워커 추가": appends the policy to the config file, applies it, and issues the first pairing
   * code, so the new worker can run `worker start` right away (ADR 0025).
   */
  async addWorker(input: AdminAddWorkerRequest, actor: string): Promise<AdminAddWorkerResult> {
    const configPath = this.requireConfigPath();
    let raw: unknown;
    try {
      raw = readRawRouterConfig(configPath);
    } catch (error) {
      throw new AdminError(409, "config_unreadable", (error as Error).message);
    }
    const file = raw as { workers?: Array<{ workerId?: unknown }> };
    const workers = Array.isArray(file.workers) ? file.workers : [];
    if (workers.some((worker) => worker.workerId === input.workerId)) {
      throw new AdminError(409, "worker_exists", `worker "${input.workerId}" is already declared`);
    }
    const next = {
      ...(raw as Record<string, unknown>),
      workers: [
        ...workers,
        {
          workerId: input.workerId,
          allowedRepositoryIds: input.allowedRepositoryIds,
          ...(input.providerId ? { providerId: input.providerId } : {}),
        },
      ],
    };
    const validation = validateRouterConfig(next);
    if (!validation.ok) {
      throw new AdminError(400, "invalid_config", "worker policy is invalid", validation.issues);
    }
    writeRouterConfig(configPath, next);
    await this.apply(validation.config, actor, "config.updated", configPath);
    const now = this.now();
    const code = createPairingCode(this.db, { workerId: input.workerId, now });
    appendAudit(this.db, { at: now, actor, action: "worker.added", subject: input.workerId });
    return {
      worker: this.workerView(input.workerId),
      pairingCode: code.code,
      expiresAt: code.expiresAt,
    };
  }

  /** Applies the file as it is on disk (after a hand edit) without changing it. */
  async applyConfigFile(actor: string): Promise<ConfigApplyResult> {
    const configPath = this.requireConfigPath();
    let raw: unknown;
    try {
      raw = readRawRouterConfig(configPath);
    } catch (error) {
      throw new AdminError(409, "config_unreadable", (error as Error).message);
    }
    const validation = validateRouterConfig(raw);
    if (!validation.ok) {
      throw new AdminError(409, "invalid_config", "config file is invalid", validation.issues);
    }
    this.assertApprovalRulesUnchangedUnderLiveJobs(validation.config);
    return this.apply(validation.config, actor, "config.applied", configPath);
  }

  private async apply(
    config: RouterConfig,
    actor: string,
    action: string,
    configPath: string,
  ): Promise<ConfigApplyResult> {
    if (this.deps.applyConfig) await this.deps.applyConfig(config);
    else this.setConfig(config);
    const appliedWithout = restartOnlyChanges(this.startedWith, config);
    appendAudit(this.db, {
      at: this.now(),
      actor,
      action,
      subject: "router-config",
      detail: {
        path: configPath,
        ...(appliedWithout.length ? { restartFields: appliedWithout } : {}),
      },
    });
    return { ...this.readConfig(), appliedWithout };
  }

  // --- review targets (M4-11, ADR 0040) ------------------------------------------------------

  /** Every result pinned for review on the issue (newest first) and the human acts Router saw
   *  against them. Read-only: nothing here approves, accepts or completes anything. */
  issueReviews(issueKey: string): { targets: ReviewTargetRow[]; records: ReviewRecordRow[] } {
    const key = issueKey.toUpperCase();
    return { targets: listReviewTargets(this.db, key), records: listReviewRecords(this.db, key) };
  }

  // --- review queue (F01, ADR 0043) -----------------------------------------------------------

  /** Current review targets and where each stands; by default only those still waiting. */
  reviewQueue(filter: {
    issueKey?: string;
    reviewClass?: string;
    states?: string[];
    assignee?: string;
    parent?: string;
  }): { items: Array<ReviewQueueItem & { issueUrl: string }> } {
    if (
      filter.reviewClass &&
      filter.reviewClass !== "immediate" &&
      filter.reviewClass !== "standard"
    ) {
      throw new AdminError(400, "invalid_request", `unknown review class "${filter.reviewClass}"`);
    }
    const unknown = (filter.states ?? []).filter(
      (state) => !(REVIEW_QUEUE_STATES as readonly string[]).includes(state),
    );
    if (unknown.length > 0) {
      throw new AdminError(400, "invalid_request", `unknown review state "${unknown[0]}"`);
    }
    const browse = `${this.config.jira.baseUrl.replace(/\/+$/, "")}/browse/`;
    return {
      items: listReviewQueue(this.db, {
        ...(filter.issueKey ? { issueKey: filter.issueKey.toUpperCase() } : {}),
        ...(filter.reviewClass
          ? { reviewClass: filter.reviewClass as "immediate" | "standard" }
          : {}),
        ...(filter.states && filter.states.length > 0
          ? { states: filter.states as ReviewQueueState[] }
          : {}),
        ...(filter.assignee ? { assigneeAccountId: filter.assignee } : {}),
        ...(filter.parent ? { parentKey: filter.parent.toUpperCase() } : {}),
      }).map((item) => ({
        ...item,
        issueUrl: `${browse}${encodeURIComponent(item.target.issueKey)}`,
      })),
    };
  }

  /**
   * One human judgment (confirm, hold, rework) on a current review target. A record only: no Jira
   * status move, merge or approval. Hold and rework leave one Jira comment. The actor is the name
   * declared with the shared admin token and is recorded as such (`authentication: admin-token`).
   */
  judgeReview(
    targetId: string,
    body: { action: string; note?: string | undefined },
    actor: string,
  ): ReviewRecordRow {
    try {
      return judgeReviewTarget(this.db, this.config, {
        targetId,
        action: body.action,
        ...(body.note !== undefined ? { note: body.note } : {}),
        actor,
        now: this.now(),
      });
    } catch (error) {
      throw toAdminError(error);
    }
  }

  // --- Read-only issue status ----------------------------------------------------------

  /** The issue's status and what keeps Router from starting it (read-only). */
  async issueView(issueKey: string): Promise<IssueView> {
    try {
      const view = await readIssueView(this.issueViewDeps(), issueKey);
      const tasks = this.db
        .prepare("SELECT id FROM fci_tasks WHERE issue_key=? ORDER BY created_at DESC")
        .all(view.issueKey) as { id: string }[];
      const last = this.db
        .prepare(
          "SELECT r.payload,r.received_at,j.kind FROM results r JOIN jobs j ON j.id=r.job_id WHERE r.applied=1 AND j.id=(SELECT id FROM jobs WHERE issue_key=? ORDER BY created_at DESC,rowid DESC LIMIT 1) ORDER BY r.received_at DESC,r.rowid DESC LIMIT 1",
        )
        .get(view.issueKey) as { payload: string; received_at: string; kind: string } | undefined;
      const result = last ? JSON.parse(last.payload) : null;
      const latestResult = last
        ? {
            summary:
              typeof result.summary === "string" ? result.summary : "요약이 보고되지 않았습니다.",
            kind: last.kind,
            at: last.received_at,
            pullRequest: result.pullRequest ?? null,
          }
        : null;
      return { ...view, latestResult, fci: tasks.map((t) => this.fci().detail(t.id)) };
    } catch (error) {
      throw toAdminError(error);
    }
  }

  private issueViewDeps() {
    return { db: this.db, jira: this.deps.jira, config: this.config };
  }

  /** Statuses and subtask issue types of a Jira project, for the web UI pickers (read-only). */
  async jiraProject(projectKey: string): Promise<ProjectWorkflowInfo> {
    return this.callJira(() => inspectProjectWorkflow(this.deps.jira, projectKey));
  }
  async ensureWorkflow(projectKey: string, actor = "admin") {
    const workspace = this.deps.config.workspaces.find((ws) => ws.projectKeys.includes(projectKey));
    if (!workspace)
      throw new AdminError(400, "unknown_project", "설정에 등록된 프로젝트를 선택하세요.");
    const ensure = this.deps.jira.ensureAiWorkflow?.bind(this.deps.jira);
    if (!ensure)
      throw new AdminError(
        502,
        "workflow_unavailable",
        "Jira 상태 자동 추가를 지원하지 않는 연결입니다.",
      );
    const result = await this.callJira(() => ensure(projectKey, workspace.workflow));
    appendAudit(this.deps.db, {
      at: this.now(),
      actor,
      action: "jira.workflow.provisioned",
      subject: projectKey,
      detail: {
        added: result.added,
        workflowsUpdated: result.workflowsUpdated,
        complete: result.complete,
      },
    });
    return result;
  }

  /** Whether Router's own status moves exist in the project's workflow (read-only). */
  async checkWorkflow(
    projectKey: string,
    workflow: WorkspaceConfig["workflow"],
  ): Promise<{ hops: WorkflowHopResult[] }> {
    return {
      hops: await this.callJira(() => checkWorkflowHops(this.deps.jira, projectKey, workflow)),
    };
  }

  private async callJira<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw new AdminError(502, "jira_error", (error as Error).message);
    }
  }

  /** `router check` against the config file on disk (saved edits included), read-only. */
  async check(issueKey?: string): Promise<{ items: CheckItem[] }> {
    const configPath = this.requireConfigPath();
    let config: RouterConfig;
    try {
      const validation = validateRouterConfig(readRawRouterConfig(configPath));
      if (!validation.ok) {
        return {
          items: validation.issues.map((issue) => ({
            level: "fail" as const,
            message: `config ${issue.path}: ${issue.message}`,
          })),
        };
      }
      config = validation.config;
    } catch (error) {
      return { items: [{ level: "fail", message: (error as Error).message }] };
    }
    const github = {
      repos: githubRepositoriesToCheck(config, listPullRequestRepos(this.deps.db)),
      token: this.deps.github?.token?.(),
    };
    const items = await runRouterCheck(this.deps.jira, config, {
      github,
      ...(issueKey ? { issueKey } : {}),
    });
    if (config.jira.baseUrl !== this.startedWith.jira.baseUrl) {
      items.unshift({
        level: "warn",
        message: "jira.baseUrl changed; this check used the running Router's Jira connection",
      });
    }
    return { items };
  }

  status(): RouterStatus {
    const now = this.now();
    const jobs = countJobsByState(this.db);
    const oldestQueuedSince = oldestQueuedJobSince(this.db);
    const oldestUnprocessedAt = oldestUnprocessedEventAt(this.db);
    const workers = this.listWorkers();
    const blocked = new Set(listBlockedReportSteps(this.db).map((step) => step.batchId));
    return {
      jobs,
      queue: { oldestQueuedSince, waitMs: elapsedMs(oldestQueuedSince, now) },
      workers: {
        declared: workers.filter((w) => w.declared).length,
        paired: workers.filter((w) => w.paired && !w.revokedAt).length,
        online: workers.filter((w) => w.online).length,
      },
      recoveryRequired: jobs.recovery_required ?? 0,
      webhooks: { oldestUnprocessedAt, delayMs: elapsedMs(oldestUnprocessedAt, now) },
      reports: { blocked: blocked.size },
      attention: { open: countOpenAttention(this.db) },
      reviews: { waiting: countWaitingReviews(this.db) },
    };
  }

  /**
   * Execution evidence (M4-12): every stored result's provider call, with totals over what was
   * reported and a count of what was not. `includeChildren` adds the issues whose original
   * requirement `issueKey` is (plan tasks, subtasks). Read-only; JSON is the export format.
   */
  /** Local execution overview; no Jira lookup per dashboard row. */
  tasks(offset = 0, limit = 30) {
    const recent =
      "FROM jobs j WHERE NOT EXISTS (SELECT 1 FROM jobs newer WHERE newer.issue_key=j.issue_key AND (newer.created_at>j.created_at OR (newer.created_at=j.created_at AND newer.rowid>j.rowid)))";
    const rows = this.db
      .prepare(`SELECT j.*, COALESCE((SELECT json_extract(i.snapshot,'$.issue.summary') FROM job_inputs i WHERE i.job_id=j.id),(SELECT json_extract(a.input_snapshot,'$.issue.summary') FROM approvals a WHERE a.issue_key=j.issue_key)) AS title,
      (SELECT json_extract(i.snapshot,'$.planTask.parentKey') FROM job_inputs i WHERE i.job_id=j.id) AS parent_key,
      (SELECT json_extract(r.payload,'$.summary') FROM results r WHERE r.job_id=j.id AND r.applied=1 ORDER BY r.received_at DESC,r.rowid DESC LIMIT 1) AS summary,
      (SELECT json_extract(r.payload,'$.status') FROM results r WHERE r.job_id=j.id AND r.applied=1 ORDER BY r.received_at DESC,r.rowid DESC LIMIT 1) AS result_status
      ${recent} ORDER BY CASE WHEN j.state IN ('succeeded','cancelled') THEN 1 ELSE 0 END,j.updated_at DESC,j.rowid DESC LIMIT ? OFFSET ?`)
      .all(
        Math.max(1, Math.min(100, Math.trunc(limit) || 30)),
        Math.max(0, Math.trunc(offset) || 0),
      ) as Array<{
      issue_key: string;
      title: string | null;
      kind: string;
      state: string;
      updated_at: string;
      summary: string | null;
      parent_key: string | null;
      result_status: string | null;
      id: string;
    }>;
    const browse = `${this.config.jira.baseUrl.replace(/\/$/, "")}/browse/`;
    return {
      total: (this.db.prepare(`SELECT COUNT(*) n ${recent}`).get() as { n: number }).n,
      items: rows.map((row) => ({
        issueKey: row.issue_key,
        title: row.title,
        kind: row.kind,
        state: row.state,
        updatedAt: row.updated_at,
        summary: row.summary,
        parentKey: row.parent_key,
        resultStatus: row.result_status,
        issueUrl: `${browse}${encodeURIComponent(row.issue_key)}`,
        pullRequest:
          this.db
            .prepare(
              "SELECT url,state,number FROM pull_requests WHERE job_id=? ORDER BY updated_at DESC LIMIT 1",
            )
            .get(row.id) ?? null,
        attention: listAttentionItems(this.db, { issueKey: row.issue_key, status: "open" }).map(
          (a) => ({ kind: a.kind, reason: a.reason }),
        ),
      })),
    };
  }

  executions(filter: { issueKey?: string; includeChildren?: boolean }): {
    records: ExecutionRecordRow[];
    totals: ExecutionTotals;
  } {
    const records = listExecutionRecords(this.db, {
      ...(filter.issueKey ? { issueKey: filter.issueKey.toUpperCase() } : {}),
      ...(filter.includeChildren ? { includeChildren: true } : {}),
    });
    return { records, totals: totalExecutions(records) };
  }

  /** Attention items (M4-09), newest activity first. Read-only; resolving happens on its own when
   *  the cause goes away (a new approval, a later success, a matched merge, a cleared report). */
  attention(filter: { status?: string; issueKey?: string; kind?: string }): {
    items: AttentionItemRow[];
  } {
    const status =
      filter.status === "all" ? undefined : filter.status === "resolved" ? "resolved" : "open";
    return {
      items: listAttentionItems(this.db, {
        ...(status ? { status } : {}),
        ...(filter.issueKey ? { issueKey: filter.issueKey.toUpperCase() } : {}),
        ...(filter.kind ? { kind: filter.kind as AttentionKind } : {}),
      }),
    };
  }

  // --- helpers -------------------------------------------------------------------------

  secretInfo(id: SecretSlotId): SecretInfo {
    const slot = this.deps.secrets?.slots[id];
    if (!slot) return { set: false, source: null, editable: false };
    const set = slot.isSet();
    return {
      set,
      source: slot.fromEnvironment ? "environment" : set ? "file" : null,
      editable: !slot.fromEnvironment && Boolean(this.deps.secrets?.secretsPath),
    };
  }

  /**
   * Web UI secret input: writes (or with `null` removes) the slot's line in the secrets file and
   * hands the value to the running Router, so it applies without a restart. The audit entry
   * records that it changed, never the value (ADR 0031).
   */
  setSecret(id: SecretSlotId, value: string | null, actor: string): SecretInfo {
    const slot = this.deps.secrets?.slots[id];
    const secretsPath = this.deps.secrets?.secretsPath;
    if (!slot || !secretsPath) {
      throw new AdminError(409, "not_editable", "this Router has no secrets file to write to");
    }
    if (slot.fromEnvironment) {
      throw new AdminError(
        409,
        "set_by_environment",
        `${slot.envKey} is set in the Router's environment, which wins over the secrets file; change it there`,
      );
    }
    if (value !== null) {
      const parsed = SecretValueSchema.safeParse(value);
      if (!parsed.success) {
        const message = parsed.error.issues[0]?.message ?? "invalid value";
        throw new AdminError(400, "invalid_request", message, [{ path: "value", message }]);
      }
    }
    setSecretsFileValue(secretsPath, slot.envKey, value);
    slot.apply(value ?? undefined);
    appendAudit(this.db, {
      at: this.now(),
      actor,
      action: `secret.${SECRET_AUDIT_NAMES[id]}.${value === null ? "removed" : "set"}`,
      subject: slot.envKey,
    });
    return this.secretInfo(id);
  }

  /** "지금 확인": one pull-request poll on demand, then the refreshed GitHub view. */
  async pollGithubNow(): Promise<AdminGithubView & { report: PullRequestPollReport }> {
    if (!this.deps.pollGithub) {
      throw new AdminError(409, "not_available", "GitHub polling is not running in this Router");
    }
    const report = await this.deps.pollGithub();
    return { ...this.githubInfo(), report };
  }

  private githubInfo(): AdminGithubView {
    return {
      webhook: this.deps.github?.webhook ?? false,
      token: this.secretInfo("githubToken"),
      pullRequests: listRecentPullRequests(this.db, 20),
    };
  }

  private requireConfigPath(): string {
    if (!this.deps.configPath) {
      throw new AdminError(409, "config_unavailable", "this Router instance has no config file");
    }
    return this.deps.configPath;
  }

  private requireJob(jobId: string): JobRow {
    const job = getJob(this.db, jobId);
    if (!job) throw new AdminError(404, "unknown_job", `no job ${jobId}`);
    return job;
  }

  private requirePairedWorker(workerId: string): void {
    if (!getWorker(this.db, workerId)) {
      throw new AdminError(404, "unknown_worker", `worker ${workerId} has never been paired`);
    }
  }

  private workerView(workerId: string): AdminWorkerView {
    const view = this.listWorkers().find((worker) => worker.workerId === workerId);
    if (!view) throw new AdminError(404, "unknown_worker", `no worker ${workerId}`);
    return view;
  }
}
