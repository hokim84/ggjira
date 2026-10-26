import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * The worker home (ADR 0060): one folder per worker holding its config, credential and all local
 * state. It lives outside any checkout so an agent working in a job worktree never finds the
 * host's own CLAUDE.md or AGENTS.md by walking up the folders.
 *
 *   <home>/worker.config.json  credential.json  spool/  fci-spool/  logs/
 *   <home>/repositories/<repositoryId>/repo/       clone (unless repositories[].path names one)
 *   <home>/repositories/<repositoryId>/worktrees/  one git worktree per job
 */

export const WORKER_CONFIG_FILE = "worker.config.json";

/** `%LOCALAPPDATA%\ggjira\worker` on Windows, `~/.ggjira/worker` elsewhere. */
export function defaultWorkerHome(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (platform === "win32") {
    return path.win32.join(
      env.LOCALAPPDATA ?? path.win32.join(home, "AppData", "Local"),
      "ggjira",
      "worker",
    );
  }
  return path.posix.join(home, ".ggjira", "worker");
}

export interface WorkerPaths {
  home: string;
  config: string;
  credential: string;
  spool: string;
  fciSpool: string;
  logs: string;
  repositoryClone: (repositoryId: string) => string;
  repositoryWorktrees: (repositoryId: string) => string;
}

export function workerPaths(home: string): WorkerPaths {
  const root = path.resolve(home);
  const repository = (id: string) => path.join(root, "repositories", id);
  return {
    home: root,
    config: path.join(root, WORKER_CONFIG_FILE),
    credential: path.join(root, "credential.json"),
    spool: path.join(root, "spool"),
    fciSpool: path.join(root, "fci-spool"),
    logs: path.join(root, "logs"),
    repositoryClone: (id) => path.join(repository(id), "repo"),
    repositoryWorktrees: (id) => path.join(repository(id), "worktrees"),
  };
}

/** Files that make an agent pick up another project's instructions, or put its work inside
 *  another repository, when they sit in a folder above where it runs. */
const LEAKING_NAMES = ["CLAUDE.md", "AGENTS.md", ".git"] as const;

/**
 * The instruction files and repositories found in `dir` and every folder above it (KAN-47: an
 * agent read the host's AGENTS.md from a parent folder and ran the host's checks). `includeSelf`
 * is false for a repository the operator named, whose own CLAUDE.md belongs to it.
 */
export function instructionLeaks(dir: string, includeSelf = true): string[] {
  const found: string[] = [];
  let current = path.resolve(dir);
  if (!includeSelf) current = path.dirname(current);
  for (;;) {
    for (const name of LEAKING_NAMES) {
      const candidate = path.join(current, name);
      if (existsSync(candidate)) found.push(candidate);
    }
    const parent = path.dirname(current);
    if (parent === current) return found;
    current = parent;
  }
}
