import type Database from "better-sqlite3";
import type { RouterConfig } from "./config.js";
import { getApproval } from "./db/approvals.js";
import { resolveAttention } from "./db/attention.js";
import { appendAudit } from "./db/audit.js";
import { getJob } from "./db/jobs.js";
import { insertReportBatch } from "./db/report-steps.js";
import {
  appendReviewRecord,
  getReviewRecord,
  getReviewTarget,
  JUDGMENT_ACTIONS,
  type JudgmentAction,
  judgmentRecordAction,
  listReviewTargets,
  type ReviewRecordRow,
} from "./db/review-targets.js";
import { buildReviewJudgmentSteps, reviewJudgmentBatchId } from "./report-journal.js";

/**
 * A human's judgment on one review target, from the review screen (F01, ADR 0043). It is a record:
 * nothing here moves a Jira status, merges a pull request, creates an approval or reruns anything.
 * A judgment only ever applies to the target that is current for its issue under the issue's
 * current approval; anything older is refused so a past look is never reused for a newer result.
 */

export type JudgmentErrorCode =
  | "unknown_review_target"
  | "stale_review_target"
  | "invalid_judgment";

export class JudgmentError extends Error {
  constructor(
    readonly code: JudgmentErrorCode,
    message: string,
    /** For a stale target: the issue's current target, so the caller can show that one instead. */
    readonly currentTargetId?: string,
  ) {
    super(message);
    this.name = "JudgmentError";
  }
}

export interface JudgeInput {
  targetId: string;
  action: string;
  note?: string;
  /** `admin:<declared name>`: the shared admin token's caller, never a verified identity. */
  actor: string;
  now: string;
}

const NOTE_LIMIT = 2000;

function parseAction(action: string): JudgmentAction {
  if ((JUDGMENT_ACTIONS as readonly string[]).includes(action)) return action as JudgmentAction;
  throw new JudgmentError(
    "invalid_judgment",
    `unknown judgment "${action}" (use ${JUDGMENT_ACTIONS.join(", ")})`,
  );
}

/**
 * Records one judgment. Refusals are audited (`review.judgment.refused`) and thrown; nothing else
 * is written for them.
 */
export function judgeReviewTarget(
  db: Database.Database,
  config: RouterConfig,
  input: JudgeInput,
): ReviewRecordRow {
  try {
    return db.transaction(() => judge(db, config, input))();
  } catch (error) {
    if (!(error instanceof JudgmentError)) throw error;
    // Outside the transaction, which the refusal rolled back.
    appendAudit(db, {
      at: input.now,
      actor: input.actor,
      action: "review.judgment.refused",
      subject: input.targetId,
      detail: {
        requested: input.action,
        error: error.code,
        message: error.message,
        ...(error.currentTargetId ? { currentTargetId: error.currentTargetId } : {}),
      },
    });
    throw error;
  }
}

function judge(db: Database.Database, config: RouterConfig, input: JudgeInput): ReviewRecordRow {
  const action = parseAction(input.action);
  const note = input.note?.trim() ?? "";
  if (action !== "confirm" && !note) {
    throw new JudgmentError("invalid_judgment", `a ${action} needs a note saying why`);
  }
  if (note.length > NOTE_LIMIT) {
    throw new JudgmentError("invalid_judgment", `the note is longer than ${NOTE_LIMIT} characters`);
  }
  const target = getReviewTarget(db, input.targetId);
  if (!target) {
    throw new JudgmentError("unknown_review_target", `no review target "${input.targetId}"`);
  }
  if (target.finalState === "cancelled") {
    throw new JudgmentError("stale_review_target", "a cancelled run is not a review target");
  }
  if (target.supersededBy) {
    const current = listReviewTargets(db, target.issueKey)[0];
    throw new JudgmentError(
      "stale_review_target",
      `a newer result exists for ${target.issueKey}; judge that one instead`,
      current?.id,
    );
  }
  const approval = getApproval(db, target.issueKey);
  if (approval && approval.approvalId !== target.approvalId) {
    throw new JudgmentError(
      "stale_review_target",
      `${target.issueKey} was approved again after this run; its result no longer stands for the current request`,
    );
  }

  appendReviewRecord(db, {
    targetId: target.id,
    issueKey: target.issueKey,
    action: judgmentRecordAction(action),
    actor: input.actor,
    authentication: "admin-token",
    headSha: target.headSha,
    outcome: "matched",
    detail: {
      attemptId: target.attemptId,
      commitState: target.commitState,
      ...(note ? { note } : {}),
    },
    at: input.now,
  });
  const recordId = (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;

  if (action === "confirm") {
    resolveAttention(db, {
      issueKey: target.issueKey,
      kinds: ["review_required"],
      resolution: `review confirmed by ${input.actor}`,
      now: input.now,
    });
  } else {
    const job = getJob(db, target.jobId);
    const workspace = job && config.workspaces.find((entry) => entry.id === job.workspaceId);
    if (job && workspace) {
      insertReportBatch(db, {
        batchId: reviewJudgmentBatchId(recordId),
        jobId: job.id,
        attemptId: target.attemptId,
        issueKey: target.issueKey,
        steps: buildReviewJudgmentSteps({
          job,
          workspace,
          action,
          attemptId: target.attemptId,
          headSha: target.headSha,
          actor: input.actor,
          note,
          language: config.reporting.language,
        }),
        now: input.now,
      });
    }
  }
  appendAudit(db, {
    at: input.now,
    actor: input.actor,
    action: `review.judgment.${action}`,
    subject: target.issueKey,
    detail: {
      targetId: target.id,
      attemptId: target.attemptId,
      headSha: target.headSha,
      authentication: "admin-token",
      ...(note ? { note } : {}),
    },
  });
  return getReviewRecord(db, recordId) as ReviewRecordRow;
}
