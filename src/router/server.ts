import { timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { z } from "zod";
import {
  AdminAddWorkerRequestSchema,
  AdminCreatePairingCodeRequestSchema,
  AdminJiraProjectRequestSchema,
  AdminWorkflowCheckRequestSchema,
  AdminJevKeyRequestSchema,
  type ApiErrorResponse,
  JobAuthorizeRequestSchema,
  JobHeartbeatRequestSchema,
  JobResultRequestSchema,
  JobStartRequestSchema,
  JobsNextRequestSchema,
  WorkerHeartbeatRequestSchema,
  WorkerRegisterRequestSchema,
  WorkerSessionRequestSchema,
  WorkerUsageReportRequestSchema,
} from "../contracts/api.js";
import { JOB_STATES } from "../contracts/job-state.js";
import { PROTOCOL_VERSION } from "../contracts/protocol.js";
import { AdminError, type AdminService } from "./admin-service.js";
import { RecoveryError } from "./recovery.js";
import { ingestJiraWebhookEvent, verifyJiraWebhookSignature } from "./webhook.js";
import {
  type PullRequestClosed,
  type PullRequestOutcome,
  parsePullRequestClosed,
  verifyGithubSignature,
} from "./github.js";
import { recordGithubDelivery } from "./db/pull-requests.js";
import { registerWebUi } from "./web-ui.js";
import { WorkerApiError, type WorkerService } from "./worker-service.js";

const SIGNATURE_HEADER = "x-hub-signature";
const DELIVERY_ID_HEADER = "x-atlassian-webhook-identifier";

export interface RouterServerDeps {
  db: Database.Database;
  webhookSecret: string;
  /** Identifies the single Jira site this Router instance serves
   *  (docs/router-service-implementation-plan.md §3 "첫 버전은 Jira 사이트 하나를 지원"),
   *  paired with the delivery id for dedup rather than trusted from the webhook payload. */
  siteId: string;
  now?: () => string;
  /** Enables the `/api/v1/*` worker routes. */
  workerService?: WorkerService;
  /** Bearer token for `/api/v1/admin/*`. Admin routes are not registered without it. */
  adminToken?: string;
  /** Enables the admin routes beyond pairing codes (workers, jobs, reports, sync, backup). */
  adminService?: AdminService;
  /** Where the web UI's static files live; defaults to the repo's `web/router-ui/`. */
  webUiRoot?: string;
  /** Enables `/webhooks/github` (ADR 0027). */
  github?: {
    webhookSecret: string;
    onPullRequestClosed: (event: PullRequestClosed) => PullRequestOutcome;
  };
}

interface ParsedBody {
  raw: Buffer;
  parsed: unknown;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function bearerToken(request: FastifyRequest): string | undefined {
  const header = headerValue(request.headers.authorization);
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

export function tokensEqual(presented: string | undefined, expected: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented, "utf-8");
  const b = Buffer.from(expected, "utf-8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function sendError(reply: FastifyReply, status: number, body: ApiErrorResponse): FastifyReply {
  return reply.code(status).send(body);
}

/** Parses the body with `schema`, answering 426 for a protocol version mismatch (checked first,
 *  so an incompatible worker gets an explicit compatibility error rather than a schema error —
 *  §3 "버전 불일치는 실행 전에 명시적인 호환 오류로 처리한다") and 400 for anything else. */
function parseBody<S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const parsed = (body as ParsedBody | undefined)?.parsed;
  const version = (parsed as { protocolVersion?: unknown } | null | undefined)?.protocolVersion;
  if (version !== undefined && version !== PROTOCOL_VERSION) {
    throw new WorkerApiError(
      426,
      "protocol_mismatch",
      `protocol version ${String(version)} is not supported`,
    );
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw new WorkerApiError(400, "invalid_request", result.error.message);
  return result.data;
}

/**
 * Router's Fastify app: signature-verified webhook ingestion and a liveness probe (stage 2), plus
 * the worker-facing `/api/v1/*` routes and the one admin route stage 3 needs (pairing codes).
 * The routes are thin: every decision lives in `WorkerService`.
 */
export function buildRouterServer(deps: RouterServerDeps): FastifyInstance {
  const now = deps.now ?? (() => new Date().toISOString());
  const app = Fastify();

  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) => {
    const buffer = body as Buffer;
    try {
      const parsed = buffer.length > 0 ? JSON.parse(buffer.toString("utf-8")) : {};
      done(null, { raw: buffer, parsed });
    } catch (error) {
      done(error as Error, undefined);
    }
  });

  app.get("/health", async () => ({ status: "ok", mode: "router" }));
  registerWebUi(app, deps.webUiRoot);

  app.post("/webhooks/jira", async (request, reply) => {
    const { raw, parsed } = request.body as ParsedBody;
    const signature = headerValue(request.headers[SIGNATURE_HEADER]);
    if (!verifyJiraWebhookSignature(raw, signature, deps.webhookSecret)) {
      return reply.code(401).send({ error: "invalid signature" });
    }

    const webhookDeliveryId = headerValue(request.headers[DELIVERY_ID_HEADER]);
    if (!webhookDeliveryId) {
      return reply.code(400).send({ error: `missing ${DELIVERY_ID_HEADER} header` });
    }

    const result = ingestJiraWebhookEvent(deps.db, {
      siteId: deps.siteId,
      webhookDeliveryId,
      payload: parsed,
      now: now(),
    });
    return reply.code(202).send({ status: result });
  });

  const github = deps.github;
  if (github) {
    app.post("/webhooks/github", async (request, reply) => {
      const { raw, parsed } = request.body as ParsedBody;
      const signature = headerValue(request.headers["x-hub-signature-256"]);
      if (!verifyGithubSignature(raw, signature, github.webhookSecret)) {
        return reply.code(401).send({ error: "invalid signature" });
      }
      const event = headerValue(request.headers["x-github-event"]) ?? "";
      if (event === "ping") return reply.code(200).send({ status: "pong" });
      const deliveryId = headerValue(request.headers["x-github-delivery"]);
      if (!deliveryId) return reply.code(400).send({ error: "missing x-github-delivery header" });
      if (!recordGithubDelivery(deps.db, { id: deliveryId, event, now: now() })) {
        return reply.code(202).send({ status: "duplicate" });
      }
      const closed = parsePullRequestClosed(event, parsed);
      if (!closed) return reply.code(202).send({ status: "ignored" });
      return reply.code(202).send({ status: github.onPullRequestClosed(closed) });
    });
  }

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AdminError) {
      return sendError(reply, error.status, {
        error: error.code,
        message: error.message,
        ...(error.issues ? { issues: error.issues } : {}),
      });
    }
    if (error instanceof RecoveryError) {
      const status = error.code === "unknown_job" || error.code === "unknown_batch" ? 404 : 409;
      return sendError(reply, status, { error: error.code, message: error.message });
    }
    if (error instanceof WorkerApiError) {
      return sendError(reply, error.status, {
        error: error.code,
        message: error.message,
        ...(error.status === 426 ? { supportedProtocolVersion: PROTOCOL_VERSION } : {}),
      });
    }
    const { statusCode: status, message } = error as { statusCode?: number; message?: string };
    if (status && status >= 400 && status < 500) {
      return sendError(reply, status, {
        error: "invalid_request",
        ...(message ? { message } : {}),
      });
    }
    return sendError(reply, 500, { error: "internal_error" });
  });

  const service = deps.workerService;
  if (service) registerWorkerRoutes(app, service);
  if (deps.adminToken && (service || deps.adminService)) {
    registerAdminRoutes(app, deps.adminToken, service, deps.adminService);
  }

  return app;
}

