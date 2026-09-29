import type Database from "better-sqlite3";

export type PullRequestState = "open" | "merged" | "closed";

export interface PullRequestRow {
  repo: string;
  number: number;
  url: string;
  issueKey: string;
  jobId: string;
  attemptId: string;
  state: PullRequestState;
  closedBy: string | null;
  createdAt: string;
  updatedAt: string;
  /** Last GitHub poll of this PR and what went wrong, if anything (ADR 0032). */
  lastCheckedAt: string | null;
  lastError: string | null;
}

function toRow(row: Record<string, unknown>): PullRequestRow {
  return {
    repo: row.repo as string,
    number: row.number as number,
    url: row.url as string,
    issueKey: row.issue_key as string,
    jobId: row.job_id as string,
    attemptId: row.attempt_id as string,
    state: row.state as PullRequestState,
    closedBy: (row.closed_by as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    lastCheckedAt: (row.last_checked_at as string | null | undefined) ?? null,
    lastError: (row.last_error as string | null | undefined) ?? null,
  };
}

/** Repos are matched case-insensitively, as GitHub does. */
const normalizeRepo = (repo: string) => repo.toLowerCase();

/** Records a worker-opened PR. A replayed result (same PR) changes nothing. */
export function recordPullRequest(
  db: Database.Database,
  input: {
    repo: string;
    number: number;
    url: string;
    issueKey: string;
    jobId: string;
    attemptId: string;
    now: string;
  },
): void {
  db.prepare(
    `INSERT OR IGNORE INTO pull_requests
       (repo, number, url, issue_key, job_id, attempt_id, state, closed_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', NULL, ?, ?)`,
  ).run(
    normalizeRepo(input.repo),
    input.number,
    input.url,
    input.issueKey,
    input.jobId,
    input.attemptId,
    input.now,
    input.now,
  );
}

export function getPullRequest(
  db: Database.Database,
  repo: string,
  number: number,
): PullRequestRow | undefined {
  const row = db
    .prepare("SELECT * FROM pull_requests WHERE repo = ? AND number = ?")
    .get(normalizeRepo(repo), number) as Record<string, unknown> | undefined;
  return row ? toRow(row) : undefined;
}

export function listOpenPullRequests(db: Database.Database): PullRequestRow[] {
  return (
    db
      .prepare("SELECT * FROM pull_requests WHERE state = 'open' ORDER BY created_at ASC")
      .all() as Array<Record<string, unknown>>
  ).map(toRow);
}

/** Closes an open PR row; false when it was already closed (a replayed event). */
export function closePullRequest(
  db: Database.Database,
  input: {
    repo: string;
    number: number;
    state: "merged" | "closed";
    by: string | null;
    now: string;
  },
): boolean {
  return (
    db
      .prepare(
        `UPDATE pull_requests SET state = ?, closed_by = ?, updated_at = ?
         WHERE repo = ? AND number = ? AND state = 'open'`,
      )
      .run(input.state, input.by, input.now, normalizeRepo(input.repo), input.number).changes === 1
  );
}

/** Remembers a webhook delivery; false when it was already seen. */
export function recordGithubDelivery(
  db: Database.Database,
  input: { id: string; event: string; now: string },
): boolean {
  return (
    db
      .prepare("INSERT OR IGNORE INTO github_deliveries (id, event, received_at) VALUES (?, ?, ?)")
      .run(input.id, input.event, input.now).changes === 1
  );
}

/** Records one poll of a PR: `error` null means GitHub answered. */
export function recordPullRequestCheck(
  db: Database.Database,
  input: { repo: string; number: number; error: string | null; now: string },
): void {
  db.prepare(
    "UPDATE pull_requests SET last_checked_at = ?, last_error = ? WHERE lower(repo) = ? AND number = ?",
  ).run(input.now, input.error, normalizeRepo(input.repo), input.number);
}

/** Open PRs first, then the most recently closed, for the settings screen. */
export function listRecentPullRequests(db: Database.Database, limit: number): PullRequestRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM pull_requests
       ORDER BY CASE state WHEN 'open' THEN 0 ELSE 1 END, updated_at DESC
       LIMIT ?`,
    )
    .all(limit) as Record<string, unknown>[];
  return rows.map(toRow);
}
