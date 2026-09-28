import { spawn } from "node:child_process";

/**
 * Opens a GitHub pull request for a pushed job branch with the worker machine's `gh` CLI and its
 * own login (ADR 0027). Router never holds GitHub write credentials.
 */

export interface PullRequestRef {
  repo: string;
  number: number;
  url: string;
}

export interface CreatePullRequestInput {
  cwd: string;
  /** `owner/repo`. */
  repo: string;
  base: string;
  head: string;
  title: string;
  body: string;
  ghCommand?: string;
  timeoutMs?: number;
}

export type CreatePullRequest = (input: CreatePullRequestInput) => Promise<PullRequestRef>;

function runGh(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" },
      timeout: timeoutMs,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

export function pullRequestFromUrl(repo: string, url: string): PullRequestRef | undefined {
  const match = url.match(/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)\b/);
  return match ? { repo, number: Number(match[1]), url } : undefined;
}

/** `gh pr create`; when a PR for the branch already exists (a retried job), returns that one. */
export const createPullRequest: CreatePullRequest = async (input) => {
  const gh = input.ghCommand ?? "gh";
  const timeoutMs = input.timeoutMs ?? 60_000;
  const created = await runGh(
    gh,
    [
      "pr",
      "create",
      "--repo",
      input.repo,
      "--base",
      input.base,
      "--head",
      input.head,
      "--title",
      input.title,
      "--body",
      input.body,
    ],
    input.cwd,
    timeoutMs,
  );
  const url = created.stdout.split(/\s+/).find((part) => part.startsWith("https://github.com/"));
  const ref = url ? pullRequestFromUrl(input.repo, url) : undefined;
  if (created.code === 0 && ref) return ref;

  const existing = await runGh(
    gh,
    ["pr", "view", input.head, "--repo", input.repo, "--json", "number,url"],
    input.cwd,
    timeoutMs,
  );
  if (existing.code === 0) {
    try {
      const parsed = JSON.parse(existing.stdout) as { number?: number; url?: string };
      if (parsed.number && parsed.url) {
        return { repo: input.repo, number: parsed.number, url: parsed.url };
      }
    } catch {
      // fall through to the create error
    }
  }
  throw new Error(created.stderr || created.stdout || `gh exited with ${created.code}`);
};
