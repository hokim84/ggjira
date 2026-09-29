import { z } from "zod";
import { JobEnvelopeSchema, JobResultSchema } from "./envelope.js";
import { PROTOCOL_VERSION } from "./protocol.js";

/**
 * Request/response shapes for the worker-facing `/api/v1/*` HTTP contract
 * (docs/router-service-implementation-plan.md §3 "공개 HTTP 인터페이스"). Implemented by
 * `src/router/server.ts` + `src/router/worker-service.ts` and consumed by
 * `src/worker-runtime/client.ts`.
 *
 * Every request except `workers/register` carries `Authorization: Bearer <workerToken>`;
 * that header — not any body field — is what identifies the worker. Body `workerId` /
 * `sessionId` fields must agree with it (§3 "모든 변경 요청은 워커 identity·session·
 * attempt·lease를 함께 검증한다").
 */

/** Header a worker sends its token in. */
export const WORKER_AUTH_HEADER = "authorization";

export const WorkerRegisterRequestSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  pairingCode: z.string().min(1),
  workerName: z.string().min(1),
});
export type WorkerRegisterRequest = z.infer<typeof WorkerRegisterRequestSchema>;

/**
 * A git remote a worker may clone: `https://`, `ssh://`, `file://` or scp-like `user@host:path`.
 * Anything else — options (`-…`), `ext::` and other transport helpers, whitespace — is refused on
 * both sides, since the worker passes it to `git clone` (ADR 0025).
 */
export const CloneUrlSchema = z
  .string()
  .min(1)
  .refine(
    (url) =>
      !/\s/.test(url) &&
      !url.startsWith("-") &&
      (/^(https|ssh|file):\/\/[^\s]+$/.test(url) || /^[\w.-]+@[\w.-]+:[^:\s][^\s]*$/.test(url)),
    { message: "cloneUrl must be an https://, ssh://, file:// or user@host:path git URL" },
  );

/** What Router's policy for this worker says, so `worker start` can write its config without the
 *  operator typing capabilities or repositories (ADR 0025). Local paths stay the worker's choice. */
export const WorkerProfileSchema = z.object({
  capabilities: z.array(z.string().min(1)),
  providerId: z.string().min(1),
  repositories: z.array(
    z.object({
      id: z.string().min(1),
      cloneUrl: CloneUrlSchema.optional(),
      baseBranch: z.string().min(1).optional(),
    }),
  ),
});
export type WorkerProfile = z.infer<typeof WorkerProfileSchema>;

export const WorkerRegisterResponseSchema = z.object({
  workerId: z.string().min(1),
  workerToken: z.string().min(1),
  profile: WorkerProfileSchema.optional(),
});
export type WorkerRegisterResponse = z.infer<typeof WorkerRegisterResponseSchema>;

export const WorkerSessionRequestSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  workerId: z.string().min(1),
  /** Where each configured repository lives on the worker machine, for the admin workers view
   *  only — Router never uses a path to decide or run anything. Optional: older workers omit it. */
  repositories: z
    .array(z.object({ id: z.string().min(1), path: z.string().min(1).max(1024) }))
    .max(200)
    .optional(),
});
export type WorkerSessionRequest = z.infer<typeof WorkerSessionRequestSchema>;

const PendingAttemptSchema = z.object({
  jobId: z.string().min(1),
  attemptId: z.string().min(1),
  state: z.string().min(1),
});

export const WorkerSessionResponseSchema = z.object({
  sessionId: z.string().min(1),
  /** Attempts this worker held a lease on before the connection dropped, so it can
   *  reconcile in-flight work instead of silently dropping it (§3 "미확정 작업 확인"). */
  pendingAttempts: z.array(PendingAttemptSchema).default([]),
});
export type WorkerSessionResponse = z.infer<typeof WorkerSessionResponseSchema>;

export const WorkerHeartbeatRequestSchema = z.object({
  sessionId: z.string().min(1),
  workerId: z.string().min(1),
  availability: z.object({
    capabilities: z.array(z.string().min(1)).default([]),
    repositoryIds: z.array(z.string().min(1)).default([]),
    busy: z.boolean(),
  }),
});
export type WorkerHeartbeatRequest = z.infer<typeof WorkerHeartbeatRequestSchema>;

