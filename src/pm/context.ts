import type { JiraComment, JiraIssue } from "../jira/types.js";
import { DECISION_REQUEST_MARKER } from "./marker.js";

export interface HumanDecision {
  raw: string;
  optionId?: string;
}

/**
 * Finds the human's reply to the most recent decision-request comment: the
 * first comment by someone other than this agent, after the last
 * DECISION-REQUEST comment. Looks for "Decision: <id>" (case-insensitive) to
 * extract a structured option id; falls back to the raw text otherwise so a
 * free-text reply is never silently dropped.
 */
export function findHumanDecision(
  comments: JiraComment[],
  selfAccountId: string,
): HumanDecision | undefined {
  let lastRequestIndex = -1;
  for (let i = comments.length - 1; i >= 0; i--) {
    if (comments[i]?.body.includes(DECISION_REQUEST_MARKER)) {
      lastRequestIndex = i;
      break;
    }
  }
  if (lastRequestIndex === -1) return undefined;

  const reply = comments
    .slice(lastRequestIndex + 1)
    .find((c) => c.authorAccountId !== selfAccountId);
  if (!reply) return undefined;

  const match = reply.body.match(/decision\s*:\s*([A-Za-z0-9._-]+)/i);
  const optionId = match?.[1];
  return { raw: reply.body, ...(optionId ? { optionId } : {}) };
}

export interface PlanningContext {
  issue: JiraIssue;
  comments: JiraComment[];
  existingSubtasks: JiraIssue[];
  humanDecision?: HumanDecision;
}

/** Assembles everything a planning/replanning prompt needs from Jira state. */
export function buildPlanningContext(
  issue: JiraIssue,
  comments: JiraComment[],
  existingSubtasks: JiraIssue[],
  selfAccountId: string,
): PlanningContext {
  const humanDecision = findHumanDecision(comments, selfAccountId);
  return {
    issue,
    comments,
    existingSubtasks,
    ...(humanDecision ? { humanDecision } : {}),
  };
}
