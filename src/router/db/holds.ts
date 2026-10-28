import type { RouterDatabase } from "./connection.js";

/** Records that an admin cancelled the job running under this approval (migration 4). */
export function recordAdminHold(
  db: RouterDatabase,
  input: { issueKey: string; approvalId: string; jobId: string; actor: string; now: string },
): void {
  db.prepare(
    `INSERT OR REPLACE INTO admin_holds (issue_key, approval_id, job_id, actor, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(input.issueKey, input.approvalId, input.jobId, input.actor, input.now);
}

/** Whether an admin cancelled this exact approval. A re-approval in Jira gets a new approval id,
 *  so it is never held by an earlier cancel. */
export function isApprovalHeld(db: RouterDatabase, issueKey: string, approvalId: string): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM admin_holds WHERE issue_key = ? AND approval_id = ?")
      .get(issueKey, approvalId),
  );
}

/** The actor `admin_holds` records when Router itself holds an approval because what it approved
 *  was edited (ADR 0035), as opposed to an admin's `jobs cancel`. */
export const INPUTS_CHANGED_HOLD_ACTOR = "router:inputs-changed";

/** Who holds this approval, if anyone: an admin actor or `INPUTS_CHANGED_HOLD_ACTOR`. */
export function getApprovalHoldActor(
  db: RouterDatabase,
  issueKey: string,
  approvalId: string,
): string | undefined {
  const row = db
    .prepare("SELECT actor FROM admin_holds WHERE issue_key = ? AND approval_id = ?")
    .get(issueKey, approvalId) as { actor: string } | undefined;
  return row?.actor;
}
