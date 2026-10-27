import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadWorkerConfig, WorkerConfigError } from "../src/worker-runtime/config.js";
import { defaultWorkerHome, instructionLeaks, workerPaths } from "../src/worker-runtime/paths.js";

describe("loadWorkerConfig", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "ggjira-worker-config-test-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** Writes `<home>/worker.config.json` and returns the home. */
  function writeConfig(config: unknown): string {
    writeFileSync(path.join(dataDir, "worker.config.json"), JSON.stringify(config));
    return dataDir;
  }

  function validConfig(overrides: Record<string, unknown> = {}) {
    return {
      configVersion: 6,
      routerUrl: "https://router.example.com",
      repositories: [{ id: "repo-1", path: "/repos/repo-1" }],
      providers: [{ id: "claude-default" }],
      ...overrides,
    };
  }

  it("loads a minimal valid config and applies defaults", () => {
    const config = loadWorkerConfig(writeConfig(validConfig()));
    expect(config.repositories[0]).toEqual({
      id: "repo-1",
      path: path.resolve(dataDir, "/repos/repo-1"),
      baseBranch: "main",
      validateCommand: null,
      createPullRequest: false,
    });
    expect(config.home).toBe(path.resolve(dataDir));
  });

  it("keeps every local file in the worker home (ADR 0060)", () => {
    const config = loadWorkerConfig(
      writeConfig(
        validConfig({
          repositories: [
            { id: "cloned", cloneUrl: "https://github.com/org/cloned.git" },
            { id: "relative", path: "checkouts/relative" },
          ],
        }),
      ),
    );
    const paths = workerPaths(config.home);
    expect(config.repositories.map((repo) => repo.path)).toEqual([
      path.join(dataDir, "repositories", "cloned", "repo"),
      path.join(dataDir, "checkouts", "relative"),
    ]);
    expect(paths.repositoryWorktrees("cloned")).toBe(
      path.join(dataDir, "repositories", "cloned", "worktrees"),
    );
    expect([paths.credential, paths.spool, paths.logs]).toEqual([
      path.join(dataDir, "credential.json"),
      path.join(dataDir, "spool"),
      path.join(dataDir, "logs"),
    ]);
  });

  it("points a home without a config at worker start", () => {
    expect(() => loadWorkerConfig(dataDir)).toThrow(/Run "ggjira worker start"/);
  });

  it("refuses a configVersion 5 file and a repository id that is not a folder name", () => {
    expect(() =>
      loadWorkerConfig(writeConfig({ ...validConfig(), configVersion: 5, dataDir: "data/worker" })),
    ).toThrow(/runbook\.md §47/);
    expect(() =>
      loadWorkerConfig(writeConfig(validConfig({ repositories: [{ id: "../escape" }] }))),
    ).toThrow(WorkerConfigError);
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
    expect(() => loadWorkerConfig(path.join(dataDir, "does-not-exist"))).toThrow(WorkerConfigError);
  });

  it("throws WorkerConfigError for invalid JSON", () => {
    writeFileSync(path.join(dataDir, "worker.config.json"), "{ not json");
    expect(() => loadWorkerConfig(dataDir)).toThrow(WorkerConfigError);
  });
});

describe("worker home", () => {
  it("defaults to the user's local data folder", () => {
    expect(
      defaultWorkerHome({ LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, "win32", "C:\\Users\\a"),
    ).toBe("C:\\Users\\a\\AppData\\Local\\ggjira\\worker");
    expect(defaultWorkerHome({}, "linux", "/home/a")).toBe("/home/a/.ggjira/worker");
  });

  it("finds instruction files and repositories above a folder (KAN-47)", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ggjira-home-leak-"));
    try {
      const home = path.join(root, "project", "data", "worker");
      mkdirSync(home, { recursive: true });
      expect(instructionLeaks(home)).toEqual([]);
      writeFileSync(path.join(root, "project", "AGENTS.md"), "run npm run check\n");
      mkdirSync(path.join(root, "project", ".git"));
      expect(instructionLeaks(home)).toEqual([
        path.join(root, "project", "AGENTS.md"),
        path.join(root, "project", ".git"),
      ]);
      // A named repository's own instructions belong to it.
      expect(instructionLeaks(path.join(root, "project"), false)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