function registerWorkerRoutes(app: FastifyInstance, service: WorkerService): void {
  const worker = (request: FastifyRequest) => service.authenticate(bearerToken(request));

  app.post("/api/v1/workers/register", async (request) =>
    service.register(parseBody(WorkerRegisterRequestSchema, request.body)),
  );

  app.post("/api/v1/workers/session", async (request) =>
    service.openSession(worker(request), parseBody(WorkerSessionRequestSchema, request.body)),
  );

  app.post("/api/v1/workers/heartbeat", async (request) =>
    service.heartbeat(worker(request), parseBody(WorkerHeartbeatRequestSchema, request.body)),
  );

  app.post("/api/v1/workers/usage", async (request) =>
    service.reportUsage(worker(request), parseBody(WorkerUsageReportRequestSchema, request.body)),
  );

  app.post("/api/v1/jobs/next", async (request, reply) => {
    const envelope = await service.nextJob(
      worker(request),
      parseBody(JobsNextRequestSchema, request.body),
    );
    if (!envelope) return reply.code(204).send();
    return envelope;
  });

  app.post<{ Params: { id: string } }>("/api/v1/jobs/:id/start", async (request) =>
    service.start(
      worker(request),
      request.params.id,
      parseBody(JobStartRequestSchema, request.body),
    ),
  );

  app.post<{ Params: { id: string } }>("/api/v1/jobs/:id/heartbeat", async (request) =>
    service.jobHeartbeat(
      worker(request),
      request.params.id,
      parseBody(JobHeartbeatRequestSchema, request.body),
    ),
  );

  app.post<{ Params: { id: string } }>("/api/v1/jobs/:id/authorize", async (request) =>
    service.authorize(
      worker(request),
      request.params.id,
      parseBody(JobAuthorizeRequestSchema, request.body),
    ),
  );

  app.post<{ Params: { id: string } }>("/api/v1/jobs/:id/result", async (request) =>
    service.submitResult(
      worker(request),
      request.params.id,
      parseBody(JobResultRequestSchema, request.body),
    ),
  );
}

const ACTOR_HEADER = "x-ggjira-actor";
const JOB_STATE_SET: ReadonlySet<string> = new Set(JOB_STATES);

/** Who an admin call acts as, for `audit_log`: the CLI sends the OS user name. */
function actorOf(request: FastifyRequest): string {
  const actor = headerValue(request.headers[ACTOR_HEADER])?.trim();
  return actor ? `admin:${actor.slice(0, 100)}` : "admin";
}

