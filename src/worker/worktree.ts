import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
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

function runGit(
  args: string[],
  cwd: string,
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
    });
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

/**
 * `git clone <url> <dest>` for `worker start`. `--` ends option parsing so a URL can never be read
 * as an option, and `protocol.ext.allow=never` rules out command-running transports even if a
 * URL slipped past `CloneUrlSchema`.
 */
export async function cloneRepository(url: string, dest: string, branch?: string): Promise<void> {
  const parent = path.dirname(path.resolve(dest));
  mkdirSync(parent, { recursive: true });
  await runGit(
    [
      "-c",
      "protocol.ext.allow=never",
      "clone",
      ...(branch ? ["--branch", branch] : []),
      "--",
      url,
      path.resolve(dest),
    ],
    parent,
  );
}

/** A git remote name as configured locally (`origin`, `upstream`, ...); never an option or URL. */
export const REMOTE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Pushes a job branch to `remote` with the worker machine's own git credentials. Never prompts
 * (a prompt would hang an unattended worker) and gives up after `timeoutMs`.
 */
export async function pushBranch(
  worktreePath: string,
  remote: string,
  branch: string,
  timeoutMs = 120_000,
): Promise<void> {
  if (!REMOTE_NAME_PATTERN.test(remote)) throw new Error(`invalid git remote name "${remote}"`);
  await runGit(["push", remote, `refs/heads/${branch}:refs/heads/${branch}`], worktreePath, {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    timeoutMs,
  });
}

/** `git remote get-url`, or undefined when the remote does not exist. */
export function remoteUrl(repoPath: string, remote: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn("git", ["remote", "get-url", "--", remote], {
      cwd: repoPath,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf-8");
    });
    child.on("error", () => resolve(undefined));
    child.on("close", (code) => resolve(code === 0 ? output.trim() || undefined : undefined));
  });
}

/** `owner/repo` for a GitHub remote URL; undefined for other hosts. */
export function githubRepoSlug(remote: string): string | undefined {
  const match =
    remote.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/) ??
    remote.match(/^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

/** A "open a pull request" page for GitHub remotes; undefined for other hosts. */
export function githubCompareUrl(
  remote: string,
  baseBranch: string,
  branch: string,
): string | undefined {
  const slug = githubRepoSlug(remote);
  if (!slug) return undefined;
  const [owner, repo] = slug.split("/");
  const ref = (name: string) => name.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${owner}/${repo}/compare/${ref(baseBranch)}...${ref(branch)}?expand=1`;
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