export const WorkerHeartbeatResponseSchema = z.object({
  /** attemptIds Router wants this worker to stop, surfaced through the general heartbeat
   *  rather than only the per-job heartbeat so a worker between jobs still hears about it. */
  cancelAttemptIds: z.array(z.string().min(1)).default([]),
});
export type WorkerHeartbeatResponse = z.infer<typeof WorkerHeartbeatResponseSchema>;

/** One quota window of a provider's plan: Claude Code's 5-hour/weekly limits, Codex's
 *  primary/secondary windows. `id` is `five_hour`/`seven_day` when the window matches one of
 *  those, otherwise what the CLI called it. */
export const ProviderUsageWindowSchema = z.object({
  id: z.string().min(1),
  usedPercent: z.number().min(0),
  resetsAt: z.string().optional(),
  windowMinutes: z.number().int().positive().optional(),
});
export type ProviderUsageWindow = z.infer<typeof ProviderUsageWindowSchema>;

/** What a worker last saw of one provider's plan usage (ADR 0028). Read on connect (`probe`) and
 *  after each job (`job`) — never on a timer. */
export const ProviderUsageSchema = z.object({
  providerId: z.string().min(1),
  providerType: z.enum(["claude-code", "codex"]),
  observedAt: z.string(),
  source: z.enum(["probe", "job"]),
  /** Claude Code's `allowed` / `allowed_warning` / `rejected`. */
  status: z.string().optional(),
  planType: z.string().optional(),
  windows: z.array(ProviderUsageWindowSchema).default([]),
  /** Why no windows could be read (probe failed, CLI not logged in, ...). */
  error: z.string().optional(),
});
export type ProviderUsage = z.infer<typeof ProviderUsageSchema>;

export const WorkerUsageReportRequestSchema = z.object({
  sessionId: z.string().min(1),
  workerId: z.string().min(1),
  usage: z.array(ProviderUsageSchema).min(1),
});
export type WorkerUsageReportRequest = z.infer<typeof WorkerUsageReportRequestSchema>;

export const WorkerUsageReportResponseSchema = z.object({ accepted: z.boolean() });
export type WorkerUsageReportResponse = z.infer<typeof WorkerUsageReportResponseSchema>;

export const JobsNextRequestSchema = z.object({
  sessionId: z.string().min(1),
  workerId: z.string().min(1),
  /** Repeating an already-served requestId returns the same reservation instead of leasing a
   *  new job (§3 "응답 유실 후 동일 요청을 재전송하면 동일 예약을 반환한다"). */
  requestId: z.string().min(1),
});
export type JobsNextRequest = z.infer<typeof JobsNextRequestSchema>;

/** 204 (no body) when nothing was available within the long-poll window. */
export const JobsNextResponseSchema = JobEnvelopeSchema;
export type JobsNextResponse = z.infer<typeof JobsNextResponseSchema>;

/** Common body of every `jobs/{id}/*` call: the attempt + lease being acted on, and the session
 *  it's being acted on from (a superseded session can no longer drive the attempt). */
const AttemptLeaseFields = {
  sessionId: z.string().min(1),
  attemptId: z.string().min(1),
  leaseToken: z.string().min(1),
};

export const JobStartRequestSchema = z.object(AttemptLeaseFields);
export type JobStartRequest = z.infer<typeof JobStartRequestSchema>;

export const JobStartResponseSchema = z.object({
  granted: z.boolean(),
  leaseExpiresAt: z.string(),
});
export type JobStartResponse = z.infer<typeof JobStartResponseSchema>;

export const JobHeartbeatRequestSchema = z.object(AttemptLeaseFields);
export type JobHeartbeatRequest = z.infer<typeof JobHeartbeatRequestSchema>;

export const JobHeartbeatResponseSchema = z.object({
  cancel: z.boolean(),
  leaseExpiresAt: z.string(),
});
export type JobHeartbeatResponse = z.infer<typeof JobHeartbeatResponseSchema>;

