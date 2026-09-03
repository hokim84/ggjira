import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSetupWizard } from "../src/setup/wizard.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function scriptedAsk(
  answers: string[],
): (question: string, defaultValue?: string) => Promise<string> {
  let i = 0;
  return async (_question, defaultValue) => {
    const answer = answers[i++];
    if (answer === undefined) throw new Error("scriptedAsk ran out of answers");
    return answer === "" ? (defaultValue ?? "") : answer;
  };
}

describe("runSetupWizard", () => {
  let cwd: string;
  let fetchMock: ReturnType<typeof vi.fn>;
  let lines: string[];

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "ggjira-setup-test-"));
    // mockImplementation (not mockResolvedValue) so each call gets its own Response —
    // a Response body can only be read once, and this test calls fetch repeatedly.
    fetchMock = vi.fn().mockImplementation(async () =>
      jsonResponse(200, {
        accountId: "acc-1",
        displayName: "GGJIRA Implement",
        emailAddress: "a@b.com",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    lines = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(cwd, { recursive: true, force: true });
  });

  it("writes a valid implement config and a restrictively-permissioned .env", async () => {
    const ask = scriptedAsk([
      "https://example.atlassian.net", // Jira URL
      "a@b.com", // email
      "secret-token", // api token
      "ggjira-implement", // identity
      "implement", // role
      "test-machine", // machine
      cwd, // workspace path (a real dir, but not a git repo — only a warning)
      "main", // base branch
      "claude-code", // provider
      "sonnet", // model
      "To Do", // ready status
      "In Progress", // claim transition
      "In Review", // done transition
    ]);

    await runSetupWizard({ check: false, cwd, ask, print: (l) => lines.push(l) });

    const configPath = path.join(cwd, "ggjira.config.json");
    const envPath = path.join(cwd, ".env");
    expect(existsSync(configPath)).toBe(true);
    expect(existsSync(envPath)).toBe(true);

    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.agent).toEqual({
      identity: "ggjira-implement",
      role: "implement",
      machine: "test-machine",
    });
    expect(config.jira.baseUrl).toBe("https://example.atlassian.net");
    expect(config.pm).toEqual({});

    const env = readFileSync(envPath, "utf-8");
    expect(env).toContain("JIRA_EMAIL=a@b.com");
    expect(env).toContain("JIRA_API_TOKEN=secret-token");

    const mode = statSync(envPath).mode & 0o777;
    expect(mode).toBe(0o600);

    expect(lines.some((l) => l.includes("Wrote"))).toBe(true);
  });

  it("asks for the needs-decision transition and implement assignee when role is pm", async () => {
    const ask = scriptedAsk([
      "https://example.atlassian.net",
      "pm@b.com",
      "secret-token",
      "ggjira-pm",
      "pm",
      "test-machine",
      cwd,
      "main",
      "claude-code",
      "sonnet",
      "To Do",
      "In Progress",
      "In Review",
      "Needs Decision",
      "ggjira-implement@example.com",
    ]);

    await runSetupWizard({ check: false, cwd, ask, print: (l) => lines.push(l) });

    const config = JSON.parse(readFileSync(path.join(cwd, "ggjira.config.json"), "utf-8"));
    expect(config.agent.role).toBe("pm");
    expect(config.workflow.needsDecisionTransitionName).toBe("Needs Decision");
    expect(config.pm.implementAssignee).toBe("ggjira-implement@example.com");
  });

  it("backs up an existing config/env instead of silently discarding them", async () => {
    const ask = scriptedAsk([
      "https://example.atlassian.net",
      "a@b.com",
      "secret-token",
      "ggjira-implement",
      "implement",
      "test-machine",
      cwd,
      "main",
      "claude-code",
      "sonnet",
      "To Do",
      "In Progress",
      "In Review",
    ]);

    await runSetupWizard({ check: false, cwd, ask, print: (l) => lines.push(l) });
    // run again with different answers to trigger the backup path
    const ask2 = scriptedAsk([
      "https://example.atlassian.net",
      "a2@b.com",
      "secret-token-2",
      "ggjira-implement-2",
      "implement",
      "test-machine-2",
      cwd,
      "main",
      "claude-code",
      "sonnet",
      "To Do",
      "In Progress",
      "In Review",
    ]);
    await runSetupWizard({ check: false, cwd, ask: ask2, print: (l) => lines.push(l) });

    expect(existsSync(path.join(cwd, "ggjira.config.json.bak"))).toBe(true);
    expect(existsSync(path.join(cwd, ".env.bak"))).toBe(true);
    const config = JSON.parse(readFileSync(path.join(cwd, "ggjira.config.json"), "utf-8"));
    expect(config.agent.identity).toBe("ggjira-implement-2");
  });

  it("fails cleanly (no files written) when the Jira connection check fails", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse(401, { errorMessages: ["unauthorized"] }),
    );
    const ask = scriptedAsk(["https://example.atlassian.net", "a@b.com", "bad-token"]);

    await runSetupWizard({ check: false, cwd, ask, print: (l) => lines.push(l) });

    expect(existsSync(path.join(cwd, "ggjira.config.json"))).toBe(false);
    expect(existsSync(path.join(cwd, ".env"))).toBe(false);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  describe("--check", () => {
    it("reports FAILED when there is no config file yet", async () => {
      await runSetupWizard({ check: true, cwd, print: (l) => lines.push(l) });
      expect(lines.some((l) => l.startsWith("config: FAILED"))).toBe(true);
      expect(process.exitCode).toBe(1);
      process.exitCode = 0;
    });
  });
});
