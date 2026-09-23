import type { FetchLike } from "../worker-runtime/client.js";

/** A non-2xx answer from `/api/v1/admin/*`. */
export class AdminClientError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    readonly endpoint: string,
  ) {
    const detail =
      body && typeof body === "object" && "message" in body
        ? String((body as { message?: unknown }).message)
        : "";
    super(`Router ${endpoint} answered ${status}${detail ? `: ${detail}` : ""}`);
    this.name = "AdminClientError";
  }
}

/**
 * What `ggjira router <workers|jobs|reports|reconcile|backup|status>` uses to talk to a running
 * Router. Admin commands always go through the HTTP API with the admin token, never through the
 * database file (docs/router-service-implementation-plan.md §4 "관리 CLI").
 */
export class AdminClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly opts: {
      routerUrl: string;
      adminToken: string;
      actor?: string;
      fetch?: FetchLike;
    },
  ) {
    this.baseUrl = opts.routerUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  get<T = unknown>(endpoint: string, query: Record<string, string | undefined> = {}): Promise<T> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, value);
    }
    const qs = params.toString();
    return this.request<T>("GET", `${endpoint}${qs ? `?${qs}` : ""}`);
  }

  post<T = unknown>(endpoint: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", endpoint, body ?? {});
  }

  private async request<T>(method: "GET" | "POST", endpoint: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.opts.adminToken}` };
    if (this.opts.actor) headers["x-ggjira-actor"] = this.opts.actor;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await this.fetchImpl(`${this.baseUrl}/api/v1/admin${endpoint}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }
    if (!response.ok) throw new AdminClientError(response.status, parsed, endpoint);
    return parsed as T;
  }
}
