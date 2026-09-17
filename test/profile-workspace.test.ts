import { describe, expect, it } from "vitest";
import { FakeJiraGateway } from "../src/jira/fake.js";
import {
  WORKSPACE_SUMMARY,
  createWorkspaceConfig,
  findWorkspaceConfig,
  parseWorkspaceConfig,
} from "../src/profile/workspace.js";
import { WORKSPACE_LABEL } from "../src/profile/types.js";
import type { WorkspaceConfigInput } from "../src/profile/types.js";

const baseInput: WorkspaceConfigInput & { issueTypeName: string } = {
  projectKey: "KAN",
  configVersion: 3,
  ggjiraVersion: "0.1.0",
  issueTypeName: "Task",
  workflow: {
    implementationStatus: "AI Implementation",
    inProgressStatus: "In Progress",
    reviewStatus: "In Review",
    planningStatus: null,
    needsDecisionStatus: null,
    subtaskIssueType: "Subtask",
  },
  projectPolicy: [],
};

describe("createWorkspaceConfig / findWorkspaceConfig", () => {
  it("creates a labeled, unassigned workspace issue when none exists", async () => {
    const jira = new FakeJiraGateway();

    const created = await createWorkspaceConfig(jira, baseInput);

    expect(jira.createdIssues).toHaveLength(1);
    expect(jira.createdIssues[0]?.summary).toBe(WORKSPACE_SUMMARY);
    expect(jira.createdIssues[0]?.labels).toEqual([WORKSPACE_LABEL]);
    expect(jira.assignments).toEqual([{ key: created.issueKey, accountId: null }]);
    expect(created.workflow.implementationStatus).toBe("AI Implementation");
  });

  it("finds and reuses an existing workspace issue instead of creating a new one", async () => {
    const jira = new FakeJiraGateway();
    await createWorkspaceConfig(jira, baseInput);

    const found = await findWorkspaceConfig(jira, "KAN");

    expect(found).not.toBeNull();
    expect(jira.createdIssues).toHaveLength(1);
  });

  it("returns null when no workspace configuration issue exists", async () => {
    const jira = new FakeJiraGateway();
    expect(await findWorkspaceConfig(jira, "KAN")).toBeNull();
  });

  it("uses the first (oldest) issue when more than one workspace configuration exists", async () => {
    const jira = new FakeJiraGateway();
    const first = await createWorkspaceConfig(jira, baseInput);
    await createWorkspaceConfig(jira, { ...baseInput, projectPolicy: ["a different one"] });

    const found = await findWorkspaceConfig(jira, "KAN");

    expect(found?.issueKey).toBe(first.issueKey);
  });

  it("parses the Workflow section back from a created issue's description", async () => {
    const jira = new FakeJiraGateway();
    const created = await createWorkspaceConfig(jira, baseInput);
    const issue = await jira.getIssue(created.issueKey);

    const parsed = parseWorkspaceConfig(issue);

    expect(parsed.workflow).toEqual(baseInput.workflow);
    expect(parsed.projectKey).toBe("KAN");
    expect(parsed.configVersion).toBe(3);
  });

  it("falls back to a placeholder project policy item when none is given", async () => {
    const jira = new FakeJiraGateway();
    const created = await createWorkspaceConfig(jira, baseInput);
    expect(created.projectPolicy.length).toBeGreaterThan(0);
  });

  it("reflects a human's edit to the description on the next parse", async () => {
    const jira = new FakeJiraGateway();
    const created = await createWorkspaceConfig(jira, baseInput);
    const issue = await jira.getIssue(created.issueKey);

    const editedDescription = `${issue.description}\n`.replace(
      "Review Status: In Review",
      "Review Status: 검토 중",
    );
    jira.seedIssue({ ...issue, description: editedDescription });

    const found = await findWorkspaceConfig(jira, "KAN");

    expect(found?.workflow.reviewStatus).toBe("검토 중");
  });
});
