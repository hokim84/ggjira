import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export interface WorktreeHandle {
  path: string;
  branch: string;
}

export interface ManagedWorktreeInfo {
  path: string;
  ageMs: number;
}

class GitCommandError extends Error {
  constructor(
    message: string,
    readonly command: string[],
    readonly stderr: string,
  ) {
    super(message);
    this.name = "GitCommandError";
  }
}

function runGit(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    const stderrChunks: string[] = [];
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString("utf-8")));
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const stderr = stderrChunks.join("").trim();
      reject(
        new GitCommandError(`git ${args.join(" ")} failed (exit ${code}): ${stderr}`, args, stderr),
      );
    });
  });
}

/** Checks the configured workspace itself, so worktree failures in real repos stay visible. */
export function isGitRepository(workspacePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: workspacePath,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf-8");
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0 && output.trim() === "true"));
  });
}

/** Creates a new git worktree at `<worktreesRoot>/<branch-with-slashes-flattened>` on a new branch. */
export async function createWorktree(
  repoPath: string,
  baseBranch: string,
  branch: string,
  worktreesRoot: string,
): Promise<WorktreeHandle> {
  const dirName = branch.replace(/\//g, "-");
  const worktreePath = `${worktreesRoot}/${dirName}`;
  await runGit(["worktree", "add", "-b", branch, worktreePath, baseBranch], repoPath);
  return { path: worktreePath, branch };
}

export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  await runGit(["worktree", "remove", "--force", worktreePath], repoPath);
}

export async function hasUncommittedChanges(worktreePath: string): Promise<boolean> {
  return await new Promise((resolve, reject) => {
    const child = spawn("git", ["status", "--porcelain"], {
      cwd: worktreePath,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: string[] = [];
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf-8")));
    child.on("error", reject);
    child.on("close", () => resolve(chunks.join("").trim().length > 0));
  });
}

export async function commitAll(worktreePath: string, message: string): Promise<void> {
  await runGit(["add", "-A"], worktreePath);
  await runGit(["commit", "-m", message], worktreePath);
}

export async function changedFilesSince(
  worktreePath: string,
  baseBranch: string,
): Promise<string[]> {
  return await new Promise((resolve, reject) => {
    const child = spawn("git", ["diff", "--name-only", `${baseBranch}...HEAD`], {
      cwd: worktreePath,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: string[] = [];
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf-8")));
    child.on("error", reject);
    child.on("close", () =>
      resolve(
        chunks
          .join("")
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean),
      ),
    );
  });
}

/**
 * Lists worktree directories GGJIRA has created under `worktreesRoot`, with
 * how long ago each was last modified — used by `worktrees:prune` to decide
 * what's old enough to remove. Cleanup itself stays a manual/scheduled
 * command (see ADR 0004); this just answers "what's there and how old".
 */
export function listManagedWorktrees(worktreesRoot: string): ManagedWorktreeInfo[] {
  if (!existsSync(worktreesRoot)) return [];
  const now = Date.now();
  return readdirSync(worktreesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const entryPath = path.join(worktreesRoot, entry.name);
      const { mtimeMs } = statSync(entryPath);
      return { path: entryPath, ageMs: now - mtimeMs };
    });
}

/** Absolute paths of every worktree `repoPath` has registered (`git worktree list --porcelain`),
 *  so `worker worktrees prune` removes each one through the repository that owns it. */
export function listRepositoryWorktreePaths(repoPath: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["worktree", "list", "--porcelain"], {
      cwd: repoPath,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new GitCommandError(
            `git worktree list failed (exit ${code}): ${stderr.trim()}`,
            ["worktree", "list"],
            stderr,
          ),
        );
        return;
      }
      resolve(
        output
          .split("\n")
          .filter((line) => line.startsWith("worktree "))
          .map((line) => path.resolve(line.slice("worktree ".length).trim())),
      );
    });
  });
}

export { GitCommandError };
