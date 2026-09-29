import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import type { JiraGateway } from "../jira/gateway.js";
import type { Logger } from "../logger.js";
import { AdminService } from "./admin-service.js";
import { type AssessmentPassReport, assessPendingJobs } from "./assessment.js";
import { buildWorkerAvailability } from "./availability.js";
import type { RouterConfig } from "./config.js";
import { listUnprocessedEvents, markEventProcessed } from "./db/events.js";
import { RuleDecisionProvider } from "./decision.js";
import { expireLeases, type LeaseExpiryReport } from "./leases.js";
import { processReportJournal, type ReportPassReport } from "./report-processor.js";
import {
  reconcileCandidates,
  type SchedulerDeps,
  type SchedulerReport,
  verifyActiveJobs,
} from "./scheduler.js";
import {
  type FetchLike,
  handlePullRequestClosed,
  type PullRequestPollReport,
  pollPullRequests,
} from "./github.js";
import { JevClient } from "./jev.js";
import { GITHUB_TOKEN_ENV, JEV_API_KEY_ENV } from "./secrets.js";
import { buildRouterServer } from "./server.js";
import { WorkerService } from "./worker-service.js";

/** How often the daemon looks for newly received webhooks (§2 "웹훅 ... 이후 처리한다"). */
export const EVENT_POLL_INTERVAL_MS = 1_000;
/** How often pending Jira report steps are run forward. */
export const REPORT_INTERVAL_MS = 2_000;
/** How often expired leases are swept (worker API calls also sweep on the way in). */
export const LEASE_SWEEP_INTERVAL_MS = 5_000;
/** After a failed reconcile, webhook-triggered passes wait this long before trying Jira again. */
export const SYNC_FAILURE_BACKOFF_MS = 10_000;
/** How often new jobs are handed to Jev for a shadow assessment (ADR 0030). */
export const ASSESS_INTERVAL_MS = 2_000;

export interface RouterDaemonDeps {
  db: Database.Database;
  jira: JiraGateway;
  config: RouterConfig;
  webhookSecret: string;
  adminToken: string;
  siteId: string;
  /** The config file `config` was loaded from; lets the web UI read and edit it. */
  configPath?: string;
  logger?: Logger;
  now?: () => string;
  /** Epoch ms for scheduling decisions; injected by tests. */
  nowMs?: () => number;
  /** Loop cadences; production uses the constants above (tests shorten them). */
  intervals?: Partial<{ eventPollMs: number; reportMs: number; leaseSweepMs: number }>;
  /** `jobs/next` long-poll length; defaults to the protocol's 25s. */
  longPollMs?: number;
  /** GitHub integration (ADR 0027): webhook secret enables `/webhooks/github`; the token (optional)
   *  authenticates the pull-request poll and can be replaced from the web UI (ADR 0032). */
  github?: {
    webhookSecret?: string | undefined;
    token?: string | undefined;
    tokenFromEnvironment?: boolean;
    fetch?: FetchLike;
  };
  /** Jev API key (ADR 0030); the assess loop runs only with one and `config.jev.enabled`. */
  jev?: { apiKey?: string | undefined; fromEnvironment?: boolean; fetch?: FetchLike };
  /** The secrets file (`router.env`) the web UI writes replaced secrets to (ADR 0031). Without it
   *  secrets are read-only in the UI. A secret set in the environment stays read-only. */
  secretsPath?: string;
}

interface Loop {
  timer: NodeJS.Timeout | undefined;
  inFlight: Promise<void> | undefined;
}

/**
 * `ggjira router serve`: the one long-running Router process
 * (docs/router-service-implementation-plan.md §2 "Router Service"). It owns the Fastify app
 * (webhooks, worker API, admin API) and four background loops:
 *
 * - sync — full candidate reconcile on boot, every `reconciliation.backgroundIntervalMs`, and
 *   whenever a webhook has been received (webhooks are change notifications; every decision still
 *   re-reads Jira). Events are marked processed only after a pass that started after they arrived
 *   succeeds.
 * - verify — re-checks every leased/running job's approval every
 *   `reconciliation.activeJobPollIntervalMs` (§2 "최대 5초 간격").
 * - reports — runs the Jira report journal forward (ADR 0021).
 * - leases — expires stale leases (§3 "임대와 작업 상태").
 *
 * sync and verify share one lane, so they never cancel the same job from two passes at once.
 * Restarting the daemon changes nothing by itself: all state is in SQLite (§3 "Router 재시작은
 * 임대를 지우거나 실행을 자동 재개하지 않는다").
 */
