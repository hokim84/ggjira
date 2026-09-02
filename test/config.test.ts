import { describe, expect, it } from "vitest";
import { ConfigError, loadAppConfig, loadJiraSecretsFromEnv } from "../src/config.js";

describe("loadAppConfig", () => {
  it("loads and applies defaults for a valid config file", () => {
    const config = loadAppConfig("test/fixtures/valid-config.json");

    expect(config.jira.jql).toContain("project = GGJ");
    expect(config.targetRepo.path).toBe("/tmp/target-repo");
    expect(config.targetRepo.baseBranch).toBe("main");
    expect(config.worker.command).toBe("claude");
    expect(config.worker.model).toBe("sonnet");
    expect(config.polling.intervalMs).toBe(60000);
    expect(config.concurrency.maxConcurrentJobs).toBe(1);
  });

  it("throws ConfigError immediately when required fields are missing", () => {
    expect(() => loadAppConfig("test/fixtures/invalid-config.json")).toThrow(ConfigError);
  });

  it("throws ConfigError when the config file does not exist", () => {
    expect(() => loadAppConfig("test/fixtures/does-not-exist.json")).toThrow(ConfigError);
  });

  it("throws ConfigError when the config file is not valid JSON", () => {
    expect(() => loadAppConfig("test/fixtures/invalid-config.json").constructor).toBeDefined();
  });
});

describe("loadJiraSecretsFromEnv", () => {
  it("loads valid Jira credentials from environment variables", () => {
    const secrets = loadJiraSecretsFromEnv({
      JIRA_BASE_URL: "https://example.atlassian.net",
      JIRA_EMAIL: "user@example.com",
      JIRA_API_TOKEN: "token-123",
    } as NodeJS.ProcessEnv);

    expect(secrets.baseUrl).toBe("https://example.atlassian.net");
    expect(secrets.email).toBe("user@example.com");
    expect(secrets.apiToken).toBe("token-123");
  });

  it("throws ConfigError when Jira credentials are missing", () => {
    expect(() => loadJiraSecretsFromEnv({} as NodeJS.ProcessEnv)).toThrow(ConfigError);
  });
});
