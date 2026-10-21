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
 * DECISION-REQUEST comment. A displayed option number maps to its original id using
 * the request's decisionOptions line. Out-of-range numbers are not decisions.
 * Older "Decision: <id>" and free-text replies remain readable.
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
    if (!validNumberReply(comment.body, requestBody)) return false;
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
  const number = replyNumber(reply.body);
  const optionId = number === undefined ? match?.[1] : numberedOptions(requestBody)?.[number - 1];
  return {
    raw: reply.body,
    ...(optionId ? { optionId } : {}),
    ...(expectedDecisionId ? { decisionId: expectedDecisionId } : {}),
    ...(planVersion ? { planVersion } : {}),
  };
}

function replyNumber(body: string): number | undefined {
  const match = body.trim().match(/^([+-]?\d+)\s*(?:번)?$/u);
  return match ? Number(match[1]) : undefined;
}

function numberedOptions(requestBody: string): string[] | undefined {
  const json = requestBody.match(/^decisionOptions: (.+)$/m)?.[1];
  if (!json) return undefined;
  try {
    const options: unknown = JSON.parse(json);
    return Array.isArray(options) && options.every((id) => typeof id === "string" && id.length > 0)
      ? options
      : undefined;
  } catch {
    return undefined;
  }
}

function validNumberReply(body: string, requestBody: string): boolean {
  const number = replyNumber(body);
  if (number === undefined) return true;
  const options = numberedOptions(requestBody);
  // Old requests did not number their options. Preserve their free-text behavior.
  if (!requestBody.includes("\ndecisionOptions:")) return true;
  return options?.[number - 1] !== undefined;
}
