import { describe, expect, it } from "vitest";
import { loadRouterSecretsFromEnv, RouterSecretsError } from "../src/router/secrets.js";

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
