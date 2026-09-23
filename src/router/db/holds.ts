import type Database from "better-sqlite3";

/** Records that an admin cancelled the job running under this approval (migration 4). */
export function recordAdminHold(
  db: Database.Database,
  input: { issueKey: string; approvalId: string; jobId: string; actor: string; now: string },
): void {
  db.prepare(
    `INSERT OR REPLACE INTO admin_holds (issue_key, approval_id, job_id, actor, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(input.issueKey, input.approvalId, input.jobId, input.actor, input.now);
}

/** Whether an admin cancelled this exact approval. A re-approval in Jira gets a new approval id,
 *  so it is never held by an earlier cancel. */
export function isApprovalHeld(
  db: Database.Database,
  issueKey: string,
  approvalId: string,
): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM admin_holds WHERE issue_key = ? AND approval_id = ?")
      .get(issueKey, approvalId),
  );
}
