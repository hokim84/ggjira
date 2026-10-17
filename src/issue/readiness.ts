import type { IssueRequirements } from "./requirements.js";

/** What an implementation request must carry before a worker may start it (ADR 0034). */
export type ReadinessGap = "acceptance" | "verification";

export interface ReadinessCheck {
  ready: boolean;
  missing: ReadinessGap[];
}

/**
 * An implementation request is ready only when it says what "done" means (Acceptance Criteria)
 * and how to check it (Verification). This is a presence check, not a judgement of quality: the
 * PM prompt and the human reviewer own whether the contract is any good. Planning requests are
 * never checked — analysing and completing an incomplete request is what planning is for.
 */
export function checkImplementationReadiness(requirements: IssueRequirements): ReadinessCheck {
  const missing: ReadinessGap[] = [];
  if (requirements.acceptanceCriteria.length === 0) missing.push("acceptance");
  if (requirements.verification.length === 0) missing.push("verification");
  return { ready: missing.length === 0, missing };
}
