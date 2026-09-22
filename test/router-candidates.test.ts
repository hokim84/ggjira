import { describe, expect, it } from "vitest";
import { FakeJiraGateway } from "../src/jira/fake.js";
import type { WorkspaceConfig } from "../src/router/config.js";
import { buildWorkspaceJql, findWorkspaceCandidates } from "../src/router/candidates.js";

const workspace: WorkspaceConfig = {
  id: "ws1",
  repositoryId: "repo1",
  projectKeys: ["KAN"],
  workflow: {
    requestStatus: "AI 작업 요청",
    inProgressStatus: "작업 중",
    reviewStatus: "AI 작업 완료",
  },
};

describe("buildWorkspaceJql", () => {
  it("queries only requestStatus when no planningStatus is configured", () => {
    expect(buildWorkspaceJql(workspace)).toBe(
      'project in ("KAN") AND status in ("AI 작업 요청") ORDER BY created ASC',
    );
  });

  it("includes planningStatus when configured", () => {
    const withPlanning: WorkspaceConfig = {
      ...workspace,
      workflow: { ...workspace.workflow, planningStatus: "AI 계획 요청" },
    };
    expect(buildWorkspaceJql(withPlanning)).toBe(
      'project in ("KAN") AND status in ("AI 작업 요청", "AI 계획 요청") ORDER BY created ASC',
    );
  });

  it("lists every project key configured for the workspace", () => {
    const multiProject: WorkspaceConfig = { ...workspace, projectKeys: ["KAN", "OPS"] };
    expect(buildWorkspaceJql(multiProject)).toBe(
      'project in ("KAN", "OPS") AND status in ("AI 작업 요청") ORDER BY created ASC',
    );
  });
});

describe("findWorkspaceCandidates", () => {
  it("returns issues in the workspace's requestStatus", async () => {
    const jira = new FakeJiraGateway();
    jira.seedIssue({ key: "KAN-1", statusName: "AI 작업 요청", projectKey: "KAN" });
    jira.seedIssue({ key: "KAN-2", statusName: "작업 중", projectKey: "KAN" });

    const candidates = await findWorkspaceCandidates(jira, workspace);

    expect(candidates.map((issue) => issue.key)).toEqual(["KAN-1"]);
  });

  it("excludes GGJIRA meta issues even when their status matches", async () => {
    const jira = new FakeJiraGateway();
    jira.seedIssue({
      key: "KAN-1",
      statusName: "AI 작업 요청",
      projectKey: "KAN",
      labels: ["ggjira-agent"],
    });
    jira.seedIssue({ key: "KAN-2", statusName: "AI 작업 요청", projectKey: "KAN" });

    const candidates = await findWorkspaceCandidates(jira, workspace);

    expect(candidates.map((issue) => issue.key)).toEqual(["KAN-2"]);
  });

  it("excludes issues from projects outside the workspace", async () => {
    const jira = new FakeJiraGateway();
    jira.seedIssue({ key: "OPS-1", statusName: "AI 작업 요청", projectKey: "OPS" });

    const candidates = await findWorkspaceCandidates(jira, workspace);

    expect(candidates).toEqual([]);
  });
});
