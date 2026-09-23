import type { JiraComment } from "../jira/types.js";
import { DECISION_REQUEST_MARKER } from "./marker.js";

export interface HumanDecision {
  raw: string;
  optionId?: string;
  decisionId?: string;
  planVersion?: string;
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
  ownerAccountId?: string | null,
): HumanDecision | undefined {
  let lastRequestIndex = -1;
  for (let i = comments.length - 1; i >= 0; i--) {
    if (comments[i]?.body.includes(DECISION_REQUEST_MARKER)) {
      lastRequestIndex = i;
      break;
    }
  }
  if (lastRequestIndex === -1) return undefined;

  const requestBody = comments[lastRequestIndex]?.body ?? "";
  const expectedDecisionId = requestBody.match(/^decisionId:\s*(\S+)$/im)?.[1];
  const planVersion = requestBody.match(/^planVersion:\s*(\S+)$/im)?.[1];
  const reply = comments.slice(lastRequestIndex + 1).find((comment) => {
    const isHuman =
      comment.authorAccountId !== selfAccountId ||
      (ownerAccountId !== null && comment.authorAccountId === ownerAccountId);
    if (!isHuman) return false;
    if (!expectedDecisionId) return true;
    // A plain "Decision: A" reply with no decisionId line is still accepted -- it's already
    // scoped to comments after the latest request, so nothing else could be answering. Only an
    // explicit, *different* decisionId marks a reply as stale (answering an older request whose
    // comments happen to sit in this same range).
    const repliedDecisionId = comment.body.match(/^decisionId:\s*(\S+)$/im)?.[1];
    return !repliedDecisionId || repliedDecisionId === expectedDecisionId;
  });
  if (!reply) return undefined;

  const match = reply.body.match(/decision\s*:\s*([A-Za-z0-9._-]+)/i);
  const optionId = match?.[1];
  return {
    raw: reply.body,
    ...(optionId ? { optionId } : {}),
    ...(expectedDecisionId ? { decisionId: expectedDecisionId } : {}),
    ...(planVersion ? { planVersion } : {}),
  };
}
