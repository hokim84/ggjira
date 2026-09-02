import { spawn } from "node:child_process";

export interface WorktreeHandle {
  path: string;
  branch: string;
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

export { GitCommandError };
