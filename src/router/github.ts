import { createHmac, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import type { RouterConfig } from "./config.js";
import { appendAudit } from "./db/audit.js";
import { getJob } from "./db/jobs.js";
import {
  closePullRequest,
  getPullRequest,
  listOpenPullRequests,
  type PullRequestRow,
  recordPullRequestCheck,
} from "./db/pull-requests.js";
import { insertReportBatch } from "./db/report-steps.js";
import { buildPullRequestClosedSteps, pullRequestBatchId } from "./report-journal.js";

/**
 * Closing the loop on worker-opened GitHub pull requests (ADR 0027). A merge — learned from the
 * GitHub webhook or, as a fallback, by polling GitHub — journals a Jira comment and the move to
 * the workspace's done status. Router only reads GitHub; the PR itself is the worker's.
 */

/** `X-Hub-Signature-256: sha256=<hex HMAC of the raw body>`. */
export function verifyGithubSignature(
  rawBody: Buffer,
  header: string | undefined,
  secret: string,
): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(
    `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`,
    "utf-8",
  );
  const presented = Buffer.from(header, "utf-8");
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

export interface PullRequestClosed {
  repo: string;
  number: number;
  merged: boolean;
  by: string | null;
}

/** The closing of a pull request out of a `pull_request` webhook payload; undefined otherwise. */
export function parsePullRequestClosed(
  event: string,
  payload: unknown,
): PullRequestClosed | undefined {
  if (event !== "pull_request") return undefined;
  const body = payload as {
    action?: string;
    pull_request?: { number?: number; merged?: boolean; merged_by?: { login?: string } | null };
    repository?: { full_name?: string };
    sender?: { login?: string };
  };
  const pr = body.pull_request;
  const repo = body.repository?.full_name;
  if (body.action !== "closed" || !pr?.number || !repo) return undefined;
  const merged = pr.merged === true;
  return {
    repo,
    number: pr.number,
    merged,
    by: (merged ? pr.merged_by?.login : body.sender?.login) ?? body.sender?.login ?? null,
  };
}

export type PullRequestOutcome = "unknown" | "already-closed" | "journaled";

/** Records a PR closing once and journals its Jira steps. Safe to call for replays. */
export function handlePullRequestClosed(
  db: Database.Database,
  config: RouterConfig,
  event: PullRequestClosed,
  now: string,
): PullRequestOutcome {
  const row = getPullRequest(db, event.repo, event.number);
  if (!row) return "unknown";
  const run = db.transaction((): PullRequestOutcome => {
    const changed = closePullRequest(db, {
      repo: event.repo,
      number: event.number,
      state: event.merged ? "merged" : "closed",
      by: event.by,
      now,
    });
    if (!changed) return "already-closed";
    const job = getJob(db, row.jobId);
    const workspace = job && config.workspaces.find((entry) => entry.id === job.workspaceId);
    if (job && workspace) {
      insertReportBatch(db, {
        batchId: pullRequestBatchId(row.repo, row.number),
        jobId: job.id,
        attemptId: row.attemptId,
        issueKey: row.issueKey,
        steps: buildPullRequestClosedSteps({
          job,
          workspace,
          url: row.url,
          number: row.number,
          merged: event.merged,
          by: event.by,
        }),
        now,
      });
    }
    appendAudit(db, {
      at: now,
      actor: event.by ? `github:${event.by}` : "github",
      action: event.merged ? "pull_request.merged" : "pull_request.closed",
      subject: row.issueKey,
      detail: { repo: row.repo, number: row.number, jobId: row.jobId },
    });
    return "journaled";
  });
  return run();
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface PullRequestPollReport {
  checked: number;
  closed: Array<{ repo: string; number: number; merged: boolean }>;
  errors: Array<{ repo: string; number: number; error: string }>;
}

/**
 * The fallback for missed or unconfigured webhooks: asks GitHub about every PR still open in
 * SQLite. Public repositories work without a token (with GitHub's low anonymous rate limit).
 */
export async function pollPullRequests(deps: {
  db: Database.Database;
  config: RouterConfig;
  token?: string | undefined;
  fetch?: FetchLike;
  now: () => string;
}): Promise<PullRequestPollReport> {
  const fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
  const report: PullRequestPollReport = { checked: 0, closed: [], errors: [] };
  for (const pr of listOpenPullRequests(deps.db)) {
    report.checked += 1;
    try {
      const state = await fetchPullRequestState(fetchImpl, pr, deps.token);
      recordPullRequestCheck(deps.db, {
        repo: pr.repo,
        number: pr.number,
        error: null,
        now: deps.now(),
      });
      if (!state.closed) continue;
      const outcome = handlePullRequestClosed(
        deps.db,
        deps.config,
        { repo: pr.repo, number: pr.number, merged: state.merged, by: state.by },
        deps.now(),
      );
      if (outcome === "journaled") {
        report.closed.push({ repo: pr.repo, number: pr.number, merged: state.merged });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordPullRequestCheck(deps.db, {
        repo: pr.repo,
        number: pr.number,
        error: message,
        now: deps.now(),
      });
      report.errors.push({ repo: pr.repo, number: pr.number, error: message });
    }
  }
  return report;
}

/** Says what to do about a failed poll, not just the status: GitHub answers 404 for a private
 *  repository it won't show without (or with an insufficient) token (ADR 0032). */
export function pollErrorMessage(
  status: number,
  pr: { repo: string; number: number },
  hasToken: boolean,
): string {
  const where = `${pr.repo}#${pr.number}`;
  if (status === 404) {
    return hasToken
      ? `GitHub answered 404 for ${where}: the token cannot see this repository (give it Pull requests: read on ${pr.repo})`
      : `GitHub answered 404 for ${where}: a private repository needs GITHUB_TOKEN`;
  }
  if (status === 401) return `GitHub answered 401 for ${where}: GITHUB_TOKEN is invalid or expired`;
  if (status === 403 || status === 429) {
    return `GitHub answered ${status} for ${where}: rate limited or forbidden${hasToken ? "" : " (a GITHUB_TOKEN raises the limit)"}`;
  }
  return `GitHub answered ${status} for ${where}`;
}

async function fetchPullRequestState(
  fetchImpl: FetchLike,
  pr: PullRequestRow,
  token: string | undefined,
): Promise<{ closed: boolean; merged: boolean; by: string | null }> {
  const response = await fetchImpl(`https://api.github.com/repos/${pr.repo}/pulls/${pr.number}`, {
    method: "GET",
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "ggjira-router",
      "x-github-api-version": "2022-11-28",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) throw new Error(pollErrorMessage(response.status, pr, Boolean(token)));
  const body = (await response.json()) as {
    state?: string;
    merged?: boolean;
    merged_at?: string | null;
    merged_by?: { login?: string } | null;
  };
  const merged = body.merged === true || Boolean(body.merged_at);
  return { closed: body.state === "closed", merged, by: body.merged_by?.login ?? null };
}
