import type { JiraSecrets } from "../config.js";
import type { Logger } from "../logger.js";
import type { JiraGateway } from "./gateway.js";
import { withRetry } from "./retry.js";
import type {
  CreateIssueInput,
  JiraComment,
  JiraIssue,
  JiraProject,
  JiraProjectSummary,
  JiraTransition,
  JiraUser,
  SearchIssuesOptions,
} from "./types.js";

export class JiraApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly endpoint: string,
    readonly body?: unknown,
    /** Parsed from a `Retry-After` response header, when present (ms). */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "JiraApiError";
  }
}

const MAX_RETRY_AFTER_MS = 30_000;

/** Parses a `Retry-After` header (seconds, or an HTTP-date) into milliseconds. */
export function parseRetryAfterMs(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds)) {
    return Math.min(Math.max(seconds, 0) * 1000, MAX_RETRY_AFTER_MS);
  }
  const dateMs = Date.parse(headerValue);
  if (Number.isNaN(dateMs)) return undefined;
  return Math.min(Math.max(dateMs - Date.now(), 0), MAX_RETRY_AFTER_MS);
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

/**
 * No transition leads from the issue's current status to the configured
 * target status. Names the statuses (what a human sees on the board), not
 * the transition labels, because that is what setup asks for.
 */
export class StatusNotReachableError extends Error {
  constructor(
    readonly issueKey: string,
    readonly targetStatus: string,
    readonly currentStatus: string,
    readonly reachableStatuses: string[],
  ) {
    super(
      `${issueKey} cannot move to "${targetStatus}" from its current status "${currentStatus}". ` +
        `Reachable statuses from here: ${reachableStatuses.join(", ") || "(none)"}`,
    );
    this.name = "StatusNotReachableError";
  }
}

interface RawJiraFields {
  [fieldId: string]: unknown;
  summary?: string;
  description?: string | null;
  status?: { name?: string };
  labels?: string[];
  assignee?: { accountId?: string } | null;
  issuetype?: { name?: string };
  parent?: { key?: string };
  project?: { key?: string };
  updated?: string;
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

interface RawUser {
  accountId: string;
  displayName?: string;
  emailAddress?: string;
}

interface RawComment {
  id: string;
  author?: { accountId?: string; displayName?: string };
  body?: string;
  created: string;
}

interface RawCommentsResponse {
  comments: RawComment[];
}

interface RawCreateIssueResponse {
  key: string;
}

interface RawProjectSearchResponse {
  values: Array<{ key: string; name: string }>;
}

interface RawProject {
  key: string;
  name: string;
  issueTypes?: Array<{ name: string; subtask?: boolean }>;
}

interface RawIssuePropertyResponse {
  key: string;
  value: unknown;
}

function selectedOptionId(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("id" in value)) return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}

function mapRawIssue(raw: RawJiraIssue, executionAgentFieldId?: string): JiraIssue {
  return {
    key: raw.key,
    id: raw.id,
    summary: raw.fields.summary ?? "",
    description: raw.fields.description ?? null,
    statusName: raw.fields.status?.name ?? "",
    labels: raw.fields.labels ?? [],
    assigneeAccountId: raw.fields.assignee?.accountId ?? null,
    issueTypeName: raw.fields.issuetype?.name ?? null,
    parentKey: raw.fields.parent?.key ?? null,
    projectKey: raw.fields.project?.key ?? null,
    ...(executionAgentFieldId
      ? { executionAgentOptionId: selectedOptionId(raw.fields[executionAgentFieldId]) }
      : {}),
    ...(raw.fields.updated ? { updatedAt: raw.fields.updated } : {}),
  };
}

function mapRawUser(raw: RawUser): JiraUser {
  return {
    accountId: raw.accountId,
    displayName: raw.displayName ?? "",
    emailAddress: raw.emailAddress ?? null,
  };
}

function mapRawComment(raw: RawComment): JiraComment {
  return {
    id: raw.id,
    authorAccountId: raw.author?.accountId ?? null,
    authorDisplayName: raw.author?.displayName ?? null,
    body: raw.body ?? "",
    created: raw.created,
  };
}

const DEFAULT_FIELDS = [
  "summary",
  "description",
  "status",
  "labels",
  "assignee",
  "issuetype",
  "parent",
  "project",
  "updated",
];

/** Transient failures worth retrying: 429 (rate limited), 5xx, and network-level errors. */
function isTransientJiraError(error: unknown): boolean {
  if (error instanceof JiraApiError) return error.status === 429 || error.status >= 500;
  return error instanceof TypeError; // fetch's network-failure shape
}

