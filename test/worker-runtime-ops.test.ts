import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkerProviderConfigSchema } from "../src/contracts/provider.js";
import { createWorktree } from "../src/worker/worktree.js";
import { RouterClient } from "../src/worker-runtime/client.js";
import {
  routerUrlProblem,
  type WorkerConfig,
  WorkerConfigSchema,
  workerWorktreesRoot,
} from "../src/worker-runtime/config.js";
import { pruneWorktrees, runWorkerCheck } from "../src/worker-runtime/ops.js";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

describe("worker operations", () => {
  let dir: string;
  let repo: string;
  let config: WorkerConfig;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ggjira-worker-ops-"));
    repo = path.join(dir, "repo");
    mkdirSync(repo);
    git(["init", "-q", "-b", "main"], repo);
    git(["config", "user.email", "t@example.com"], repo);
    git(["config", "user.name", "t"], repo);
    writeFileSync(path.join(repo, "a.txt"), "a");
    git(["add", "."], repo);
    git(["commit", "-q", "-m", "init"], repo);
    config = WorkerConfigSchema.parse({
      configVersion: 5,
      routerUrl: "https://router.example",
      credentialPath: path.join(dir, "missing-credential.json"),
      repositories: [{ id: "repo1", path: repo }],
      providers: [WorkerProviderConfigSchema.parse({ id: "default" })],
      dataDir: path.join(dir, "data"),
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("allows plain http only for a loopback Router", () => {
    expect(routerUrlProblem("https://router.example")).toBeUndefined();
    expect(routerUrlProblem("http://127.0.0.1:8787")).toBeUndefined();
    expect(routerUrlProblem("http://localhost:8787")).toBeUndefined();
    expect(routerUrlProblem("http://router.example")).toContain("https://");
  });

  it("prunes old job worktrees through their repository and keeps the branches", async () => {
    const root = workerWorktreesRoot(config);
    mkdirSync(root, { recursive: true });
    const old = await createWorktree(repo, "main", "ggjira/KAN-1-old", root);
    const fresh = await createWorktree(repo, "main", "ggjira/KAN-2-new", root);
    const tenDaysAgo = (Date.now() - 10 * 86_400_000) / 1000;
    utimesSync(old.path, tenDaysAgo, tenDaysAgo);

    // git reports real paths (on macOS the temp dir sits behind the /var -> /private/var symlink).
    const oldPath = realpathSync(old.path);
    const freshPath = realpathSync(fresh.path);
    const dryRun = await pruneWorktrees(config, { olderThanMs: 7 * 86_400_000, dryRun: true });
    expect(dryRun.removed).toEqual([oldPath]);
    expect(git(["worktree", "list"], repo)).toContain("KAN-1-old");

    const outcome = await pruneWorktrees(config, { olderThanMs: 7 * 86_400_000 });
    expect(outcome.removed).toEqual([oldPath]);
    expect(outcome.kept).toEqual([freshPath]);
    const worktrees = git(["worktree", "list"], repo);
    expect(worktrees).not.toContain("KAN-1-old");
    expect(worktrees).toContain("KAN-2-new");
    expect(git(["branch", "--list", "ggjira/KAN-1-old"], repo)).toContain("ggjira/KAN-1-old");
  });

  it("check reports a missing credential, a runnable provider and an unreachable Router", async () => {
    const client = new RouterClient({
      routerUrl: config.routerUrl,
      fetch: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    const items = await runWorkerCheck(config, { client, commandRuns: () => true });
    expect(items).toEqual([
      { level: "fail", message: expect.stringContaining("missing-credential.json") },
      { level: "ok", message: expect.stringContaining('repository "repo1": git repository') },
      { level: "ok", message: expect.stringContaining('provider "default"') },
      { level: "fail", message: expect.stringContaining("ECONNREFUSED") },
    ]);
  });
});
