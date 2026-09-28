import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadWorkerConfig, WorkerConfigError } from "../src/worker-runtime/config.js";

describe("loadWorkerConfig", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "ggjira-worker-config-test-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  function writeConfig(config: unknown): string {
    const configPath = path.join(dataDir, "worker.config.json");
    writeFileSync(configPath, JSON.stringify(config));
    return configPath;
  }

  function validConfig(overrides: Record<string, unknown> = {}) {
    return {
      configVersion: 5,
      routerUrl: "https://router.example.com",
      credentialPath: "data/worker-credential.json",
      repositories: [{ id: "repo-1", path: "/repos/repo-1" }],
      providers: [{ id: "claude-default" }],
      ...overrides,
    };
  }

  it("loads a minimal valid config and applies defaults", () => {
    const config = loadWorkerConfig(writeConfig(validConfig()));
    expect(config.repositories[0]).toEqual({
      id: "repo-1",
      path: "/repos/repo-1",
      baseBranch: "main",
      validateCommand: null,
      createPullRequest: false,
    });
    expect(config.capabilities).toEqual([]);
    expect(config.backends).toEqual([]);
    expect(config.logPath).toBe("data/worker-logs");
  });

  it("defaults a claude-code provider's command to 'claude' and codex to 'codex'", () => {
    const config = loadWorkerConfig(
      writeConfig(
        validConfig({
          providers: [
            { id: "claude-default", type: "claude-code" },
            { id: "codex-default", type: "codex" },
          ],
        }),
      ),
    );
    expect(config.providers[0]?.command).toBe("claude");
    expect(config.providers[1]?.command).toBe("codex");
  });

  it("preserves an explicit provider command instead of defaulting it", () => {
    const config = loadWorkerConfig(
      writeConfig(
        validConfig({ providers: [{ id: "claude-default", command: "/usr/local/bin/claude" }] }),
      ),
    );
    expect(config.providers[0]?.command).toBe("/usr/local/bin/claude");
  });

  it("rejects two repositories declaring the same id", () => {
    expect(() =>
      loadWorkerConfig(
        writeConfig(
          validConfig({
            repositories: [
              { id: "repo-1", path: "/repos/a" },
              { id: "repo-1", path: "/repos/b" },
            ],
          }),
        ),
      ),
    ).toThrow(WorkerConfigError);
  });

  it("rejects two providers declaring the same id", () => {
    expect(() =>
      loadWorkerConfig(
        writeConfig(
          validConfig({
            providers: [{ id: "claude-default" }, { id: "claude-default", type: "codex" }],
          }),
        ),
      ),
    ).toThrow(WorkerConfigError);
  });

  it("requires at least one repository and one provider", () => {
    expect(() => loadWorkerConfig(writeConfig(validConfig({ repositories: [] })))).toThrow(
      WorkerConfigError,
    );
    expect(() => loadWorkerConfig(writeConfig(validConfig({ providers: [] })))).toThrow(
      WorkerConfigError,
    );
  });

  it("throws WorkerConfigError for a missing config file", () => {
    expect(() => loadWorkerConfig(path.join(dataDir, "does-not-exist.json"))).toThrow(
      WorkerConfigError,
    );
  });

  it("throws WorkerConfigError for invalid JSON", () => {
    const configPath = path.join(dataDir, "worker.config.json");
    writeFileSync(configPath, "{ not json");
    expect(() => loadWorkerConfig(configPath)).toThrow(WorkerConfigError);
  });
});
