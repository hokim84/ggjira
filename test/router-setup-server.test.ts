import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeJiraGateway } from "../src/jira/fake.js";
import { routerConfigTemplate } from "../src/router/config-store.js";
import { RouterConfigSchema } from "../src/router/config.js";
import { loadRouterSecrets } from "../src/router/secrets.js";
import { type JiraCredentials, buildSetupServer } from "../src/router/setup-server.js";

const SETUP_TOKEN = "setup-token-for-tests-0123456789";
const auth = { authorization: `Bearer ${SETUP_TOKEN}` };
const credentials = {
  baseUrl: "https://example.atlassian.net",
  email: "bot@example.com",
  apiToken: "jira-token",
};

describe("setup server", () => {
  let dir: string;
  let configPath: string;
  let secretsPath: string;
  let jira: FakeJiraGateway;
  let seen: JiraCredentials[];
  let app: FastifyInstance;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ggjira-setup-"));
    configPath = path.join(dir, "router.config.json");
    secretsPath = path.join(dir, "router.env");
    jira = new FakeJiraGateway();
    seen = [];
    app = buildSetupServer({
      configPath,
      secretsPath,
      setupToken: SETUP_TOKEN,
      jiraFactory: (creds) => {
        seen.push(creds);
        return jira;
      },
    });
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports setup mode on /health and requires the setup token", async () => {
    expect((await app.inject({ method: "GET", url: "/health" })).json()).toEqual({
      status: "ok",
      mode: "setup",
    });
    expect((await app.inject({ method: "GET", url: "/api/v1/setup/state" })).statusCode).toBe(401);
    const wrong = await app.inject({
      method: "GET",
      url: "/api/v1/setup/state",
      headers: { authorization: "Bearer wrong-token-wrong-token-wrong" },
    });
    expect(wrong.statusCode).toBe(401);
  });

  it("returns the paths and a starter template", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/setup/state", headers: auth });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      configPath,
      secretsPath,
      existingConfig: null,
      template: routerConfigTemplate(),
    });
  });

  it("tests Jira credentials and lists projects and statuses through the injected gateway", async () => {
    jira.seedProject({ key: "KAN", name: "Kanban", issueTypes: [] });
    jira.seedProjectStatuses("KAN", ["To Do", "AI 작업 요청", "작업 중", "Done"]);

    const me = await app.inject({
      method: "POST",
      url: "/api/v1/setup/jira/test",
      headers: auth,
      payload: credentials,
    });
    expect(me.json()).toMatchObject({ displayName: "GGJIRA Test Agent" });
    expect(seen[0]).toEqual(credentials);

    const projects = await app.inject({
      method: "POST",
      url: "/api/v1/setup/jira/projects",
      headers: auth,
      payload: credentials,
    });
    expect(projects.json()).toEqual({ projects: [{ key: "KAN", name: "Kanban" }] });

    const statuses = await app.inject({
      method: "POST",
      url: "/api/v1/setup/jira/statuses",
      headers: auth,
      payload: { ...credentials, projectKey: "KAN" },
    });
    expect(statuses.json()).toEqual({ statuses: ["To Do", "AI 작업 요청", "작업 중", "Done"] });
  });

  it("answers 502 when Jira rejects the credentials", async () => {
    jira.getMyself = async () => {
      throw new Error("401 Unauthorized");
    };
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/setup/jira/test",
      headers: auth,
      payload: credentials,
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ error: "jira_error", message: "401 Unauthorized" });
  });

  it("rejects an invalid config with field paths and writes nothing", async () => {
    const config = { ...routerConfigTemplate(), workspaces: [] };
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/setup/complete",
      headers: auth,
      payload: { config, jiraEmail: "bot@example.com", jiraApiToken: "t" },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: string; issues: Array<{ path: string }> };
    expect(body.error).toBe("invalid_config");
    expect(body.issues.map((issue) => issue.path)).toContain("workspaces");
    expect(() => statSync(configPath)).toThrow();
  });

  it("writes the config and an owner-only secrets file, then retires the setup token", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/setup/complete",
      headers: auth,
      payload: {
        config: routerConfigTemplate(),
        jiraEmail: "bot@example.com",
        jiraApiToken: "jira-token",
      },
    });
    expect(response.statusCode).toBe(200);
    const result = response.json() as { adminToken: string; webhookSecret: string };
    expect(result.adminToken.length).toBeGreaterThanOrEqual(16);

    const written = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(RouterConfigSchema.safeParse(written).success).toBe(true);
    expect(JSON.stringify(written)).not.toContain(result.adminToken);

    const secrets = loadRouterSecrets({}, secretsPath);
    expect(secrets).toEqual({
      jiraEmail: "bot@example.com",
      jiraApiToken: "jira-token",
      webhookSecret: result.webhookSecret,
      adminToken: result.adminToken,
    });
    if (process.platform !== "win32") {
      expect(statSync(secretsPath).mode & 0o777).toBe(0o600);
    }

    const again = await app.inject({ method: "GET", url: "/api/v1/setup/state", headers: auth });
    expect(again.statusCode).toBe(410);
  });

  it("rejects a Jira email that is not an email address", async () => {
    const provision = vi.spyOn(jira, "ensureAiWorkflow");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/setup/complete",
      headers: auth,
      payload: { config: routerConfigTemplate(), jiraEmail: "nope", jiraApiToken: "t" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_secrets" });
    expect(provision).not.toHaveBeenCalled();
  });

  it("automatically adds missing AI states at project selection and returns an explanation", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/setup/jira/ensure-workflow",
      headers: auth,
      payload: { ...credentials, projectKey: "KAN" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      complete: true,
      statuses: expect.arrayContaining([
        "AI 계획",
        "AI 계획중",
        "AI 구현",
        "AI 통합 대기",
        "AI 구현 완료",
        "Done",
      ]),
      messages: [expect.stringContaining("자동 추가")],
    });
    const repeated = await app.inject({
      method: "POST",
      url: "/api/v1/setup/jira/ensure-workflow",
      headers: auth,
      payload: { ...credentials, projectKey: "KAN" },
    });
    expect(repeated.json().added).toEqual([]);
  });

  it("does not save or retire the setup token while Jira is applying the workflow", async () => {
    vi.spyOn(jira, "ensureAiWorkflow").mockResolvedValue({
      complete: false,
      statuses: [],
      added: [],
      workflowsUpdated: [],
      messages: ["Jira 적용 대기"],
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/setup/complete",
      headers: auth,
      payload: {
        config: routerConfigTemplate(),
        jiraEmail: "bot@example.com",
        jiraApiToken: "jira-token",
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "workflow_pending" });
    expect(() => statSync(configPath)).toThrow();
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/setup/state", headers: auth })).statusCode,
    ).toBe(200);
  });
});
