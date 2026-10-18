import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { AdminAddWorkerRequest, ProviderUsage } from "../contracts/api.js";
import type { JobState } from "../contracts/job-state.js";
import type { JiraGateway } from "../jira/gateway.js";
import { isWorkerDispatchable } from "./availability.js";
import { type CheckItem, runRouterCheck } from "./check.js";
import type { RouterConfig, RouterConfigError, WorkspaceConfig } from "./config.js";
import {
  type ConfigIssue,
  canonicalJson,
  readRawRouterConfig,
  restartOnlyChanges,
  setSecretsFileValue,
  validateRouterConfig,
  writeRouterConfig,
} from "./config-store.js";
import { listRecentPullRequests, type PullRequestRow } from "./db/pull-requests.js";
import {
  applyLabelMigration,
  LabelMigrationError,
  type LabelMigrationPlan,
  type LabelMigrationResult,
  type LabelMigrationTarget,
  planLabelMigration,
} from "./label-migration.js";
import type { PullRequestPollReport } from "./github.js";
import {
  IssueOptInError,
  type IssueOptInErrorCode,
  type IssueOptInView,
  readIssueOptIn,
  type SetOptInResult,
  setIssueOptIn,
} from "./issue-opt-in.js";
import { SecretValueSchema } from "./secrets.js";
import {
  type AttemptRow,
  getActiveAttemptForWorker,
  listAttemptsForJob,
  transitionAttemptState,
} from "./db/attempts.js";
import { type AuditEntry, appendAudit, listAudit } from "./db/audit.js";
import { oldestUnprocessedEventAt } from "./db/events.js";
import { recordAdminHold } from "./db/holds.js";
import { listOpenReadinessHolds, type ReadinessHoldRow } from "./db/readiness-holds.js";
import {
  type AttentionItemRow,
  type AttentionKind,
  countOpenAttention,
  listAttentionItems,
} from "./db/attention.js";
import {
  listReviewRecords,
  listReviewTargets,
  type ReviewRecordRow,
  type ReviewTargetRow,
} from "./db/review-targets.js";
import { createPairingCode } from "./db/pairing.js";
import {
  countJobsByState,
  getJob,
  getOpenJobs,
  type JobPage,
  type JobRow,
  listJobs,
  oldestQueuedJobSince,
  transitionJobState,
} from "./db/jobs.js";
import {
  listBlockedReportSteps,
  listJobReportSteps,
  type ReportStepRow,
} from "./db/report-steps.js";
import { listProviderUsage } from "./db/provider-usage.js";
import { type UsagePressure, usagePressure } from "./usage-routing.js";
import { getWorker, listWorkers, revokeWorker, setWorkerEnabled } from "./db/workers.js";
import { resolveRecoveryJob, retryJob, retryReportBatch } from "./recovery.js";
import { cancelStaleJob, type SchedulerReport } from "./scheduler.js";
import {
  checkWorkflowHops,
  inspectProjectWorkflow,
  type ProjectWorkflowInfo,
  type WorkflowHopResult,
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
  reportedCapabilities: string[];
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
  db: Database.Database;
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
  github?: { webhook: boolean };
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
  const { mode, optInLabel, requestStatus, planningStatus, inProgressStatus } = workspace.workflow;
  return {
    mode: mode ?? "legacy",
    optInLabel: optInLabel ?? null,
    requestStatus,
    planningStatus: planningStatus ?? null,
    inProgressStatus,
  };
}

function elapsedMs(since: string | null, now: string): number | null {
  return since ? Math.max(0, Date.parse(now) - Date.parse(since)) : null;
}

const OPT_IN_ERROR_STATUS: Record<IssueOptInErrorCode, AdminError["status"]> = {
  invalid_issue_key: 400,
  unknown_project: 404,
  unknown_issue: 404,
  not_label_mode: 409,
  jira_forbidden: 502,
  jira_rate_limited: 502,
  jira_error: 502,
  unconfirmed: 502,
};

function toAdminError(error: unknown): AdminError {
  if (error instanceof AdminError) return error;
  if (error instanceof IssueOptInError) {
    return new AdminError(OPT_IN_ERROR_STATUS[error.code], error.code, error.message);
  }
  return new AdminError(502, "jira_error", error instanceof Error ? error.message : String(error));
}

function backupFileName(now: string): string {
  return `router-${now.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}.sqlite3`;
}

export class AdminService {
  private readonly db: Database.Database;
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
        reportedCapabilities: row?.reportedCapabilities ?? [],
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

  /** Implementation requests Router is holding for an incomplete scope contract (ADR 0034). */
  listReadinessHolds(): ReadinessHoldRow[] {
    return listOpenReadinessHolds(this.db);
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
    await this.db.backup(target);
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
   * ADR 0037: a workspace's approval rules (mode, opt-in label, the statuses that request and run
   * work) cannot change under a job that may still run — the job was approved under the old rules
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
          allowedCapabilities: input.allowedCapabilities,
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