export const JobAuthorizeRequestSchema = z.object({
  ...AttemptLeaseFields,
  /** What the worker is about to do — Router re-checks approval right before each
   *  (§3 "커밋·검증 직전 실행 권한 재확인"; `push` since ADR 0026). */
  stage: z.enum(["commit", "validate", "push"]),
});
export type JobAuthorizeRequest = z.infer<typeof JobAuthorizeRequestSchema>;

export const JobAuthorizeResponseSchema = z.object({
  authorized: z.boolean(),
  reason: z.string().optional(),
});
export type JobAuthorizeResponse = z.infer<typeof JobAuthorizeResponseSchema>;

export const JobResultRequestSchema = JobResultSchema;
export type JobResultRequest = z.infer<typeof JobResultRequestSchema>;

export const JobResultResponseSchema = z.object({
  accepted: z.boolean(),
  /** `false` when the result was kept only as an audit record — it arrived after its attempt
   *  was no longer current (lease expired, recovery_required, superseded) and so did not move
   *  the job (§3 "늦게 도착한 결과는 감사 자료로 보존할 수 있지만 완료 처리... 에 적용하지 않는다"). */
  applied: z.boolean(),
});
export type JobResultResponse = z.infer<typeof JobResultResponseSchema>;

/** Body of every non-2xx `/api/v1/*` response. */
export const ApiErrorResponseSchema = z.object({
  error: z.string().min(1),
  message: z.string().optional(),
  /** Set on `426` protocol mismatches so the worker can report what Router speaks. */
  supportedProtocolVersion: z.number().int().optional(),
  /** Field-level validation problems (admin config updates). */
  issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;

/** `POST /api/v1/admin/workers` — declares a worker policy in Router config, applies it and
 *  issues its first pairing code in one step (ADR 0025). */
export const AdminAddWorkerRequestSchema = z.object({
  workerId: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "use letters, digits, '.', '_' or '-' (max 64)"),
  allowedCapabilities: z.array(z.string().min(1)).default([]),
  allowedRepositoryIds: z.array(z.string().min(1)).min(1),
  providerId: z.string().min(1).optional(),
});
export type AdminAddWorkerRequest = z.infer<typeof AdminAddWorkerRequestSchema>;

/** `PUT /api/v1/admin/secrets/jev` — sets (string) or removes (null) the Jev API key in the
 *  Router's secrets file and applies it at once (ADR 0031). The key is never returned. Its format
 *  is checked by the Router (`JevApiKeySchema`). */
export const AdminJevKeyRequestSchema = z.object({ apiKey: z.string().nullable() });

/** `POST /api/v1/admin/jira/project` — the project's statuses and subtask issue types, for the
 *  web UI's status and issue-type pickers. */
export const AdminJiraProjectRequestSchema = z.object({ projectKey: z.string().min(1) });

/** `POST /api/v1/admin/jira/workflow-check` — checks an (unsaved) status mapping against the
 *  project's real transitions. */
export const AdminWorkflowCheckRequestSchema = z.object({
  projectKey: z.string().min(1),
  workflow: z.object({
    requestStatus: z.string().min(1),
    inProgressStatus: z.string().min(1),
    reviewStatus: z.string().min(1),
    planningStatus: z.string().min(1).optional(),
    needsDecisionStatus: z.string().min(1).optional(),
    doneStatus: z.string().min(1).optional(),
  }),
});

/** `POST /api/v1/admin/pairing-codes` — admin-token authenticated. The code is bound to a
 *  `workerId` already declared in Router config's `workers[]` policy list. */
export const AdminCreatePairingCodeRequestSchema = z.object({
  workerId: z.string().min(1),
});
export type AdminCreatePairingCodeRequest = z.infer<typeof AdminCreatePairingCodeRequestSchema>;

export const AdminCreatePairingCodeResponseSchema = z.object({
  pairingCode: z.string().min(1),
  workerId: z.string().min(1),
  expiresAt: z.string(),
});
export type AdminCreatePairingCodeResponse = z.infer<typeof AdminCreatePairingCodeResponseSchema>;
