import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AppConfigSchema,
  ConfigError,
  loadAppConfig,
  loadJiraSecretsFromEnv,
  resolveJiraSecrets,
} from "../src/config.js";

describe("loadAppConfig", () => {
  it("loads and applies defaults for a valid implement config file", () => {
    const config = loadAppConfig("test/fixtures/valid-config.json");

    expect(config.jira.baseUrl).toBe("https://example.atlassian.net");
    expect(config.agent).toEqual({
      identity: "ggjira-implement",
      role: "implement",
      machine: "test-machine",
    });
    expect(config.workflow.readyStatus).toBe("To Do");
    expect(config.workflow.claimTransitionName).toBe("In Progress");
    expect(config.workspace.path).toBe("/tmp/target-repo");
    expect(config.workspace.baseBranch).toBe("main");
    expect(config.provider.type).toBe("claude-code");
    expect(config.provider.command).toBe("claude");
    expect(config.provider.model).toBe("sonnet");
    expect(config.polling.intervalMs).toBe(60000);
  });

  it("defaults provider.command to codex when provider.type is codex", () => {
    const config = loadAppConfig("test/fixtures/valid-config.json");
    expect(config.provider.codex.sandbox).toBe("workspace-write");
  });

  it("loads a valid pm config with its required fields", () => {
    const config = loadAppConfig("test/fixtures/valid-config-pm.json");

    expect(config.agent.role).toBe("pm");
    expect(config.pm.implementAssignee).toBe("ggjira-implement@example.com");
    expect(config.workflow.needsDecisionTransitionName).toBe("Needs Decision");
  });

  it("throws ConfigError when a pm config is missing implementAssignee/needsDecisionTransitionName", () => {
    expect(() => loadAppConfig("test/fixtures/invalid-config-pm.json")).toThrow(ConfigError);
  });

  it("throws ConfigError immediately when required fields are missing", () => {
    expect(() => loadAppConfig("test/fixtures/invalid-config.json")).toThrow(ConfigError);
  });

  it("throws ConfigError when the config file does not exist", () => {
    expect(() => loadAppConfig("test/fixtures/does-not-exist.json")).toThrow(ConfigError);
  });

  it("points at 'ggjira setup' when the config looks like a pre-agent (v1) config", () => {
    expect(() => loadAppConfig("test/fixtures/legacy-v1-config.json")).toThrow(/ggjira setup/);
  });

  it("normalizes workflow status/transition names to NFC, so an NFD-typed value still matches Jira's own NFC value", () => {
    // "해야 할 일" (Korean for "to do") typed or pasted through some editors/IMEs
    // can land as NFD (decomposed jamo) instead of NFC (precomposed) -- the two
    // render identically but are different code points, so an un-normalized
    // config value would never string-match what Jira's REST API returns
    // (which is NFC). This is exactly the bug a Korean-language board hit.
    const nfd = "해야 할 일".normalize("NFD");
    const nfc = "해야 할 일".normalize("NFC");
    expect(nfd).not.toBe(nfc); // sanity check that the fixture actually differs at the byte level

    const raw = JSON.parse(readFileSync("test/fixtures/valid-config.json", "utf-8"));
    raw.workflow = { ...raw.workflow, readyStatus: nfd };
    const result = AppConfigSchema.safeParse(raw);

    expect(result.success).toBe(true);
    expect(result.success && result.data.workflow.readyStatus).toBe(nfc);
  });
});

describe("loadJiraSecretsFromEnv", () => {
  it("loads valid Jira credentials from environment variables", () => {
    const secrets = loadJiraSecretsFromEnv({
      JIRA_EMAIL: "user@example.com",
      JIRA_API_TOKEN: "token-123",
    } as NodeJS.ProcessEnv);

    expect(secrets.email).toBe("user@example.com");
    expect(secrets.apiToken).toBe("token-123");
    expect(secrets.baseUrlOverride).toBeUndefined();
  });

  it("captures JIRA_BASE_URL as an override when present", () => {
    const secrets = loadJiraSecretsFromEnv({
      JIRA_EMAIL: "user@example.com",
      JIRA_API_TOKEN: "token-123",
      JIRA_BASE_URL: "https://override.atlassian.net",
    } as NodeJS.ProcessEnv);

    expect(secrets.baseUrlOverride).toBe("https://override.atlassian.net");
  });

  it("throws ConfigError when Jira credentials are missing", () => {
    expect(() => loadJiraSecretsFromEnv({} as NodeJS.ProcessEnv)).toThrow(ConfigError);
  });
});

describe("resolveJiraSecrets", () => {
  const config = loadAppConfig("test/fixtures/valid-config.json");

  it("uses config.jira.baseUrl when there is no env override", () => {
    const secrets = resolveJiraSecrets(config, { email: "a@b.com", apiToken: "t" });
    expect(secrets.baseUrl).toBe(config.jira.baseUrl);
  });

  it("prefers the env override when present", () => {
    const secrets = resolveJiraSecrets(config, {
      email: "a@b.com",
      apiToken: "t",
      baseUrlOverride: "https://override.atlassian.net",
    });
    expect(secrets.baseUrl).toBe("https://override.atlassian.net");
  });
});
