import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { PROTOCOL_VERSION } from "../../src/contracts/protocol.js";
import { FakeJiraGateway } from "../../src/jira/fake.js";
import { AdminService } from "../../src/router/admin-service.js";
import { buildWorkerAvailability } from "../../src/router/availability.js";
import type { RouterConfig } from "../../src/router/config.js";
import { openRouterDb } from "../../src/router/db/connection.js";
import { RuleDecisionProvider } from "../../src/router/decision.js";
import { reconcileCandidates } from "../../src/router/scheduler.js";
import { handlePullRequestClosed } from "../../src/router/github.js";
import { buildRouterServer } from "../../src/router/server.js";
import { WorkerService, type WorkerServiceDeps } from "../../src/router/worker-service.js";
import {
  buildRouterConfig,
  issueDescription,
  ManualClock,
  REQUEST_STATUS,
  workerPolicy,
} from "./router-fixtures.js";

export const ADMIN_TOKEN = "admin-token-at-least-16-chars";
export const WEBHOOK_SECRET = "webhook-secret-at-least-16-chars";

export interface RegisteredWorker {
  workerId: string;
  token: string;
  sessionId: string;
}

/**
 * A real Router (temp SQLite + FakeJiraGateway + Fastify app with the worker routes) driven by a
 * manual clock, for worker-API/lease/runner tests. Nothing here talks to real Jira.
 */
export class RouterHarness {
  readonly dataDir: string;
  readonly dbPath: string;
  db: Database.Database;
  readonly jira = new FakeJiraGateway();
  readonly clock = new ManualClock();
  readonly config: RouterConfig;
  service: WorkerService;
  admin: AdminService;
  app: FastifyInstance;
  private readonly serviceOverrides: Partial<WorkerServiceDeps>;
  private readonly configPath: string | undefined;
  private readonly githubWebhookSecret: string | undefined;

  constructor(
    opts: {
      config?: Partial<RouterConfig>;
      service?: Partial<WorkerServiceDeps>;
      /** Config file the admin service reads/writes for `/admin/config` and `/admin/check`. */
      configPath?: string;
      /** Enables `/webhooks/github` with this secret. */
      githubWebhookSecret?: string;
    } = {},
  ) {
    this.dataDir = mkdtempSync(path.join(tmpdir(), "ggjira-router-harness-"));
    this.dbPath = path.join(this.dataDir, "router.sqlite3");
    this.db = openRouterDb(this.dbPath);
    this.config = buildRouterConfig({
      workers: [workerPolicy({ workerId: "worker-1" }), workerPolicy({ workerId: "worker-2" })],
      ...opts.config,
    });
    this.serviceOverrides = opts.service ?? {};
    this.configPath = opts.configPath;
    this.githubWebhookSecret = opts.githubWebhookSecret;
    this.service = this.buildService();
    this.admin = this.buildAdmin();
    this.app = this.buildApp();
  }

  private buildAdmin(): AdminService {
    return new AdminService({
      db: this.db,
      jira: this.jira,
      config: this.config,
      now: this.clock.now,
      reconcileNow: () => this.reconcile(),
      backupDir: path.join(this.dataDir, "backups"),
      ...(this.configPath ? { configPath: this.configPath } : {}),
      applyConfig: async (config) => {
        this.service.setConfig(config);
        this.admin.setConfig(config);
      },
    });
  }

  private buildService(): WorkerService {
    return new WorkerService({
      db: this.db,
      config: this.config,
      now: this.clock.now,
      longPollMs: 0,
      ...this.serviceOverrides,
    });
  }

  private buildApp(): FastifyInstance {
    return buildRouterServer({
      db: this.db,
      webhookSecret: WEBHOOK_SECRET,
      siteId: "site-1",
      now: this.clock.now,
      workerService: this.service,
      adminToken: ADMIN_TOKEN,
      adminService: this.admin,
      ...(this.githubWebhookSecret
        ? {
            github: {
              webhookSecret: this.githubWebhookSecret,
              onPullRequestClosed: (event) =>
                handlePullRequestClosed(this.db, this.config, event, this.clock.now()),
            },
          }
        : {}),
    });
  }