/** Honors a 429's Retry-After header instead of the default exponential backoff. */
function jiraRetryDelayMs(error: unknown): number | undefined {
  return error instanceof JiraApiError ? error.retryAfterMs : undefined;
}

export class JiraClient implements JiraGateway {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly logger: Logger | undefined;
  private readonly executionAgentFieldId: string | undefined;

  constructor(secrets: JiraSecrets, opts?: { logger?: Logger; executionAgentFieldId?: string }) {
    this.baseUrl = secrets.baseUrl.replace(/\/+$/, "");
    this.authHeader = `Basic ${Buffer.from(`${secrets.email}:${secrets.apiToken}`).toString("base64")}`;
    this.logger = opts?.logger;
    this.executionAgentFieldId = opts?.executionAgentFieldId;
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
      const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
      throw new JiraApiError(message, res.status, path, parsedBody, retryAfterMs);
    }

    // Several endpoints (issue properties PUT, among others) return 200/201
    // with an empty body rather than 204, so empty-body detection is based on
    // the actual response text instead of the status code.
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async searchIssues(jql: string, opts: SearchIssuesOptions = {}): Promise<JiraIssue[]> {
    const issues: JiraIssue[] = [];
    let nextPageToken: string | undefined;
    do {
      const response = await withRetry(
        () =>
          this.request<RawSearchResponse>("POST", "/rest/api/2/search/jql", {
            jql,
            maxResults: opts.maxResults ?? 50,
            fields:
              opts.fields ??
              (this.executionAgentFieldId
                ? [...DEFAULT_FIELDS, this.executionAgentFieldId]
                : DEFAULT_FIELDS),
            ...(nextPageToken ? { nextPageToken } : {}),
          }),
        { isRetryable: isTransientJiraError, getDelayMs: jiraRetryDelayMs },
      );
      issues.push(
        ...response.issues.map((issue) => mapRawIssue(issue, this.executionAgentFieldId)),
      );
      nextPageToken = opts.all && !response.isLast ? response.nextPageToken : undefined;
    } while (nextPageToken);
    return issues;
  }

  async getIssue(key: string, fields?: string[]): Promise<JiraIssue> {
    const selectedFields =
      fields ??
      (this.executionAgentFieldId
        ? [...DEFAULT_FIELDS, this.executionAgentFieldId]
        : DEFAULT_FIELDS);
    const raw = await withRetry(
      () =>
        this.request<RawJiraIssue>(
          "GET",
          `/rest/api/2/issue/${encodeURIComponent(key)}?fields=${selectedFields.join(",")}`,
        ),
      { isRetryable: isTransientJiraError, getDelayMs: jiraRetryDelayMs },
    );
    return mapRawIssue(raw, this.executionAgentFieldId);
  }

  async addComment(key: string, body: string): Promise<void> {
    await this.request<unknown>("POST", `/rest/api/2/issue/${encodeURIComponent(key)}/comment`, {
      body,
    });
  }

  async getComments(key: string): Promise<JiraComment[]> {
    const response = await withRetry(
      () =>
        this.request<RawCommentsResponse>(
          "GET",
          `/rest/api/2/issue/${encodeURIComponent(key)}/comment`,
        ),
      { isRetryable: isTransientJiraError, getDelayMs: jiraRetryDelayMs },
    );
    return response.comments.map(mapRawComment);
  }

  async getTransitions(key: string): Promise<JiraTransition[]> {
    const response = await withRetry(
      () =>
        this.request<RawTransitionsResponse>(
          "GET",
          `/rest/api/2/issue/${encodeURIComponent(key)}/transitions`,
        ),
      { isRetryable: isTransientJiraError, getDelayMs: jiraRetryDelayMs },
    );
    return response.transitions.map((t) => ({
      id: t.id,
      name: t.name,
      toStatusName: t.to?.name ?? "",
    }));
  }

