import type { AppConfig } from "../config.js";
import type { JiraGateway } from "../jira/gateway.js";
import type { JiraIssue } from "../jira/types.js";
import type { Logger } from "../logger.js";
import { buildStartComment } from "../reporter/reporter.js";

/**
 * Thrown when the issue could no longer be claimed: either it had already
 * moved off the ready status by the time we re-fetched it, or the claim
 * transition itself was rejected (the same signal in practice, since a
 * rejected transition here means Jira's current transitions for the issue no
 * longer include ours — i.e. something else already moved it). This is not a
 * failure: another agent or a human simply got there first (architecture.md:
 * "claim 실패 = 다른 주체가 이미 처리 → skip").
 */
export class ClaimLostError extends Error {
  constructor(
    readonly issueKey: string,
    readonly actualStatus: string,
    /**
     * The transition rejection that triggered this, when there was one (vs.
     * a plain re-fetch showing the status already moved). A repeated
     * `TransitionNotFoundError` here — same issue, every attempt — means
     * `workflow.claimTransitionName` doesn't match a real Jira transition
     * name, not an actual claim race (runbook.md §8).
     */
    readonly cause?: unknown,
  ) {
    super(
      `${issueKey} could not be claimed (current status "${actualStatus}") — another agent or a human likely handled it first.`,
      cause !== undefined ? { cause } : undefined,
    );
    this.name = "ClaimLostError";
  }
}

/**
 * Claims an issue for this agent: `claimJob` (phase 2 §5.4). Re-checks the
 * issue is still in the ready state (narrows the race window against another
 * agent polling concurrently), transitions it, then posts a start comment.
 * The transition succeeding is the actual claim mechanism — no distributed
 * lock is used, matching the phase 2 decision to keep claiming as simple as
 * a Jira workflow transition.
 */
export async function claimJob(
  jira: JiraGateway,
  config: AppConfig,
  issue: JiraIssue,
  runId: string,
  logger?: Logger,
): Promise<void> {
  const fresh = await jira.getIssue(issue.key);
  if (fresh.statusName !== config.workflow.readyStatus) {
    throw new ClaimLostError(issue.key, fresh.statusName);
  }

  try {
    await jira.transitionIssue(issue.key, config.workflow.claimTransitionName);
  } catch (error) {
    throw new ClaimLostError(issue.key, fresh.statusName, error);
  }

  try {
    await jira.addComment(issue.key, buildStartComment(runId, config));
  } catch (error) {
    logger?.warn({ err: error }, "claimed the issue but failed to post the start comment");
  }
}
