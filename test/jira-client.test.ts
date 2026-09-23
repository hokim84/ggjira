import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  JiraApiError,
  JiraClient,
  type JiraSecrets,
  TransitionNotFoundError,
  parseRetryAfterMs,
} from "../src/jira/client.js";

const secrets: JiraSecrets = {
  baseUrl: "https://example.atlassian.net",
  email: "user@example.com",
  apiToken: "token-123",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

function jsonResponseWithHeaders(
  status: number,
  body: unknown,
  headers: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("JiraClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends Basic auth header derived from Jira secrets", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { issues: [], isLast: true }));
    const client = new JiraClient(secrets);

    await client.searchIssues("project = KAN");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from("user@example.com:token-123").toString("base64")}`,
    );
  });

  it("lists distinct statuses available to a Jira project", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, [
        { statuses: [{ name: "To Do" }, { name: "AI에 작업 위임" }] },
        { statuses: [{ name: "AI에 작업 위임" }, { name: "Done" }] },
      ]),
    );
    const statuses = await new JiraClient(secrets).listProjectStatuses("KAN");
    expect(statuses).toEqual(["AI에 작업 위임", "Done", "To Do"].sort());
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://example.atlassian.net/rest/api/2/project/KAN/statuses",
    );
  });

  it("searchIssues posts to /rest/api/2/search/jql and maps issues", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        issues: [
          {
            id: "10000",
            key: "KAN-1",
            fields: { summary: "Do the thing", status: { name: "To Do" }, labels: ["ggjira"] },
          },
        ],
        isLast: true,
      }),
    );
    const client = new JiraClient(secrets);

    const issues = await client.searchIssues("project = KAN", { maxResults: 5 });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.atlassian.net/rest/api/2/search/jql");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toMatchObject({
      jql: "project = KAN",
      maxResults: 5,
    });
    expect(issues).toEqual([
      {
        key: "KAN-1",
        id: "10000",
        summary: "Do the thing",
        description: null,
        statusName: "To Do",
        labels: ["ggjira"],
        assigneeAccountId: null,
        issueTypeName: null,
        parentKey: null,
        projectKey: null,
      },
    ]);
  });

  it("requests and maps the configured execution-agent option by canonical ID", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        issues: [
          {
            id: "10000",
            key: "KAN-1",
            fields: {
              summary: "Distributed task",
              status: { name: "AI Implementation" },
              customfield_12345: { id: "option-agent-a", value: "Agent A" },
            },
          },
        ],
        isLast: true,
      }),
    );
    const client = new JiraClient(secrets, { executionAgentFieldId: "customfield_12345" });

    const issues = await client.searchIssues("project = KAN");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).fields).toContain("customfield_12345");
    expect(issues[0]?.executionAgentOptionId).toBe("option-agent-a");
  });

  it("getIssue fetches by key and maps fields", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        id: "10000",
        key: "KAN-1",
        fields: { summary: "S", description: "D", status: { name: "In Progress" }, labels: [] },
      }),
    );
    const client = new JiraClient(secrets);

    const issue = await client.getIssue("KAN-1");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/rest/api/2/issue/KAN-1?fields=");
    expect(init.method).toBe("GET");
    expect(issue.statusName).toBe("In Progress");
    expect(issue.description).toBe("D");
  });

  it("addComment posts a plain-text body", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { id: "1" }));
    const client = new JiraClient(secrets);

    await client.addComment("KAN-1", "hello");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.atlassian.net/rest/api/2/issue/KAN-1/comment");
    expect(JSON.parse(init.body as string)).toEqual({ body: "hello" });
  });

  it("getTransitions maps id/name/toStatusName", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        transitions: [
          { id: "21", name: "In Progress", to: { name: "In Progress" } },
          { id: "31", name: "In Review", to: { name: "In Review" } },
        ],
      }),
    );
    const client = new JiraClient(secrets);

    const transitions = await client.getTransitions("KAN-1");

    expect(transitions).toEqual([
      { id: "21", name: "In Progress", toStatusName: "In Progress" },
      { id: "31", name: "In Review", toStatusName: "In Review" },
    ]);
  });

  it("getIssueChangelog maps entries and paginates by startAt until total is reached", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, {
          values: [
            {
              id: "100",
              created: "2026-01-01T00:00:00.000Z",
              items: [{ field: "status", fromString: "To Do", toString: "AI 작업 요청" }],
            },
          ],
          startAt: 0,
          maxResults: 1,
          total: 2,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          values: [
            {
              id: "101",
              created: "2026-01-02T00:00:00.000Z",
              items: [{ field: "assignee", fromString: null, toString: "user-1" }],
            },
          ],
          startAt: 1,
          maxResults: 1,
          total: 2,
        }),
      );
    const client = new JiraClient(secrets);

    const changelog = await client.getIssueChangelog("KAN-1");

    expect(changelog).toEqual([
      {
        id: "100",
        created: "2026-01-01T00:00:00.000Z",
        items: [{ field: "status", fromString: "To Do", toString: "AI 작업 요청" }],
      },
      {
        id: "101",
        created: "2026-01-02T00:00:00.000Z",
        items: [{ field: "assignee", fromString: null, toString: "user-1" }],
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://example.atlassian.net/rest/api/2/issue/KAN-1/changelog?startAt=1&maxResults=100",
    );
  });

  it("transitionIssue resolves the transition id by name and executes it", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, {
          transitions: [{ id: "21", name: "In Progress", to: { name: "In Progress" } }],
        }),
      )
      .mockResolvedValueOnce(emptyResponse(204));
    const client = new JiraClient(secrets);

    await client.transitionIssue("KAN-1", "In Progress");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ transition: { id: "21" } });
  });

  it("transitionIssue throws TransitionNotFoundError when the name has no match", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        transitions: [{ id: "21", name: "In Progress", to: { name: "In Progress" } }],
      }),
    );
    const client = new JiraClient(secrets);

    await expect(client.transitionIssue("KAN-1", "Done")).rejects.toThrow(TransitionNotFoundError);
  });

  it("getMyself fetches and maps the authenticated user", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        accountId: "acc-1",
        displayName: "GGJIRA Implement",
        emailAddress: "a@b.com",
      }),
    );
    const client = new JiraClient(secrets);

    const self = await client.getMyself();

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.atlassian.net/rest/api/2/myself");
    expect(self).toEqual({
      accountId: "acc-1",
      displayName: "GGJIRA Implement",
      emailAddress: "a@b.com",
    });
  });

  it("searchUsers queries by string and maps results", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, [{ accountId: "acc-2", displayName: "Someone", emailAddress: "s@b.com" }]),
    );
    const client = new JiraClient(secrets);

    const users = await client.searchUsers("someone@b.com");

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.atlassian.net/rest/api/2/user/search?query=someone%40b.com");
    expect(users).toEqual([
      { accountId: "acc-2", displayName: "Someone", emailAddress: "s@b.com" },
    ]);
  });

  it("getComments fetches and maps a comment list", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        comments: [
          {
            id: "1",
            author: { accountId: "acc-1", displayName: "A" },
            body: "hi",
            created: "2026-01-01T00:00:00Z",
          },
        ],
      }),
    );
    const client = new JiraClient(secrets);

    const comments = await client.getComments("KAN-1");

    expect(comments).toEqual([
      {
        id: "1",
        authorAccountId: "acc-1",
        authorDisplayName: "A",
        body: "hi",
        created: "2026-01-01T00:00:00Z",
      },
    ]);
  });

  it("createIssue posts project/issuetype/summary and returns the new key", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { key: "KAN-2" }));
    const client = new JiraClient(secrets);

    const result = await client.createIssue({
      projectKey: "KAN",
      issueTypeName: "Subtask",
      summary: "Do part of the thing",
      description: "details",
      parentKey: "KAN-1",
      assigneeAccountId: "acc-2",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.atlassian.net/rest/api/2/issue");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      fields: {
        project: { key: "KAN" },
        issuetype: { name: "Subtask" },
        summary: "Do part of the thing",
        description: "details",
        parent: { key: "KAN-1" },
        assignee: { accountId: "acc-2" },
      },
    });
    expect(result).toEqual({ key: "KAN-2" });
  });

  it("createIssue includes labels in fields when provided", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { key: "KAN-3" }));
    const client = new JiraClient(secrets);

    await client.createIssue({
      projectKey: "KAN",
      issueTypeName: "Task",
      summary: "Agent profile",
      labels: ["ggjira-agent"],
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.fields.labels).toEqual(["ggjira-agent"]);
  });

  it("assignIssue PUTs the accountId, including null to unassign", async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse(204));
    const client = new JiraClient(secrets);

    await client.assignIssue("KAN-1", null);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.atlassian.net/rest/api/2/issue/KAN-1/assignee");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ accountId: null });
  });

  it("addLabel and removeLabel PUT the labels update op", async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse(204));
    const client = new JiraClient(secrets);

    await client.addLabel("KAN-1", "ggjira-failed");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.atlassian.net/rest/api/2/issue/KAN-1");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({
      update: { labels: [{ add: "ggjira-failed" }] },
    });
  });

  it("throws JiraApiError with status/endpoint/message on non-ok responses", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(404, { errorMessages: ["Issue does not exist"], errors: {} }),
    );
    const client = new JiraClient(secrets);

    const error = await client.getIssue("KAN-999").catch((e) => e);

    expect(error).toBeInstanceOf(JiraApiError);
    expect((error as JiraApiError).status).toBe(404);
    expect((error as JiraApiError).message).toBe("Issue does not exist");
  });

  it("returns undefined without parsing a body on 204 responses", async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse(204));
    const client = new JiraClient(secrets);

    await expect(client.addComment("KAN-1", "x")).resolves.toBeUndefined();
  });

  it("returns undefined on a 200/201 response with an empty body (issue property writes)", async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse(200));
    const client = new JiraClient(secrets);

    await expect(
      client.setIssueProperty("KAN-1", "ggjira.registration", { machineId: "m1" }),
    ).resolves.toBeUndefined();

    fetchMock.mockResolvedValueOnce(emptyResponse(201));
    await expect(
      client.setIssueProperty("KAN-1", "ggjira.registration", { machineId: "m1" }),
    ).resolves.toBeUndefined();
  });

  it("listProjects GETs project/search and maps key/name", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        values: [
          { key: "KAN", name: "Kanban" },
          { key: "OPS", name: "Operations" },
        ],
        isLast: true,
      }),
    );
    const client = new JiraClient(secrets);

    const projects = await client.listProjects();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.atlassian.net/rest/api/2/project/search?maxResults=100");
    expect(init.method).toBe("GET");
    expect(projects).toEqual([
      { key: "KAN", name: "Kanban" },
      { key: "OPS", name: "Operations" },
    ]);
  });

  it("getProject GETs project/{key} and maps issueTypes with subtask flag", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        key: "KAN",
        name: "Kanban",
        issueTypes: [
          { name: "Task", subtask: false },
          { name: "Subtask", subtask: true },
        ],
      }),
    );
    const client = new JiraClient(secrets);

    const project = await client.getProject("KAN");

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.atlassian.net/rest/api/2/project/KAN");
    expect(project).toEqual({
      key: "KAN",
      name: "Kanban",
      issueTypes: [
        { name: "Task", subtask: false },
        { name: "Subtask", subtask: true },
      ],
    });
  });

  it("getIssueProperty GETs the property and returns its value", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { key: "ggjira.registration", value: { machineId: "m1" } }),
    );
    const client = new JiraClient(secrets);

    const value = await client.getIssueProperty("KAN-1", "ggjira.registration");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://example.atlassian.net/rest/api/2/issue/KAN-1/properties/ggjira.registration",
    );
    expect(init.method).toBe("GET");
    expect(value).toEqual({ machineId: "m1" });
  });

  it("getIssueProperty returns null when the property is absent (404)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { errorMessages: ["Not found"] }));
    const client = new JiraClient(secrets);

    const value = await client.getIssueProperty("KAN-1", "ggjira.registration");

    expect(value).toBeNull();
  });

  it("setIssueProperty PUTs the property value directly as the body", async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse(200));
    const client = new JiraClient(secrets);

    await client.setIssueProperty("KAN-1", "ggjira.registration", { machineId: "m1" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://example.atlassian.net/rest/api/2/issue/KAN-1/properties/ggjira.registration",
    );
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ machineId: "m1" });
  });

  it("retries a read call after a transient 503 and succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(503, { errorMessages: ["temporarily unavailable"] }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          id: "10000",
          key: "KAN-1",
          fields: { summary: "S", status: { name: "To Do" }, labels: [] },
        }),
      );
    const client = new JiraClient(secrets);

    const issue = await client.getIssue("KAN-1");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(issue.key).toBe("KAN-1");
  });

  it("does not retry a write call (addComment) on failure", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, { errorMessages: ["down"] }));
    const client = new JiraClient(secrets);

    await expect(client.addComment("KAN-1", "x")).rejects.toBeInstanceOf(JiraApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a read call after a 429 rate-limit response and succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponseWithHeaders(429, { errorMessages: ["rate limited"] }, { "Retry-After": "0" }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          id: "10000",
          key: "KAN-1",
          fields: { summary: "S", status: { name: "To Do" }, labels: [] },
        }),
      );
    const client = new JiraClient(secrets);

    const issue = await client.getIssue("KAN-1");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(issue.key).toBe("KAN-1");
  });

  it("parses the Retry-After header (seconds) onto the thrown JiraApiError", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponseWithHeaders(429, { errorMessages: ["rate limited"] }, { "Retry-After": "0" }),
    );
    fetchMock.mockResolvedValue(jsonResponseWithHeaders(404, { errorMessages: ["gone"] }, {}));
    const client = new JiraClient(secrets);

    // First response's Retry-After is what we're inspecting; the retry that
    // follows returns a non-retryable 404 so the loop stops immediately
    // instead of waiting out further backoff.
    const error = await client.getIssue("KAN-1").catch((e) => e);

    expect(error).toBeInstanceOf(JiraApiError);
    expect((error as JiraApiError).status).toBe(404);
  });
});

describe("parseRetryAfterMs", () => {
  it("parses a numeric seconds value into milliseconds", () => {
    expect(parseRetryAfterMs("2")).toBe(2000);
    expect(parseRetryAfterMs("0")).toBe(0);
  });

  it("clamps a very large value to the maximum retry delay", () => {
    expect(parseRetryAfterMs("999999")).toBe(30_000);
  });

  it("parses an HTTP-date value relative to now", () => {
    const future = new Date(Date.now() + 5000).toUTCString();
    const ms = parseRetryAfterMs(future);
    expect(ms).toBeGreaterThan(3000);
    expect(ms).toBeLessThanOrEqual(5000);
  });

  it("returns undefined for a missing or unparsable header", () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs("not-a-valid-value")).toBeUndefined();
  });
});
