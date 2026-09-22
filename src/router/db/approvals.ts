import type Database from "better-sqlite3";

export interface ApprovalRow {
  issueKey: string;
  approvalId: string;
  inputHash: string;
  inputSnapshot: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertApprovalInput {
  issueKey: string;
  approvalId: string;
  inputHash: string;
  inputSnapshot: unknown;
  /** ISO timestamp. Caller-supplied so tests can use a fake clock. */
  now: string;
}

function toApprovalRow(row: Record<string, unknown>): ApprovalRow {
  return {
    issueKey: row.issue_key as string,
    approvalId: row.approval_id as string,
    inputHash: row.input_hash as string,
    inputSnapshot: JSON.parse(row.input_snapshot as string),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function getApproval(db: Database.Database, issueKey: string): ApprovalRow | undefined {
  const row = db.prepare("SELECT * FROM approvals WHERE issue_key = ?").get(issueKey) as
    | Record<string, unknown>
    | undefined;
  return row ? toApprovalRow(row) : undefined;
}

/** Insert-or-replace: one row per issue (§3 "이슈별 승인 식별자·작업 입력 스냅샷"). Callers
 *  compare the returned/previous `approvalId`/`inputHash` themselves to decide whether
 *  anything actually changed — this function always writes the latest values. */
export function upsertApproval(db: Database.Database, input: UpsertApprovalInput): ApprovalRow {
  const existing = getApproval(db, input.issueKey);
  const createdAt = existing?.createdAt ?? input.now;
  db.prepare(
    `INSERT INTO approvals (issue_key, approval_id, input_hash, input_snapshot, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (issue_key) DO UPDATE SET
       approval_id = excluded.approval_id,
       input_hash = excluded.input_hash,
       input_snapshot = excluded.input_snapshot,
       updated_at = excluded.updated_at`,
  ).run(
    input.issueKey,
    input.approvalId,
    input.inputHash,
    JSON.stringify(input.inputSnapshot),
    createdAt,
    input.now,
  );
  const approval = getApproval(db, input.issueKey);
  if (!approval) {
    throw new Error(`upsertApproval: row for ${input.issueKey} not found immediately after upsert`);
  }
  return approval;
}
