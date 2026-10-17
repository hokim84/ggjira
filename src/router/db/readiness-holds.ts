import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { ReadinessGap } from "../../issue/readiness.js";

export type ReadinessNoticeStatus = "pending" | "posted" | "failed";

/** One implementation request Router refused to start for an incomplete contract (migration 10). */
export interface ReadinessHoldRow {
  id: string;
  issueKey: string;
  approvalId: string;
  inputHash: string;
  missing: ReadinessGap[];
  firstSeenAt: string;
  lastSeenAt: string;
  seenCount: number;
  noticeStatus: ReadinessNoticeStatus;
  noticeTries: number;
  noticeError: string | null;
  resolvedAt: string | null;
}

function toRow(row: Record<string, unknown>): ReadinessHoldRow {
  return {
    id: row.id as string,
    issueKey: row.issue_key as string,
    approvalId: row.approval_id as string,
    inputHash: row.input_hash as string,
    missing: JSON.parse(row.missing as string) as ReadinessGap[],
    firstSeenAt: row.first_seen_at as string,
    lastSeenAt: row.last_seen_at as string,
    seenCount: row.seen_count as number,
    noticeStatus: row.notice_status as ReadinessNoticeStatus,
    noticeTries: row.notice_tries as number,
    noticeError: (row.notice_error as string | null) ?? null,
    resolvedAt: (row.resolved_at as string | null) ?? null,
  };
}

/** Same request, same gaps → same id. Any edit (new input hash) or re-approval is a new hold. */
export function readinessHoldId(input: {
  issueKey: string;
  approvalId: string;
  inputHash: string;
  missing: readonly ReadinessGap[];
}): string {
  const key = [
    input.issueKey,
    input.approvalId,
    input.inputHash,
    [...input.missing].sort().join(","),
  ];
  return createHash("sha256").update(key.join("|")).digest("hex").slice(0, 32);
}

/**
 * Records that `issueKey` is held for an incomplete contract on this pass. A re-poll of the same
 * request only bumps `last_seen_at`/`seen_count` — its notice was already queued once. Any other
 * open hold for the issue (an earlier edit of the same request) is resolved: the human changed
 * something, and the new row carries the current gaps. Returns the hold and whether it is new.
 */
export function recordReadinessHold(
  db: Database.Database,
  input: {
    issueKey: string;
    approvalId: string;
    inputHash: string;
    missing: readonly ReadinessGap[];
    now: string;
  },
): { hold: ReadinessHoldRow; created: boolean } {
  const id = readinessHoldId(input);
  const run = db.transaction(() => {
    db.prepare(
      "UPDATE readiness_holds SET resolved_at = ? WHERE issue_key = ? AND id <> ? AND resolved_at IS NULL",
    ).run(input.now, input.issueKey, id);
    const inserted = db
      .prepare(
        `INSERT OR IGNORE INTO readiness_holds (
          id, issue_key, approval_id, input_hash, missing, first_seen_at, last_seen_at, seen_count,
          notice_status, notice_tries, notice_error, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'pending', 0, NULL, NULL)`,
      )
      .run(
        id,
        input.issueKey,
        input.approvalId,
        input.inputHash,
        JSON.stringify([...input.missing]),
        input.now,
        input.now,
      );
    if (inserted.changes === 0) {
      db.prepare(
        `UPDATE readiness_holds
         SET last_seen_at = ?, seen_count = seen_count + 1, resolved_at = NULL
         WHERE id = ?`,
      ).run(input.now, id);
    }
    return inserted.changes > 0;
  });
  const created = run();
  const hold = getReadinessHold(db, id);
  if (!hold) throw new Error(`readiness hold ${id} vanished`);
  return { hold, created };
}

export function getReadinessHold(db: Database.Database, id: string): ReadinessHoldRow | undefined {
  const row = db.prepare("SELECT * FROM readiness_holds WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? toRow(row) : undefined;
}

/** Closes every open hold for `issueKey` (it became ready, or left the request status). */
export function resolveReadinessHolds(db: Database.Database, issueKey: string, now: string): void {
  db.prepare(
    "UPDATE readiness_holds SET resolved_at = ? WHERE issue_key = ? AND resolved_at IS NULL",
  ).run(now, issueKey);
}

/** Closes open holds for issues a full reconcile pass no longer saw as candidates. */
export function resolveUnseenReadinessHolds(
  db: Database.Database,
  seenIssueKeys: ReadonlySet<string>,
  now: string,
): void {
  for (const hold of listOpenReadinessHolds(db)) {
    if (!seenIssueKeys.has(hold.issueKey)) resolveReadinessHolds(db, hold.issueKey, now);
  }
}

/** Open holds, oldest first — what the admin API lists. */
export function listOpenReadinessHolds(db: Database.Database): ReadinessHoldRow[] {
  const rows = db
    .prepare(
      "SELECT * FROM readiness_holds WHERE resolved_at IS NULL ORDER BY first_seen_at ASC, rowid ASC",
    )
    .all() as Record<string, unknown>[];
  return rows.map(toRow);
}

/** Open holds whose one Jira notice is still owed. */
export function listPendingReadinessNotices(db: Database.Database): ReadinessHoldRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM readiness_holds
       WHERE notice_status = 'pending' AND resolved_at IS NULL
       ORDER BY first_seen_at ASC, rowid ASC`,
    )
    .all() as Record<string, unknown>[];
  return rows.map(toRow);
}

export function markReadinessNotice(
  db: Database.Database,
  id: string,
  status: ReadinessNoticeStatus,
  error: string | null,
): void {
  db.prepare(
    `UPDATE readiness_holds
     SET notice_status = ?, notice_error = ?, notice_tries = notice_tries + 1
     WHERE id = ?`,
  ).run(status, error, id);
}