  // --- legacy → label migration (ADR 0037) ------------------------------------------------

  /** Read-only proposal; a human reviews it and marks entries `approved`. */
  async planLabelMigration(
    workspaceId: string,
    target: LabelMigrationTarget,
  ): Promise<LabelMigrationPlan> {
    const workspace = this.requireWorkspace(workspaceId);
    try {
      return await planLabelMigration({
        db: this.db,
        jira: this.deps.jira,
        workspace,
        target,
        now: this.now(),
      });
    } catch (error) {
      if (error instanceof LabelMigrationError) {
        throw new AdminError(409, "not_migratable", error.message);
      }
      throw new AdminError(502, "jira_error", (error as Error).message);
    }
  }

  /** Applies a reviewed plan's approved entries; every issue's outcome goes to the audit log. */
  async applyLabelMigration(
    plan: LabelMigrationPlan,
    actor: string,
  ): Promise<{ results: LabelMigrationResult[] }> {
    const workspace = this.requireWorkspace(plan.workspaceId);
    try {
      const results = await applyLabelMigration({
        db: this.db,
        jira: this.deps.jira,
        workspace,
        plan,
        onResult: (result) => {
          if (result.outcome === "skipped" && result.detail === "not approved") return;
          appendAudit(this.db, {
            at: this.now(),
            actor,
            action: `migration.label.${result.outcome}`,
            subject: result.issueKey,
            detail: { workspaceId: workspace.id, action: result.action, detail: result.detail },
          });
        },
      });
      return { results };
    } catch (error) {
      if (error instanceof LabelMigrationError) {
        throw new AdminError(409, "not_migratable", error.message);
      }
      throw error;
    }
  }

  // --- review targets (M4-11, ADR 0040) ------------------------------------------------------

  /** Every result pinned for review on the issue (newest first) and the human acts Router saw
   *  against them. Read-only: nothing here approves, accepts or completes anything. */
  issueReviews(issueKey: string): { targets: ReviewTargetRow[]; records: ReviewRecordRow[] } {
    const key = issueKey.toUpperCase();
    return { targets: listReviewTargets(this.db, key), records: listReviewRecords(this.db, key) };
  }

  // --- AI participation per issue (M4-03, ADR 0039) ----------------------------------------

  /** The issue's opt-in label, status and what keeps Router from starting it (read-only). */
  async issueOptIn(issueKey: string): Promise<IssueOptInView> {
    try {
      return await readIssueOptIn(this.optInDeps(), issueKey);
    } catch (error) {
      throw toAdminError(error);
    }
  }

  /**
   * Adds or removes the workspace's opt-in label on one issue, leaving its other labels alone.
   * Every attempt is audited — refused ones too — with the authentication behind it: the shared
   * admin token, whose actor name the caller declares, never the issue assignee's own identity.
   */
  async setIssueOptIn(issueKey: string, enabled: boolean, actor: string): Promise<SetOptInResult> {
    const audit = (outcome: string, detail: Record<string, unknown>) =>
      appendAudit(this.db, {
        at: this.now(),
        actor,
        action: `issue.opt_in.${outcome}`,
        subject: issueKey,
        detail: { requested: enabled ? "on" : "off", authentication: "admin-token", ...detail },
      });
    try {
      const { before, ...result } = await setIssueOptIn(this.optInDeps(), issueKey, enabled);
      const { view } = result;
      audit(result.outcome === "unchanged" ? "unchanged" : enabled ? "added" : "removed", {
        workspaceId: view.workspaceId,
        label: view.optInLabel,
        labelsBefore: before,
        labelsAfter: view.labels,
        ...(result.confirmedAfterError ? { confirmedAfterError: true } : {}),
        ...(view.openJob ? { openJob: view.openJob } : {}),
      });
      return result;
    } catch (error) {
      const adminError = toAdminError(error);
      audit("failed", { error: adminError.code, message: adminError.message });
      throw adminError;
    }
  }

  private optInDeps() {
    return { db: this.db, jira: this.deps.jira, config: this.config };
  }

  private requireWorkspace(workspaceId: string): WorkspaceConfig {
    const workspace = this.config.workspaces.find((entry) => entry.id === workspaceId);
    if (!workspace) throw new AdminError(404, "unknown_workspace", `no workspace "${workspaceId}"`);
    return workspace;
  }

  /** Statuses and subtask issue types of a Jira project, for the web UI pickers (read-only). */
  async jiraProject(projectKey: string): Promise<ProjectWorkflowInfo> {
    return this.callJira(() => inspectProjectWorkflow(this.deps.jira, projectKey));
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
    const items = await runRouterCheck(this.deps.jira, config, issueKey ? { issueKey } : {});
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
    };
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
