import type { z } from "zod";
import {
  type ApiErrorResponse,
  ApiErrorResponseSchema,
  type JobAuthorizeRequest,
  type JobAuthorizeResponse,
  JobAuthorizeResponseSchema,
  type JobHeartbeatRequest,
  type JobHeartbeatResponse,
  JobHeartbeatResponseSchema,
  type JobResultRequest,
  type JobResultResponse,
  JobResultResponseSchema,
  type JobStartRequest,
  type JobStartResponse,
  JobStartResponseSchema,
  type JobsNextRequest,
  type JobsNextResponse,
  JobsNextResponseSchema,
  type WorkerHeartbeatRequest,
  type WorkerHeartbeatResponse,
  WorkerHeartbeatResponseSchema,
  type WorkerRegisterRequest,
  type WorkerRegisterResponse,
  WorkerRegisterResponseSchema,
  type WorkerSessionRequest,
  type WorkerSessionResponse,
  WorkerSessionResponseSchema,
  type WorkerUsageReportRequest,
  type WorkerUsageReportResponse,
  WorkerUsageReportResponseSchema,
} from "../contracts/api.js";

/** A non-2xx answer from Router, with the `/api/v1` error body when there was one. */
export class RouterApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorResponse | undefined,
    path: string,
  ) {
    super(
      `Router ${path} answered ${status}${body ? ` (${body.error}: ${body.message ?? ""})` : ""}`,
    );
    this.name = "RouterApiError";
  }

  /** 409: stale/expired authority or conflicting result — retrying the same call won't help. */
  get isConflict(): boolean {
    return this.status === 409;
  }
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface RouterClientOptions {
  routerUrl: string;
  /** Absent only for `register`, which is how a worker gets its token in the first place. */
  workerToken?: string;
  fetch?: FetchLike;
}

/**
 * The worker's only network dependency: typed calls to Router's `/api/v1/*`. The worker never
 * talks to Jira (docs/router-service-implementation-plan.md "Worker Runtime").
 */
export class RouterClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: RouterClientOptions) {
    this.baseUrl = options.routerUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  /** `GET /health` — reachability only; opens no session, so it is safe while `worker run` is up. */
  async health(): Promise<boolean> {
    const response = await this.fetchImpl(`${this.baseUrl}/health`, { method: "GET" });
    return response.ok;
  }

  register(body: WorkerRegisterRequest): Promise<WorkerRegisterResponse> {
    return this.call("/api/v1/workers/register", body, WorkerRegisterResponseSchema);
  }

  openSession(body: WorkerSessionRequest): Promise<WorkerSessionResponse> {
    return this.call("/api/v1/workers/session", body, WorkerSessionResponseSchema);
  }

  heartbeat(body: WorkerHeartbeatRequest): Promise<WorkerHeartbeatResponse> {
    return this.call("/api/v1/workers/heartbeat", body, WorkerHeartbeatResponseSchema);
  }

  reportUsage(body: WorkerUsageReportRequest): Promise<WorkerUsageReportResponse> {
    return this.call("/api/v1/workers/usage", body, WorkerUsageReportResponseSchema);
  }

  /** `null` on 204 (the long poll ended with nothing to do). */
  next(body: JobsNextRequest): Promise<JobsNextResponse | null> {
    return this.call("/api/v1/jobs/next", body, JobsNextResponseSchema, { allowEmpty: true });
  }

  start(jobId: string, body: JobStartRequest): Promise<JobStartResponse> {
    return this.call(
      `/api/v1/jobs/${encodeURIComponent(jobId)}/start`,
      body,
      JobStartResponseSchema,
    );
  }

  jobHeartbeat(jobId: string, body: JobHeartbeatRequest): Promise<JobHeartbeatResponse> {
    return this.call(
      `/api/v1/jobs/${encodeURIComponent(jobId)}/heartbeat`,
      body,
      JobHeartbeatResponseSchema,
    );
  }

  authorize(jobId: string, body: JobAuthorizeRequest): Promise<JobAuthorizeResponse> {
    return this.call(
      `/api/v1/jobs/${encodeURIComponent(jobId)}/authorize`,
      body,
      JobAuthorizeResponseSchema,
    );
  }

  submitResult(body: JobResultRequest): Promise<JobResultResponse> {
    return this.call(
      `/api/v1/jobs/${encodeURIComponent(body.jobId)}/result`,
      body,
      JobResultResponseSchema,
    );
  }

  private call<S extends z.ZodTypeAny>(path: string, body: unknown, schema: S): Promise<z.infer<S>>;
  private call<S extends z.ZodTypeAny>(
    path: string,
    body: unknown,
    schema: S,
    opts: { allowEmpty: true },
  ): Promise<z.infer<S> | null>;
  private async call<S extends z.ZodTypeAny>(
    path: string,
    body: unknown,
    schema: S,
    opts: { allowEmpty?: boolean } = {},
  ): Promise<z.infer<S> | null> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.options.workerToken) headers.authorization = `Bearer ${this.options.workerToken}`;

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (response.status === 204 && opts.allowEmpty) return null;
    const text = await response.text();
    let json: unknown;
    try {
      json = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      // A proxy error page, say. Leave it undefined: the status code alone decides below.
      json = undefined;
    }
    if (!response.ok) {
      const parsedError = ApiErrorResponseSchema.safeParse(json);
      throw new RouterApiError(
        response.status,
        parsedError.success ? parsedError.data : undefined,
        path,
      );
    }
    return schema.parse(json);
  }
}
