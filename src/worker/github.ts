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
export type RetirePullRequest = (input: {
  cwd: string;
  repo: string;
  number: number;
  replacementUrl: string;
}) => Promise<void>;

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
    [
      "pr",
      "view",
      input.head,
      "--repo",
      input.repo,
      "--json",
      "number,url,state,baseRefName,headRefName",
    ],
    input.cwd,
    timeoutMs,
  );
  if (existing.code === 0) {
    try {
      const parsed = JSON.parse(existing.stdout) as {
        number?: number;
        url?: string;
        state?: string;
        baseRefName?: string;
        headRefName?: string;
      };
      if (
        parsed.number &&
        parsed.url &&
        parsed.state === "OPEN" &&
        parsed.baseRefName === input.base &&
        parsed.headRefName === input.head
      ) {
        const edited = await runGh(
          gh,
          [
            "pr",
            "edit",
            String(parsed.number),
            "--repo",
            input.repo,
            "--title",
            input.title,
            "--body",
            input.body,
          ],
          input.cwd,
          timeoutMs,
        );
        if (edited.code !== 0)
          throw new Error(edited.stderr || "Cannot update existing PR manifest");
        return { repo: input.repo, number: parsed.number, url: parsed.url };
      }
    } catch {
      // fall through to the create error
    }
  }
  throw new Error(created.stderr || created.stdout || `gh exited with ${created.code}`);
};

/** Close only unmerged legacy child PRs, after their replacement parent PR exists. */
export const retirePullRequest: RetirePullRequest = async (input) => {
  const prior = await runGh(
    "gh",
    ["pr", "view", String(input.number), "--repo", input.repo, "--json", "state"],
    input.cwd,
    60000,
  );
  if (prior.code !== 0) throw new Error(prior.stderr || "Cannot inspect legacy child PR");
  const state = (JSON.parse(prior.stdout) as { state: string }).state;
  if (state !== "OPEN") return;
  const closed = await runGh(
    "gh",
    [
      "pr",
      "close",
      String(input.number),
      "--repo",
      input.repo,
      "--comment",
      `부모 통합 PR로 이전했습니다: ${input.replacementUrl}\n변경 커밋과 브랜치는 보존합니다.`,
    ],
    input.cwd,
    60000,
  );
  if (closed.code !== 0) throw new Error(closed.stderr || "Cannot retire legacy child PR");
};
