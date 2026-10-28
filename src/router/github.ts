import { createHmac, timingSafeEqual } from "node:crypto";
import type { RouterDatabase } from "./db/connection.js";
import { COMMENT_TEXT, type MergeWhy } from "./comment-text.js";
import type { RouterConfig } from "./config.js";
import { recordAttention, resolveAttention, resolveAttentionIncident } from "./db/attention.js";
import { appendAudit } from "./db/audit.js";
import { getJob } from "./db/jobs.js";
import {
  type PullRequestRow,
  closePullRequest,
  getPullRequest,
  listOpenPullRequests,
  recordPullRequestCheck,
} from "./db/pull-requests.js";
import { insertReportBatch } from "./db/report-steps.js";
import {
  type ReviewRecordOutcome,
  type ReviewTargetRow,
  appendReviewRecord,
  getReviewTargetForAttempt,
} from "./db/review-targets.js";
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
  /** The pull request's head commit when it closed; `null` when GitHub did not say. */
  headSha: string | null;
  mergeSha?: string | null;
  targetBranch?: string | null;
}

/** The closing of a pull request out of a `pull_request` webhook payload; undefined otherwise. */
export function parsePullRequestClosed(
  event: string,
  payload: unknown,
): PullRequestClosed | undefined {
  if (event !== "pull_request") return undefined;
  const body = payload as {
    action?: string;
    pull_request?: {
      number?: number;
      merged?: boolean;
      merged_by?: { login?: string } | null;
      head?: { sha?: string } | null;
      merge_commit_sha?: string | null;
      base?: { ref?: string } | null;
    };
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
    headSha: pr.head?.sha ?? null,
    ...(pr.merge_commit_sha ? { mergeSha: pr.merge_commit_sha } : {}),
    ...(pr.base?.ref ? { targetBranch: pr.base.ref } : {}),
  };
}

/**
 * Whether a merge is the human acceptance of the result Router pinned for review (M4-11,
 * ADR 0040): the same head commit, and no newer result for the issue since. A stale or
 * mismatched merge is recorded but never moves the issue to done.
 */
export function judgeMerge(
  target: ReviewTargetRow | undefined,
  headSha: string | null,
): { outcome: ReviewRecordOutcome; why: MergeWhy; reason: string } {
  const judged = (outcome: ReviewRecordOutcome, why: MergeWhy) => ({
    outcome,
    why,
    // The review record keeps the English reason; the comment says it in Router's language.
    reason: COMMENT_TEXT.en.pullRequest.why(why),
  });
  if (!target) return judged("no_target", { kind: "no_target" });
  if (target.supersededBy) return judged("stale", { kind: "superseded" });
  if (!target.headSha || !headSha) {
    return judged("unverified", { kind: target.headSha ? "no_merged_head" : "no_reviewed_commit" });
  }
  if (target.headSha !== headSha) {
    return judged("stale", {
      kind: "head_mismatch",
      merged: headSha.slice(0, 12),
      reviewed: target.headSha.slice(0, 12),
    });
  }
  return judged("matched", { kind: "matched" });
}

export type PullRequestOutcome = "unknown" | "already-closed" | "journaled";

