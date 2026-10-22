import type { QualityContext } from "../contracts/quality.js";
import type { ValidateResult } from "./validate.js";

export function buildReviewSystemPrompt(): string {
  return "Review the integrated result read-only. Never edit, commit, push or merge. Report evidence and uncertainties. Do not use numerical debt scores. Distinguish defects, new debt, directly relevant existing debt, environment failures and missing evidence. Each finding needs a complete, independently executable remediation contract. Recheck previous findings and affected integration; do not recursively invent repository-wide cleanup.";
}

export function buildReviewPrompt(
  context: QualityContext,
  targetSha: string,
  baselineSha: string,
  trustedValidation: ValidateResult,
): string {
  return JSON.stringify({ ...context, targetSha, baselineSha, trustedValidation });
}
