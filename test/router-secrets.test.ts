import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadRouterSecrets,
  loadRouterSecretsFromEnv,
  parseEnvFile,
  RouterSecretsError,
} from "../src/router/secrets.js";

function validEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    JIRA_EMAIL: "bot@example.com",
    JIRA_API_TOKEN: "token-value",
    GGJIRA_WEBHOOK_SECRET: "webhook-secret-at-least-16-chars",
    GGJIRA_ADMIN_TOKEN: "admin-token-at-least-16-chars",
    ...overrides,
  };
}

describe("loadRouterSecretsFromEnv", () => {
  it("loads all four secrets from the given env", () => {
    const secrets = loadRouterSecretsFromEnv(validEnv());
    expect(secrets).toEqual({
      jiraEmail: "bot@example.com",
      jiraApiToken: "token-value",
      webhookSecret: "webhook-secret-at-least-16-chars",
      adminToken: "admin-token-at-least-16-chars",
    });
  });

  it("throws RouterSecretsError when JIRA_EMAIL is missing", () => {
    const env = validEnv();
    env.JIRA_EMAIL = undefined;
    expect(() => loadRouterSecretsFromEnv(env)).toThrow(RouterSecretsError);
  });

  it("throws RouterSecretsError when JIRA_EMAIL is not a valid email", () => {
    expect(() => loadRouterSecretsFromEnv(validEnv({ JIRA_EMAIL: "not-an-email" }))).toThrow(
      RouterSecretsError,
    );
  });

  it("throws RouterSecretsError when GGJIRA_WEBHOOK_SECRET is shorter than 16 characters", () => {
    expect(() => loadRouterSecretsFromEnv(validEnv({ GGJIRA_WEBHOOK_SECRET: "short" }))).toThrow(
      RouterSecretsError,
    );
  });

  it("throws RouterSecretsError when GGJIRA_ADMIN_TOKEN is missing", () => {
    const env = validEnv();
    env.GGJIRA_ADMIN_TOKEN = undefined;
    expect(() => loadRouterSecretsFromEnv(env)).toThrow(RouterSecretsError);
  });
});

describe("loadRouterSecrets (environment + secrets file)", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ggjira-secrets-"));
    file = path.join(dir, "router.env");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("fills what the environment leaves unset from the file, environment winning", () => {
    writeFileSync(
      file,
      [
        "# comment",
        "JIRA_EMAIL=file@example.com",
        'JIRA_API_TOKEN="file-token"',
        "GGJIRA_WEBHOOK_SECRET=file-webhook-secret-0123456789",
        "GGJIRA_ADMIN_TOKEN=file-admin-token-0123456789",
        "",
      ].join("\n"),
    );
    expect(loadRouterSecrets({ JIRA_EMAIL: "env@example.com" }, file)).toEqual({
      jiraEmail: "env@example.com",
      jiraApiToken: "file-token",
      webhookSecret: "file-webhook-secret-0123456789",
      adminToken: "file-admin-token-0123456789",
    });
  });

  it("treats a missing file as empty and fails only when secrets are incomplete", () => {
    expect(loadRouterSecrets(validEnv(), path.join(dir, "absent.env")).jiraEmail).toBe(
      "bot@example.com",
    );
    expect(() => loadRouterSecrets({}, path.join(dir, "absent.env"))).toThrow(RouterSecretsError);
  });

  it("parses the env_file subset", () => {
    expect(parseEnvFile("A=1\r\n# x\nB = 'two'\nnot a line\nC=has=equals\n")).toEqual({
      A: "1",
      B: "two",
      C: "has=equals",
    });
  });
});
