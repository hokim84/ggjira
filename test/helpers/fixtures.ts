import type { AppConfig } from "../../src/config.js";
import type { JiraIssue } from "../../src/jira/types.js";

export function buildTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    jira: { baseUrl: "https://example.atlassian.net" },
    agent: { identity: "ggjira-implement", role: "implement", machine: "test-machine" },
    workflow: {
      readyStatus: "To Do",
      claimTransitionName: "In Progress",
      doneTransitionName: "In Review",
      failureLabel: "ggjira-failed",
      needsDecisionTransitionName: "Needs Decision",
      plannedTransitionName: null,
    },
    workspace: { path: "/tmp/repo", baseBranch: "main", validateCommand: null },
    provider: {
      type: "claude-code",
      command: "unused-in-these-tests",
      model: "sonnet",
      timeoutMs: 60000,
      claudeCode: { effort: "high", permissionMode: "acceptEdits", allowedTools: [] },
      codex: { sandbox: "workspace-write" },
    },
    pm: {
      subtaskIssueType: "Subtask",
      taskReadyTransitionName: null,
      maxTasksPerPlan: 20,
      implementAssignee: "ggjira-implement@example.com",
    },
    polling: { intervalMs: 60000 },
    ...overrides,
  };
}

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
