import type Database from "better-sqlite3";

/** Require the latest reviewed head AND its actual merge commit, including squash merges. */
export function integrationEvidence(
  db: Database.Database,
  issueKey: string,
  baseBranch: string,
): { mergeSha: string; resultId: string } | undefined {
  return db
    .prepare(`SELECT p.merge_sha AS mergeSha, t.id AS resultId FROM pull_requests p
    JOIN review_targets t ON t.attempt_id=p.attempt_id
    WHERE p.issue_key=? AND p.state='merged' AND p.target_branch=?
      AND p.merge_sha IS NOT NULL AND p.reviewed_head=t.head_sha
      AND t.superseded_by IS NULL AND t.final_state='succeeded'
    ORDER BY p.updated_at DESC LIMIT 1`)
    .get(issueKey, baseBranch) as { mergeSha: string; resultId: string } | undefined;
}