export class RouterDaemon {
  readonly workerService: WorkerService;
  readonly adminService: AdminService;
  readonly app: FastifyInstance;

  private readonly now: () => string;
  private readonly nowMs: () => number;
  private readonly schedulerDeps: SchedulerDeps;
  /** The applied config; replaced by `applyConfig` (ADR 0024). */
  private config: RouterConfig;
  private readonly loops = new Map<string, Loop>();
  private lane: Promise<unknown> = Promise.resolve();
  private stopping = false;
  private lastSyncAtMs: number | undefined;
  private lastSyncFailureAtMs: number | undefined;
  private jevApiKey: string | undefined;
  private githubToken: string | undefined;

  constructor(private readonly deps: RouterDaemonDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
    this.nowMs = deps.nowMs ?? Date.now;
    this.config = deps.config;
    this.jevApiKey = deps.jev?.apiKey;
    this.githubToken = deps.github?.token;
    this.schedulerDeps = {
      db: deps.db,
      jira: deps.jira,
      config: deps.config,
      decisionProvider: new RuleDecisionProvider(deps.config.executionAgent),
      now: this.now,
    };
    this.workerService = new WorkerService({
      db: deps.db,
      config: deps.config,
      now: this.now,
      ...(deps.longPollMs !== undefined ? { longPollMs: deps.longPollMs } : {}),
    });
    this.adminService = new AdminService({
      db: deps.db,
      jira: deps.jira,
      config: deps.config,
      now: this.now,
      reconcileNow: () => this.reconcileNow(),
      applyConfig: (config) => this.applyConfig(config),
      github: { webhook: Boolean(deps.github?.webhookSecret) },
      secrets: {
        ...(deps.secretsPath ? { secretsPath: deps.secretsPath } : {}),
        slots: {
          jev: {
            envKey: JEV_API_KEY_ENV,
            fromEnvironment: deps.jev?.fromEnvironment ?? false,
            isSet: () => Boolean(this.jevApiKey),
            apply: (value) => {
              this.jevApiKey = value;
            },
          },
          githubToken: {
            envKey: GITHUB_TOKEN_ENV,
            fromEnvironment: deps.github?.tokenFromEnvironment ?? false,
            isSet: () => Boolean(this.githubToken),
            apply: (value) => {
              this.githubToken = value;
              // Re-check open PRs with the new token now rather than in up to 5 minutes.
              this.githubTick().catch((error: unknown) =>
                this.deps.logger?.error(
                  { layer: "router", err: error },
                  "pull request poll failed",
                ),
              );
            },
          },
        },
      },
      pollGithub: () => this.githubTick(),
      ...(deps.configPath ? { configPath: deps.configPath } : {}),
    });
    this.app = buildRouterServer({
      db: deps.db,
      webhookSecret: deps.webhookSecret,
      siteId: deps.siteId,
      now: this.now,
      workerService: this.workerService,
      adminToken: deps.adminToken,
      adminService: this.adminService,
      ...(deps.github?.webhookSecret
        ? {
            github: {
              webhookSecret: deps.github.webhookSecret,
              onPullRequestClosed: (event) =>
                handlePullRequestClosed(deps.db, this.config, event, this.now()),
            },
          }
        : {}),
    });
  }

