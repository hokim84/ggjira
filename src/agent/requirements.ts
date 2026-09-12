import type { JiraIssue } from "../jira/types.js";
import { getItems, getScalar, parseSections } from "../profile/description.js";
import { normalizeCapabilities } from "./capability.js";

export interface IssueRequirements {
  objective: string;
  acceptanceCriteria: string[];
  dependencies: string[];
  constraints: string[];
  requiredCapabilities: string[];
  suggestedExecutionStrategy: string | null;
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
  };
}
