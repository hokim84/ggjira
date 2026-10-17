import type { JiraIssue } from "../jira/types.js";
import { getItems, getScalar, parseSections } from "./description.js";
import { normalizeCapabilities } from "./capability.js";

export interface IssueRequirements {
  objective: string;
  acceptanceCriteria: string[];
  dependencies: string[];
  constraints: string[];
  requiredCapabilities: string[];
  suggestedExecutionStrategy: string | null;
  /** The scope contract (ADR 0034). Read the same way for human-written and PM-created issues. */
  verification: string[];
  inScope: string[];
  outOfScope: string[];
  /** Where the change is expected to land — a hint for the implementer, never enforced. */
  affectedAreas: string[];
  /** Globs the implementation may touch; enforced by the worker only when non-empty. */
  allowedPaths: string[];
}

export function readIssueRequirements(issue: JiraIssue): IssueRequirements {
  const sections = parseSections(issue.description ?? "");
  return {
    objective: getScalar(sections, "GGJIRA Plan", "Objective") ?? issue.summary,
    acceptanceCriteria: getItems(sections, "Acceptance Criteria"),
    dependencies: getItems(sections, "Dependencies"),
    constraints: getItems(sections, "Constraints"),
    requiredCapabilities: normalizeCapabilities(getItems(sections, "Required Capabilities")),
    suggestedExecutionStrategy: getScalar(sections, "GGJIRA Plan", "Suggested Execution Strategy"),
    verification: getItems(sections, "Verification"),
    inScope: getItems(sections, "In Scope"),
    outOfScope: getItems(sections, "Out of Scope"),
    affectedAreas: getItems(sections, "Affected Areas"),
    allowedPaths: getItems(sections, "Allowed Paths"),
  };
}