  /** Starts the background loops. The first sync runs right away when
   *  `reconciliation.startupFullSyncOnBoot` is set (§2 "Router 시작 시 전체 실행 후보를 재조회"). */
  start(): void {
    if (!this.config.reconciliation.startupFullSyncOnBoot) this.lastSyncAtMs = this.nowMs();
    const intervals = this.deps.intervals ?? {};
    this.startLoop(
      "sync",
      () => intervals.eventPollMs ?? EVENT_POLL_INTERVAL_MS,
      () => this.syncTick(),
    );
    this.startLoop(
      "verify",
      () => this.config.reconciliation.activeJobPollIntervalMs,
      async () => {
        await this.verifyTick();
      },
    );
    this.startLoop(
      "reports",
      () => intervals.reportMs ?? REPORT_INTERVAL_MS,
      async () => {
        await this.reportTick();
      },
    );
    this.startLoop(
      "github",
      () => this.config.github.pollIntervalMs,
      async () => {
        await this.githubTick();
      },
    );
    this.startLoop(
      "assess",
      () => ASSESS_INTERVAL_MS,
      async () => {
        await this.assessTick();
      },
    );
    this.startLoop(
      "leases",
      () => intervals.leaseSweepMs ?? LEASE_SWEEP_INTERVAL_MS,
      async () => {
        this.leaseTick();
      },
    );
  }

  /**
   * Swaps a validated config into the running Router (ADR 0024). Runs on the sync/verify lane, so
   * no reconcile or verify pass sees half of it. Worker API calls already in flight finish on the
   * config they read. Connection settings (http, db, Jira client) stay as started.
   */
  applyConfig(config: RouterConfig): Promise<void> {
    return this.exclusive(async () => {
      this.config = config;
      this.schedulerDeps.config = config;
      this.schedulerDeps.decisionProvider = new RuleDecisionProvider(config.executionAgent);
      this.workerService.setConfig(config);
      this.adminService.setConfig(config);
      this.deps.logger?.info(
        { layer: "router", workers: config.workers.length, workspaces: config.workspaces.length },
        "config applied",
      );
    });
  }

  async listen(host: string, port: number): Promise<string> {
    return this.app.listen({ host, port });
  }

  /** Stops the loops, waits for any pass in flight, then closes the HTTP server. */
  async stop(): Promise<void> {
    this.stopping = true;
    for (const loop of this.loops.values()) {
      if (loop.timer) clearTimeout(loop.timer);
    }
    await Promise.allSettled([...this.loops.values()].map((loop) => loop.inFlight));
    await this.app.close();
  }

  // --- ticks (public so tests can drive them without timers) ----------------------------

  /** Runs a reconcile if a webhook is waiting or the background interval has elapsed — unless the
   *  last pass failed less than `SYNC_FAILURE_BACKOFF_MS` ago (Jira down: don't hammer it). */
  async syncTick(): Promise<SchedulerReport | undefined> {
    const nowMs = this.nowMs();
    if (
      this.lastSyncFailureAtMs !== undefined &&
      nowMs - this.lastSyncFailureAtMs < SYNC_FAILURE_BACKOFF_MS
    ) {
      return undefined;
    }
    const intervalDue =
      this.lastSyncAtMs === undefined ||
      nowMs - this.lastSyncAtMs >= this.config.reconciliation.backgroundIntervalMs;
    if (!intervalDue && listUnprocessedEvents(this.deps.db).length === 0) return undefined;
    return this.reconcileNow();
  }

  /** One full reconcile pass, serialized with every other sync/verify pass. */
  reconcileNow(): Promise<SchedulerReport> {
    return this.exclusive(async () => {
      const eventIds = listUnprocessedEvents(this.deps.db).map((event) => event.id);
      const startedAtMs = this.nowMs();
      let report: SchedulerReport;
      try {
        report = await reconcileCandidates(
          this.schedulerDeps,
          buildWorkerAvailability(this.deps.db, this.config, this.now()),
        );
      } catch (error) {
        this.lastSyncFailureAtMs = this.nowMs();
        throw error;
      }
      this.lastSyncAtMs = startedAtMs;
      this.lastSyncFailureAtMs = undefined;
      const processedAt = this.now();
      for (const id of eventIds) markEventProcessed(this.deps.db, id, processedAt);
      this.logSchedulerReport("reconcile", report, { events: eventIds.length });
      return report;
    });
  }