/** Records a PR closing once and journals its Jira steps. Safe to call for replays. */
export function handlePullRequestClosed(
  db: RouterDatabase,
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
      mergeSha: event.mergeSha ?? null,
      reviewedHead: event.headSha,
      targetBranch: event.targetBranch ?? null,
    });
    if (!changed) return "already-closed";
    resolveAttentionIncident(db, {
      issueKey: row.issueKey,
      kind: "pull_request_unchecked",
      cause: pullRequestCause(row),
      resolution: "the pull request closed",
      now,
    });
    const job = getJob(db, row.jobId);
    const workspace = job && config.workspaces.find((entry) => entry.id === job.workspaceId);
    const target = getReviewTargetForAttempt(db, row.attemptId);
    const judged = event.merged ? judgeMerge(target, event.headSha) : undefined;
    appendReviewRecord(db, {
      targetId: target?.id ?? null,
      issueKey: row.issueKey,
      action: event.merged ? "pull_request.merged" : "pull_request.closed",
      actor: event.by ? `github:${event.by}` : null,
      authentication: "github",
      headSha: event.headSha,
      outcome: judged?.outcome ?? (target ? "matched" : "no_target"),
      detail: { repo: row.repo, number: row.number, ...(judged ? { reason: judged.reason } : {}) },
      at: now,
    });
    if (judged?.outcome === "matched" || judged?.outcome === "unverified") {
      resolveAttention(db, {
        issueKey: row.issueKey,
        kinds: ["review_required"],
        resolution: `pull request merged by ${event.by ? `github:${event.by}` : "github"}`,
        now,
      });
    }
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
          // Unverified (an older worker, or GitHub left the head out) keeps ADR 0027's behaviour.
          ...(judged?.outcome === "stale" || judged?.outcome === "no_target"
            ? { doneWithheld: judged.why }
            : {}),
          ...(judged?.outcome === "unverified" ? { headNotCompared: judged.why } : {}),
          ...(target?.assessment.risk.status === "high" ? { highRisk: true } : {}),
          language: config.reporting.language,
        }),
        now,
      });
    }
    appendAudit(db, {
      at: now,
      actor: event.by ? `github:${event.by}` : "github",
      action: event.merged ? "pull_request.merged" : "pull_request.closed",
      subject: row.issueKey,
      detail: {
        repo: row.repo,
        number: row.number,
        jobId: row.jobId,
        ...(event.headSha ? { headSha: event.headSha } : {}),
        ...(judged ? { review: judged.outcome } : {}),
      },
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
  db: RouterDatabase;
  config: RouterConfig;
  token?: string | undefined;
  fetch?: FetchLike;
  now: () => string;
}): Promise<PullRequestPollReport> {
  const fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
  const report: PullRequestPollReport = { checked: 0, closed: [], errors: [] };
  const tracked = listOpenPullRequests(deps.db);
  for (const row of deps.db
    .prepare(
      "SELECT p.repo,p.number,j.repository_id FROM pull_requests p JOIN jobs j ON j.id=p.job_id LEFT JOIN fci_pr_observations o ON o.repo=p.repo AND o.number=p.number WHERE p.state IN ('merged','closed') AND (o.state IS NULL OR o.state<>p.state)",
    )
    .all()) {
    const p = row as { repo: string; number: number; repository_id: string };
    if (deps.config.repositories.find((r) => r.id === p.repository_id)?.fci?.enabled) {
      const pr = getPullRequest(deps.db, p.repo, p.number);
      if (pr) tracked.push(pr);
    }
  }
  for (const pr of tracked) {
    report.checked += 1;
    try {
      const state = await fetchPullRequestState(fetchImpl, pr, deps.token);
      const sourceJob = getJob(deps.db, pr.jobId);
      const fciEnabled = deps.config.repositories.find((r) => r.id === sourceJob?.repositoryId)?.fci
        ?.enabled;
      if (fciEnabled)
        try {
          if (!state.headSha || !state.baseSha)
            throw new Error("FCI PR head/base SHA is unavailable");
          const prior = deps.db
            .prepare("SELECT head_sha,commits FROM fci_pr_observations WHERE repo=? AND number=?")
            .get(pr.repo, pr.number) as { head_sha: string; commits: string } | undefined;
          const commits: string[] =
            prior?.head_sha === state.headSha ? JSON.parse(prior.commits) : [];
          if (!commits.length) {
            for (let page = 1; page <= 100; page++) {
              const response = await fetchImpl(
                `https://api.github.com/repos/${pr.repo}/pulls/${pr.number}/commits?per_page=100&page=${page}`,
                {
                  method: "GET",
                  headers: {
                    accept: "application/vnd.github+json",
                    "user-agent": "ggjira-router",
                    ...(deps.token ? { authorization: `Bearer ${deps.token}` } : {}),
                  },
                },
              );
              if (!response.ok) throw new Error(`FCI PR commit list: ${response.status}`);
              const items = (await response.json()) as { sha: string }[];
              commits.push(...items.map((c) => c.sha));
              if (items.length < 100) break;
            }
          }
          deps.db
            .prepare("INSERT OR REPLACE INTO fci_pr_observations VALUES (?,?,?,?,?,?,?,?,?)")
            .run(
              pr.repo,
              pr.number,
              state.headSha,
              state.baseSha,
              state.targetBranch ?? null,
              state.mergeSha ?? null,
              state.merged ? "merged" : state.closed ? "closed" : "open",
              JSON.stringify(commits),
              deps.now(),
            );
          deps.db
            .prepare("DELETE FROM fci_poll_errors WHERE repo=? AND number=?")
            .run(pr.repo, pr.number);
        } catch (error) {
          deps.db
            .prepare("INSERT OR REPLACE INTO fci_poll_errors VALUES (?,?,?,?)")
            .run(
              pr.repo,
              pr.number,
              error instanceof Error ? error.message : String(error),
              deps.now(),
            );
        }
      recordPullRequestCheck(deps.db, {
        repo: pr.repo,
        number: pr.number,
        error: null,
        now: deps.now(),
      });
      resolveAttentionIncident(deps.db, {
        issueKey: pr.issueKey,
        kind: "pull_request_unchecked",
        cause: pullRequestCause(pr),
        resolution: "GitHub answered",
        now: deps.now(),
      });
      if (!state.closed) continue;
      const outcome = handlePullRequestClosed(
        deps.db,
        deps.config,
        {
          repo: pr.repo,
          number: pr.number,
          merged: state.merged,
          by: state.by,
          headSha: state.headSha,
          mergeSha: state.mergeSha ?? null,
          targetBranch: state.targetBranch ?? null,
        },
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
      // Otherwise the failure shows only on the settings screen while a merge goes unnoticed.
      recordAttention(deps.db, {
        issueKey: pr.issueKey,
        approvalId: getJob(deps.db, pr.jobId)?.approvalId ?? null,
        kind: "pull_request_unchecked",
        cause: pullRequestCause(pr),
        severity: "immediate",
        reason: `Router cannot check ${pr.repo}#${pr.number} on GitHub; its merge is not noted on the Jira issue until it can`,
        evidence: { error: message },
        now: deps.now(),
      });
      report.errors.push({ repo: pr.repo, number: pr.number, error: message });
    }
  }
  return report;
}

/** One incident per pull request: its poll failing, whatever the reason this time. */
function pullRequestCause(pr: { repo: string; number: number }): string {
  return `${pr.repo.toLowerCase()}#${pr.number}`;
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
): Promise<{
  baseSha: string | null;
  closed: boolean;
  merged: boolean;
  by: string | null;
  headSha: string | null;
  mergeSha?: string | null;
  targetBranch?: string | null;
}> {
  // FCI also records the observed target SHA; regular lifecycle logic still uses its existing fields.
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
    head?: { sha?: string } | null;
    merge_commit_sha?: string | null;
    base?: { ref?: string; sha?: string } | null;
  };
  const merged = body.merged === true || Boolean(body.merged_at);
  return {
    closed: body.state === "closed",
    merged,
    by: body.merged_by?.login ?? null,
    headSha: body.head?.sha ?? null,
    mergeSha: body.merge_commit_sha ?? null,
    targetBranch: body.base?.ref ?? null,
    baseSha: body.base?.sha ?? null,
  };
}
