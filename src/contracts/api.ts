import { z } from "zod";
import { JobEnvelopeSchema, JobResultSchema } from "./envelope.js";
import { PROTOCOL_VERSION } from "./protocol.js";

/**
 * Request/response shapes for the worker-facing `/api/v1/*` HTTP contract
 * (docs/router-service-implementation-plan.md §3 "공개 HTTP 인터페이스"). These are the
 * wire types only — the Fastify routes and the SQLite-backed handlers that
 * implement them are a later phase.
 */

export const WorkerRegisterRequestSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  pairingCode: z.string().min(1),
  workerName: z.string().min(1),
  capabilities: z.array(z.string().min(1)).default([]),
});
export type WorkerRegisterRequest = z.infer<typeof WorkerRegisterRequestSchema>;

export const WorkerRegisterResponseSchema = z.object({
  workerId: z.string().min(1),
  workerToken: z.string().min(1),
});
export type WorkerRegisterResponse = z.infer<typeof WorkerRegisterResponseSchema>;

export const WorkerSessionRequestSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  workerId: z.string().min(1),
  workerToken: z.string().min(1),
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

export const JobStartRequestSchema = z.object({
  attemptId: z.string().min(1),
  leaseToken: z.string().min(1),
});
export type JobStartRequest = z.infer<typeof JobStartRequestSchema>;

export const JobStartResponseSchema = z.object({
  granted: z.boolean(),
  leaseExpiresAt: z.string(),
});
export type JobStartResponse = z.infer<typeof JobStartResponseSchema>;

export const JobHeartbeatRequestSchema = z.object({
  attemptId: z.string().min(1),
  leaseToken: z.string().min(1),
});
export type JobHeartbeatRequest = z.infer<typeof JobHeartbeatRequestSchema>;

export const JobHeartbeatResponseSchema = z.object({
  cancel: z.boolean(),
  leaseExpiresAt: z.string(),
});
export type JobHeartbeatResponse = z.infer<typeof JobHeartbeatResponseSchema>;

export const JobAuthorizeRequestSchema = z.object({
  attemptId: z.string().min(1),
  leaseToken: z.string().min(1),
  /** What the worker is about to do — Router re-checks approval right before either
   *  (§3 "커밋·검증 직전 실행 권한 재확인"). */
  stage: z.enum(["commit", "validate"]),
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
});
export type JobResultResponse = z.infer<typeof JobResultResponseSchema>;