  verifyTick(): Promise<SchedulerReport> {
    return this.exclusive(async () => {
      const report = await verifyActiveJobs(this.schedulerDeps);
      this.logSchedulerReport("verify", report);
      return report;
    });
  }

  async reportTick(): Promise<ReportPassReport> {
    const report = await processReportJournal({
      db: this.deps.db,
      jira: this.deps.jira,
      now: this.now,
    });
    if (report.applied.length || report.blocked.length || report.skipped.length) {
      this.deps.logger?.info(
        {
          layer: "router",
          applied: report.applied.length,
          skipped: report.skipped,
          blocked: report.blocked,
          deferred: report.deferred.length,
        },
        "report journal pass",
      );
    }
    return report;
  }

  /** Re-checks open GGJIRA pull requests on GitHub (the webhook fallback, ADR 0027). */
  async githubTick(): Promise<PullRequestPollReport> {
    const report = await pollPullRequests({
      db: this.deps.db,
      config: this.config,
      token: this.githubToken,
      ...(this.deps.github?.fetch ? { fetch: this.deps.github.fetch } : {}),
      now: this.now,
    });
    if (report.closed.length || report.errors.length) {
      this.deps.logger?.info(
        { layer: "router", closed: report.closed, errors: report.errors },
        "pull request poll",
      );
    }
    return report;
  }

  /** Shadow-assesses new jobs with Jev. Off (undefined) without an API key or with
   *  `jev.enabled: false`; the client follows the applied config's model and timeout. */
  async assessTick(): Promise<AssessmentPassReport | undefined> {
    const apiKey = this.jevApiKey;
    if (!apiKey || !this.config.jev.enabled) return undefined;
    const jev = new JevClient({
      apiKey,
      model: this.config.jev.model,
      timeoutMs: this.config.jev.timeoutMs,
      ...(this.deps.jev?.fetch ? { fetch: this.deps.jev.fetch } : {}),
    });
    const report = await assessPendingJobs({ db: this.deps.db, jev, now: this.now });
    if (report.assessed.length || report.failed.length) {
      this.deps.logger?.info(
        { layer: "router", assessed: report.assessed, failed: report.failed },
        "jev assessment pass",
      );
    }
    return report;
  }

  leaseTick(): LeaseExpiryReport {
    const report = expireLeases(this.deps.db, this.now());
    if (report.requeued.length || report.recoveryRequired.length) {
      this.deps.logger?.warn({ layer: "router", ...report }, "leases expired");
    }
    return report;
  }

  // --- internals -----------------------------------------------------------------------

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lane.then(fn, fn);
    this.lane = run.catch(() => undefined);
    return run;
  }

  private startLoop(name: string, intervalMs: () => number, fn: () => Promise<unknown>): void {
    const loop: Loop = { timer: undefined, inFlight: undefined };
    this.loops.set(name, loop);
    const tick = (): void => {
      if (this.stopping) return;
      loop.inFlight = fn()
        .then(() => undefined)
        .catch((error: unknown) => {
          this.deps.logger?.error({ layer: "router", loop: name, err: error }, "loop pass failed");
        })
        .finally(() => {
          loop.inFlight = undefined;
          if (!this.stopping) loop.timer = setTimeout(tick, intervalMs());
        });
    };
    loop.timer = setTimeout(tick, 0);
  }

  private logSchedulerReport(
    pass: string,
    report: SchedulerReport,
    extra: Record<string, unknown> = {},
  ): void {
    const changed =
      report.jobsCreated.length ||
      report.jobsCancelled.length ||
      report.jobsCancelRequested.length ||
      report.jobsAssigned.length ||
      report.held.length ||
      report.skipped.length;
    if (!changed) return;
    this.deps.logger?.info(
      {
        layer: "router",
        pass,
        ...extra,
        candidates: report.candidatesSeen,
        created: report.jobsCreated,
        cancelled: report.jobsCancelled,
        cancelRequested: report.jobsCancelRequested,
        assigned: report.jobsAssigned,
        held: report.held,
        skipped: report.skipped,
      },
      `${pass} pass`,
    );
  }
}
