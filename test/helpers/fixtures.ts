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
    distribution: { enabled: false },
    ...overrides,
  };
}

/**
 * A v4 AppConfig: the status-based workflow setup writes today (ADR 0015).
 * `buildTestConfig` stays on the legacy transition-name shape so both paths
 * keep their coverage.
 */
export function buildV4Config(overrides: Partial<AppConfig> = {}): AppConfig {
  const base = buildTestConfig({ configVersion: 4, ...overrides });
  return {
    ...base,
    workflow: {
      ...base.workflow,
      implementationStatus: "AI Implementation",
      inProgressStatus: "In Progress",
      reviewStatus: "In Review",
      ...overrides.workflow,
    },
  };
}

/** A profile-mode AppConfig (advanced_plan.md's Agent Profile flow), for tests exercising that path. */
export function buildProfileModeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return buildTestConfig({
    configVersion: 3,
    jira: { baseUrl: "https://example.atlassian.net", projectKey: "KAN" },
    agent: {
      identity: "unity-implement-01",
      role: "implement",
      machine: "1d88f0a2",
      profileKey: "KAN-11",
      machineId: "1d88f0a2-1111-4111-8111-111111111111",
    },
    ...overrides,
  });
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
