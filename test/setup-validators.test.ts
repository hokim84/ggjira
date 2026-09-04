import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JiraClient } from "../src/jira/client.js";
import {
  checkIsGitRepo,
  checkJiraConnection,
  checkProjectAccess,
  checkProviderCommand,
  checkWorkspacePath,
} from "../src/setup/validators.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("checkWorkspacePath", () => {
  it("is ok for an existing path", () => {
    expect(checkWorkspacePath(process.cwd()).ok).toBe(true);
  });

  it("fails for a path that doesn't exist", () => {
    const result = checkWorkspacePath("/definitely/not/a/real/path/ggjira-test");
    expect(result.ok).toBe(false);
  });
});

describe("checkIsGitRepo", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ggjira-git-check-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns false for a non-git directory", async () => {
    expect(await checkIsGitRepo(dir)).toBe(false);
  });

  it("returns true for a git repository", async () => {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    expect(await checkIsGitRepo(dir)).toBe(true);
  });
});

describe("checkProviderCommand", () => {
  it("is ok for a command that exists and exits 0 on --version", async () => {
    expect((await checkProviderCommand("node")).ok).toBe(true);
  });

  it("fails for a command that doesn't exist", async () => {
    expect((await checkProviderCommand("ggjira-nonexistent-binary-xyz")).ok).toBe(false);
  });
});

describe("checkJiraConnection", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("reports ok with the authenticated user on success", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse(200, { accountId: "acc-1", displayName: "GGJIRA", emailAddress: "a@b.com" }),
    );
    const jira = new JiraClient({
      baseUrl: "https://example.atlassian.net",
      email: "a@b.com",
      apiToken: "token",
    });

    const result = await checkJiraConnection(jira);

    expect(result.ok).toBe(true);
    expect(result.self?.accountId).toBe("acc-1");
  });

  it("reports not ok with a human-readable message on a 401", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse(401, { errorMessages: ["unauthorized"] }),
    );
    const jira = new JiraClient({
      baseUrl: "https://example.atlassian.net",
      email: "a@b.com",
      apiToken: "bad-token",
    });

    const result = await checkJiraConnection(jira);

    expect(result.ok).toBe(false);
    expect(result.message).toBe("Invalid email or API token.");
  });
});

describe("checkProjectAccess", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("reports ok when the project is found", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse(200, { key: "KAN", name: "Kanban", issueTypes: [] }),
    );
    const jira = new JiraClient({
      baseUrl: "https://example.atlassian.net",
      email: "a@b.com",
      apiToken: "token",
    });

    const result = await checkProjectAccess(jira, "KAN");

    expect(result.ok).toBe(true);
    expect(result.message).toContain("KAN");
  });

  it("reports a human-readable message on a 404", async () => {
    fetchMock.mockImplementation(async () => jsonResponse(404, { errorMessages: ["Not found"] }));
    const jira = new JiraClient({
      baseUrl: "https://example.atlassian.net",
      email: "a@b.com",
      apiToken: "token",
    });

    const result = await checkProjectAccess(jira, "NOPE");

    expect(result.ok).toBe(false);
    expect(result.message).toBe("Not found -- check the Jira URL and project key.");
  });
});
