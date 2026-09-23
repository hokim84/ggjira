import type { JiraIssue } from "../../src/jira/types.js";

export function buildTestIssue(overrides: Partial<JiraIssue> & Pick<JiraIssue, "key">): JiraIssue {
  return {
    id: overrides.key,
    summary: "Do the thing",
    description: null,
    statusName: "To Do",
    labels: [],
    assigneeAccountId: null,
    issueTypeName: null,
    parentKey: null,
    projectKey: overrides.key.split("-")[0] ?? null,
    ...overrides,
  };
}
