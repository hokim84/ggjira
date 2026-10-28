import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The worker home (ADR 0060, 0065): one folder per worker holding its config, credential and all
 * local state. It may sit inside a project such as the GGJIRA checkout: the provider CLIs are told
 * to ignore instruction files above the repository they work in (src/worker/instruction-files.ts).
 *
 *   <home>/worker.config.json  credential.json  spool/  fci-spool/  logs/
 *   <home>/repositories/<repositoryId>/repo/       clone (unless repositories[].path names one)
 *   <home>/repositories/<repositoryId>/worktrees/  one git worktree per job
 */

export const WORKER_CONFIG_FILE = "worker.config.json";

/** The GGJIRA checkout this code runs from (`src/` or `dist/` sits in it), or undefined for an
 *  installed package, which has no `.git`. */
export function ggjiraCheckout(): string | undefined {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  return existsSync(path.join(root, ".git")) ? path.resolve(root) : undefined;
}

/** `<checkout>/data/worker` when GGJIRA runs from its checkout (run-worker.bat, `npm run dev`);
 *  for an installed package `%LOCALAPPDATA%\ggjira\worker` on Windows, `~/.ggjira/worker` elsewhere. */
export function defaultWorkerHome(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  checkout: string | null = ggjiraCheckout() ?? null,
): string {
  if (checkout) return path.join(checkout, "data", "worker");
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
