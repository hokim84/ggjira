import type { JiraSecrets } from "../config.js";
import type { Logger } from "../logger.js";
import type { JiraGateway } from "./gateway.js";
import type { JiraIssue, JiraTransition, SearchIssuesOptions } from "./types.js";

export class JiraApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly endpoint: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "JiraApiError";
  }
}

export class TransitionNotFoundError extends Error {
  constructor(
    readonly issueKey: string,
    readonly requestedName: string,
    readonly availableNames: string[],
  ) {
    super(
      `Transition "${requestedName}" not found on ${issueKey}. ` +
        `Available transitions: ${availableNames.join(", ") || "(none)"}`,
    );
    this.name = "TransitionNotFoundError";
  }
}

interface RawJiraFields {
  summary?: string;
  description?: string | null;
  status?: { name?: string };
  labels?: string[];
}

interface RawJiraIssue {
  id: string;
  key: string;
  fields: RawJiraFields;
}

interface RawSearchResponse {
  issues: RawJiraIssue[];
  isLast: boolean;
  nextPageToken?: string;
}

interface RawTransitionsResponse {
  transitions: Array<{ id: string; name: string; to?: { name?: string } }>;
}

function mapRawIssue(raw: RawJiraIssue): JiraIssue {
  return {
    key: raw.key,
    id: raw.id,
    summary: raw.fields.summary ?? "",
    description: raw.fields.description ?? null,
    statusName: raw.fields.status?.name ?? "",
    labels: raw.fields.labels ?? [],
  };
}

const DEFAULT_FIELDS = ["summary", "description", "status", "labels"];

export class JiraClient implements JiraGateway {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly logger: Logger | undefined;

  constructor(secrets: JiraSecrets, opts?: { logger?: Logger }) {
    this.baseUrl = secrets.baseUrl.replace(/\/+$/, "");
    this.authHeader = `Basic ${Buffer.from(`${secrets.email}:${secrets.apiToken}`).toString("base64")}`;
    this.logger = opts?.logger;
  }

  private async request<T>(
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    this.logger?.debug({ layer: "jira", method, path }, "jira request");

    const res = await fetch(url, {
      method,
      headers: {
        Authorization: this.authHeader,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    if (!res.ok) {
      let parsedBody: unknown;
      try {
        parsedBody = await res.json();
      } catch {
        parsedBody = await res.text().catch(() => undefined);
      }
      const message =
        typeof parsedBody === "object" &&
        parsedBody !== null &&
        "errorMessages" in parsedBody &&
        Array.isArray((parsedBody as { errorMessages?: unknown }).errorMessages)
          ? (parsedBody as { errorMessages: string[] }).errorMessages.join("; ")
          : `Jira request failed with status ${res.status}`;
      throw new JiraApiError(message, res.status, path, parsedBody);
    }

    if (res.status === 204) {
      return undefined as T;
    }
    return (await res.json()) as T;
  }

  async searchIssues(jql: string, opts: SearchIssuesOptions = {}): Promise<JiraIssue[]> {
    const response = await this.request<RawSearchResponse>("POST", "/rest/api/2/search/jql", {
      jql,
      maxResults: opts.maxResults ?? 50,
      fields: opts.fields ?? DEFAULT_FIELDS,
    });
    return response.issues.map(mapRawIssue);
  }

  async getIssue(key: string, fields: string[] = DEFAULT_FIELDS): Promise<JiraIssue> {
    const raw = await this.request<RawJiraIssue>(
      "GET",
      `/rest/api/2/issue/${encodeURIComponent(key)}?fields=${fields.join(",")}`,
    );
    return mapRawIssue(raw);
  }

  async addComment(key: string, body: string): Promise<void> {
    await this.request<unknown>("POST", `/rest/api/2/issue/${encodeURIComponent(key)}/comment`, {
      body,
    });
  }

  async getTransitions(key: string): Promise<JiraTransition[]> {
    const response = await this.request<RawTransitionsResponse>(
      "GET",
      `/rest/api/2/issue/${encodeURIComponent(key)}/transitions`,
    );
    return response.transitions.map((t) => ({
      id: t.id,
      name: t.name,
      toStatusName: t.to?.name ?? "",
    }));
  }

  async transitionIssue(key: string, transitionName: string): Promise<void> {
    const transitions = await this.getTransitions(key);
    const match = transitions.find((t) => t.name === transitionName);
    if (!match) {
      throw new TransitionNotFoundError(
        key,
        transitionName,
        transitions.map((t) => t.name),
      );
    }
    await this.request<unknown>(
      "POST",
      `/rest/api/2/issue/${encodeURIComponent(key)}/transitions`,
      { transition: { id: match.id } },
    );
  }

  async addLabel(key: string, label: string): Promise<void> {
    await this.request<unknown>("PUT", `/rest/api/2/issue/${encodeURIComponent(key)}`, {
      update: { labels: [{ add: label }] },
    });
  }

  async removeLabel(key: string, label: string): Promise<void> {
    await this.request<unknown>("PUT", `/rest/api/2/issue/${encodeURIComponent(key)}`, {
      update: { labels: [{ remove: label }] },
    });
  }
}