  /** Simulates a Router process restart: closes and reopens the DB, rebuilds service + app. */
  async restart(): Promise<void> {
    await this.app.close();
    this.db.close();
    this.db = openRouterDb(this.dbPath);
    this.service = this.buildService();
    this.admin = this.buildAdmin();
    this.app = this.buildApp();
  }

  async close(): Promise<void> {
    await this.app.close();
    this.db.close();
    rmSync(this.dataDir, { recursive: true, force: true });
  }

  /** Seeds an approved issue and runs a reconcile so it has a `queued` job. */
  async seedQueuedJob(key = "KAN-1"): Promise<void> {
    this.jira.seedIssue(
      {
        key,
        summary: `Implement ${key}`,
        statusName: REQUEST_STATUS,
        projectKey: "KAN",
        assigneeAccountId: "user-1",
        description: issueDescription(),
      },
      [
        { id: "revoke", name: "Revoke", toStatusName: "To Do" },
        { id: "request", name: "Request", toStatusName: REQUEST_STATUS },
      ],
    );
    await this.reconcile();
  }

  /** Seeds a job and runs one background pass with every online worker, as the daemon does. */
  async seedQueuedJobAndAssign(key = "KAN-1") {
    await this.seedQueuedJob(key);
    return reconcileCandidates(
      {
        db: this.db,
        jira: this.jira,
        config: this.config,
        decisionProvider: new RuleDecisionProvider(this.config.executionAgent),
        now: this.clock.now,
      },
      buildWorkerAvailability(this.db, this.config, this.clock.now()),
    );
  }

  reconcile() {
    return reconcileCandidates(
      {
        db: this.db,
        jira: this.jira,
        config: this.config,
        decisionProvider: new RuleDecisionProvider(this.config.executionAgent),
        now: this.clock.now,
      },
      [],
    );
  }

  /** An admin API call with the admin token (and an actor header, as the CLI sends). */
  adminCall(method: "GET" | "POST" | "PUT", url: string, body?: unknown) {
    return this.app.inject({
      method,
      url: `/api/v1/admin${url}`,
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        "x-ggjira-actor": "tester",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
  }

  post(url: string, body: unknown, token?: string) {
    return this.app.inject({
      method: "POST",
      url,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      payload: JSON.stringify(body),
    });
  }

  async pairingCode(workerId: string): Promise<string> {
    const response = await this.post("/api/v1/admin/pairing-codes", { workerId }, ADMIN_TOKEN);
    if (response.statusCode !== 201) throw new Error(`pairing failed: ${response.body}`);
    return (response.json() as { pairingCode: string }).pairingCode;
  }

  /** register → session → heartbeat, returning credentials a test can drive further calls with. */
  async connectWorker(workerId: string): Promise<RegisteredWorker> {
    const code = await this.pairingCode(workerId);
    const registered = await this.post("/api/v1/workers/register", {
      protocolVersion: PROTOCOL_VERSION,
      pairingCode: code,
      workerName: workerId,
    });
    const { workerToken } = registered.json() as { workerToken: string };
    const sessionId = await this.openSession(workerId, workerToken);
    await this.heartbeat(workerId, workerToken, sessionId);
    return { workerId, token: workerToken, sessionId };
  }

  async openSession(workerId: string, token: string): Promise<string> {
    const session = await this.post(
      "/api/v1/workers/session",
      { protocolVersion: PROTOCOL_VERSION, workerId },
      token,
    );
    return (session.json() as { sessionId: string }).sessionId;
  }

  heartbeat(workerId: string, token: string, sessionId: string) {
    return this.post(
      "/api/v1/workers/heartbeat",
      {
        sessionId,
        workerId,
        availability: { capabilities: ["programming"], repositoryIds: ["repo1"], busy: false },
      },
      token,
    );
  }

  next(worker: RegisteredWorker, requestId: string) {
    return this.post(
      "/api/v1/jobs/next",
      { sessionId: worker.sessionId, workerId: worker.workerId, requestId },
      worker.token,
    );
  }

  jobCall(
    worker: RegisteredWorker,
    jobId: string,
    action: "start" | "heartbeat" | "authorize",
    lease: { attemptId: string; leaseToken: string },
    extra: Record<string, unknown> = {},
  ) {
    return this.post(
      `/api/v1/jobs/${jobId}/${action}`,
      { sessionId: worker.sessionId, ...lease, ...extra },
      worker.token,
    );
  }
}
