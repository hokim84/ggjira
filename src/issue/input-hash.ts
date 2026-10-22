import { createHash } from "node:crypto";
import type { IssueRequirements } from "./requirements.js";

/** Every v2 hash starts with this. */
export const INPUT_HASH_V2_PREFIX = "v2:";

/**
 * What an approval approves (ADR 0035): everything a worker is told to do. Kept structural so
 * this module stays pure (no Jira or Router DB types). Deliberately absent: comments (Router's own
 * report comments must never revoke anything), labels (Router adds its failure label), status and
 * assignee (checked on their own, with their own messages).
 */
export interface ExecutionInput {
  kind: "planning" | "implementation" | "quality_review" | "integration_check";
  summary: string;
  description: string | null;
  requirements: IssueRequirements;
  planTask: {
    planVersion: string;
    workspaceId: string;
    taskId: string;
    parentKey: string;
    dependencies: readonly string[];
  } | null;
}

/**
 * Two texts that mean the same to a worker hash the same: line endings (CRLF/CR → LF), Unicode
 * normalization (NFC), trailing spaces on a line, and blank lines before the first or after the
 * last line are not changes. Everything else — wording, inner blank lines, indentation — is.
 */
export function normalizeExecutionText(text: string | null): string {
  if (!text) return "";
  return text
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}

function texts(values: readonly string[]): string[] {
  return values.map(normalizeExecutionText);
}

/** Sets, not sequences: their order carries no meaning, so a reorder is not a change. */
function sortedTexts(values: readonly string[]): string[] {
  return texts(values).sort();
}

/**
 * The canonical form the v2 hash covers. The description is included in full, so anything a
 * human writes outside the GGJIRA sections is covered too; the parsed requirements are listed
 * as well so the canonical form says plainly which contract fields count. Acceptance criteria,
 * verification and the other contract lists keep their order (it is how a human reads them);
 * dependencies are sorted.
 */
export function canonicalExecutionInput(input: ExecutionInput): Record<string, unknown> {
  const { requirements } = input;
  return {
    v: 2,
    kind: input.kind,
    summary: normalizeExecutionText(input.summary),
    description: normalizeExecutionText(input.description),
    requirements: {
      objective: normalizeExecutionText(requirements.objective),
      suggestedExecutionStrategy: normalizeExecutionText(requirements.suggestedExecutionStrategy),
      acceptanceCriteria: texts(requirements.acceptanceCriteria),
      verification: texts(requirements.verification),
      inScope: texts(requirements.inScope),
      outOfScope: texts(requirements.outOfScope),
      affectedAreas: texts(requirements.affectedAreas),
      allowedPaths: texts(requirements.allowedPaths),
      constraints: texts(requirements.constraints),
      dependencies: sortedTexts(requirements.dependencies),
    },
    planTask: input.planTask
      ? {
          planVersion: input.planTask.planVersion,
          workspaceId: input.planTask.workspaceId,
          taskId: input.planTask.taskId,
          parentKey: input.planTask.parentKey,
          dependencies: [...input.planTask.dependencies].sort(),
        }
      : null,
  };
}

export function computeExecutionInputHash(input: ExecutionInput): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(canonicalExecutionInput(input)))
    .digest("hex");
  return `${INPUT_HASH_V2_PREFIX}${digest}`;
}