  async listProjectStatuses(projectKey: string): Promise<string[]> {
    const issueTypes = await this.request<Array<{ statuses?: Array<{ name?: string }> }>>(
      "GET",
      `/rest/api/2/project/${encodeURIComponent(projectKey)}/statuses`,
    );
    return [
      ...new Set(
        issueTypes.flatMap(
          (type) =>
            type.statuses
              ?.map((status) => status.name)
              .filter((name): name is string => Boolean(name)) ?? [],
        ),
      ),
    ].sort();
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

  async transitionIssueToStatus(key: string, targetStatusName: string): Promise<void> {
    const target = targetStatusName.normalize("NFC");
    const transitions = await this.getTransitions(key);
    const match = transitions.find((t) => t.toStatusName.normalize("NFC") === target);
    if (!match) {
      // Costs an extra read, but only on what would otherwise be a failure:
      // the issue may already sit in the target status (a retried report, or
      // a human moved it), which is success, not a misconfiguration.
      const issue = await this.getIssue(key, ["status"]);
      if (issue.statusName.normalize("NFC") === target) return;
      throw new StatusNotReachableError(
        key,
        targetStatusName,
        issue.statusName,
        transitions.map((t) => t.toStatusName),
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

  async updateIssueDescription(key: string, description: string): Promise<void> {
    await this.request<unknown>("PUT", `/rest/api/2/issue/${encodeURIComponent(key)}`, {
      fields: { description },
    });
  }

  async removeLabel(key: string, label: string): Promise<void> {
    await this.request<unknown>("PUT", `/rest/api/2/issue/${encodeURIComponent(key)}`, {
      update: { labels: [{ remove: label }] },
    });
  }

  async getMyself(): Promise<JiraUser> {
    const raw = await withRetry(() => this.request<RawUser>("GET", "/rest/api/2/myself"), {
      isRetryable: isTransientJiraError,
      getDelayMs: jiraRetryDelayMs,
    });
    return mapRawUser(raw);
  }

  async searchUsers(query: string): Promise<JiraUser[]> {
    const raw = await withRetry(
      () =>
        this.request<RawUser[]>(
          "GET",
          `/rest/api/2/user/search?query=${encodeURIComponent(query)}`,
        ),
      { isRetryable: isTransientJiraError, getDelayMs: jiraRetryDelayMs },
    );
    return raw.map(mapRawUser);
  }

  async createIssue(input: CreateIssueInput): Promise<{ key: string }> {
    const fields: Record<string, unknown> = {
      project: { key: input.projectKey },
      issuetype: { name: input.issueTypeName },
      summary: input.summary,
    };
    if (input.description !== undefined) fields.description = input.description;
    if (input.parentKey) fields.parent = { key: input.parentKey };
    if (input.assigneeAccountId) fields.assignee = { accountId: input.assigneeAccountId };
    if (input.labels?.length) fields.labels = input.labels;
    const raw = await this.request<RawCreateIssueResponse>("POST", "/rest/api/2/issue", { fields });
    return { key: raw.key };
  }

  async assignIssue(key: string, accountId: string | null): Promise<void> {
    await this.request<unknown>("PUT", `/rest/api/2/issue/${encodeURIComponent(key)}/assignee`, {
      accountId,
    });
  }

  async listProjects(): Promise<JiraProjectSummary[]> {
    const response = await withRetry(
      () =>
        this.request<RawProjectSearchResponse>("GET", "/rest/api/2/project/search?maxResults=100"),
      { isRetryable: isTransientJiraError, getDelayMs: jiraRetryDelayMs },
    );
    return response.values.map((v) => ({ key: v.key, name: v.name }));
  }

  async getProject(key: string): Promise<JiraProject> {
    const raw = await withRetry(
      () => this.request<RawProject>("GET", `/rest/api/2/project/${encodeURIComponent(key)}`),
      { isRetryable: isTransientJiraError, getDelayMs: jiraRetryDelayMs },
    );
    return {
      key: raw.key,
      name: raw.name,
      issueTypes: (raw.issueTypes ?? []).map((t) => ({
        name: t.name,
        subtask: t.subtask ?? false,
      })),
    };
  }

  async getIssueProperty(key: string, propertyKey: string): Promise<unknown | null> {
    try {
      const raw = await withRetry(
        () =>
          this.request<RawIssuePropertyResponse>(
            "GET",
            `/rest/api/2/issue/${encodeURIComponent(key)}/properties/${encodeURIComponent(propertyKey)}`,
          ),
        { isRetryable: isTransientJiraError, getDelayMs: jiraRetryDelayMs },
      );
      return raw.value;
    } catch (error) {
      if (error instanceof JiraApiError && error.status === 404) return null;
      throw error;
    }
  }

  /** Not retried: writes are never safe to retry blindly (ADR 0006). */
  async setIssueProperty(key: string, propertyKey: string, value: unknown): Promise<void> {
    await this.request<unknown>(
      "PUT",
      `/rest/api/2/issue/${encodeURIComponent(key)}/properties/${encodeURIComponent(propertyKey)}`,
      value,
    );
  }
}
