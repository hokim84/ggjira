import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JiraSecrets } from "../src/config.js";
import { JiraApiError, JiraClient, TransitionNotFoundError } from "../src/jira/client.js";

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
      },
    ]);
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
});