/** `/api/v1/admin/*` (§4 "관리자 API는 /api/v1/admin 아래에서 워커·작업·보고·동기화·백업 기능을
 *  제공한다"), all behind the admin bearer token. */
function registerAdminRoutes(
  app: FastifyInstance,
  adminToken: string,
  service: WorkerService | undefined,
  admin: AdminService | undefined,
): void {
  app.register(
    async (scope) => {
      scope.addHook("onRequest", async (request, reply) => {
        if (!tokensEqual(bearerToken(request), adminToken)) {
          return sendError(reply, 401, {
            error: "unauthenticated",
            message: "admin token required",
          });
        }
      });

      if (service) {
        scope.post("/pairing-codes", async (request, reply) => {
          const body = parseBody(AdminCreatePairingCodeRequestSchema, request.body);
          return reply.code(201).send(service.createPairingCode(body.workerId));
        });
      }
      if (!admin) return;

      type IdParams = { Params: { id: string } };
      scope.get("/status", async () => admin.status());

      scope.get("/workers", async () => ({ workers: admin.listWorkers() }));
      scope.post("/workers", async (request, reply) =>
        reply
          .code(201)
          .send(
            await admin.addWorker(
              parseBody(AdminAddWorkerRequestSchema, request.body),
              actorOf(request),
            ),
          ),
      );
      scope.post<IdParams>("/workers/:id/disable", async (request) =>
        admin.setWorkerEnabled(request.params.id, false, actorOf(request)),
      );
      scope.post<IdParams>("/workers/:id/enable", async (request) =>
        admin.setWorkerEnabled(request.params.id, true, actorOf(request)),
      );
      scope.post<IdParams>("/workers/:id/revoke", async (request) =>
        admin.revokeWorker(request.params.id, actorOf(request)),
      );

      scope.get<{ Querystring: { state?: string; limit?: string; cursor?: string } }>(
        "/jobs",
        async (request) => {
          const { state, limit, cursor } = request.query;
          if (state !== undefined && !JOB_STATE_SET.has(state)) {
            throw new AdminError(400, "invalid_request", `unknown job state "${state}"`);
          }
          const parsedLimit = limit === undefined ? undefined : Number(limit);
          if (parsedLimit !== undefined && !Number.isInteger(parsedLimit)) {
            throw new AdminError(400, "invalid_request", "limit must be an integer");
          }
          return admin.listJobs({
            ...(state ? { state: state as (typeof JOB_STATES)[number] } : {}),
            ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
            ...(cursor ? { cursor } : {}),
          });
        },
      );
      scope.put("/secrets/jev", async (request) =>
        admin.setJevApiKey(
          parseBody(AdminJevKeyRequestSchema, request.body).apiKey,
          actorOf(request),
        ),
      );
      scope.get<IdParams>("/jobs/:id", async (request) => admin.showJob(request.params.id));
      scope.post<IdParams>("/jobs/:id/cancel", async (request) =>
        admin.cancelJob(request.params.id, actorOf(request)),
      );
      scope.post<IdParams>("/jobs/:id/retry", async (request) =>
        admin.retryJob(request.params.id, actorOf(request)),
      );
      scope.post<IdParams>("/jobs/:id/resolve", async (request) =>
        admin.resolveJob(request.params.id, actorOf(request)),
      );

      scope.get("/reports", async () => ({ batches: admin.listBlockedReports() }));
      scope.post<IdParams>("/reports/:id/retry", async (request) =>
        admin.retryReportBatch(request.params.id, actorOf(request)),
      );

      scope.get("/config", async () => admin.readConfig());
      scope.put("/config", async (request) =>
        admin.updateConfig((request.body as ParsedBody | undefined)?.parsed, actorOf(request)),
      );
      scope.post("/config/apply", async (request) => admin.applyConfigFile(actorOf(request)));
      scope.post("/jira/project", async (request) =>
        admin.jiraProject(parseBody(AdminJiraProjectRequestSchema, request.body).projectKey),
      );
      scope.post("/jira/workflow-check", async (request) => {
        const body = parseBody(AdminWorkflowCheckRequestSchema, request.body);
        return admin.checkWorkflow(body.projectKey, {
          requestStatus: body.workflow.requestStatus,
          inProgressStatus: body.workflow.inProgressStatus,
          reviewStatus: body.workflow.reviewStatus,
          ...(body.workflow.planningStatus ? { planningStatus: body.workflow.planningStatus } : {}),
          ...(body.workflow.needsDecisionStatus
            ? { needsDecisionStatus: body.workflow.needsDecisionStatus }
            : {}),
          ...(body.workflow.doneStatus ? { doneStatus: body.workflow.doneStatus } : {}),
        });
      });
      scope.post<{ Body: ParsedBody | undefined }>("/check", async (request) => {
        const issueKey = (request.body?.parsed as { issueKey?: unknown } | undefined)?.issueKey;
        return admin.check(typeof issueKey === "string" && issueKey ? issueKey : undefined);
      });

      scope.post("/reconcile", async (request) => admin.reconcile(actorOf(request)));
      scope.post("/backup", async (request) => admin.backup(actorOf(request)));
    },
    { prefix: "/api/v1/admin" },
  );
}
