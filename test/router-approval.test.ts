import { describe, expect, it } from "vitest";
import type { IssueRequirements } from "../src/agent/requirements.js";
import { FakeJiraGateway } from "../src/jira/fake.js";
import type { PlanTaskMetadata } from "../src/pm/metadata.js";
import { computeApprovalId, computeInputHash } from "../src/router/approval.js";

const REQUEST_STATUS = "AI 작업 요청";

describe("computeApprovalId", () => {
  it("falls back to a per-issue sentinel when the issue was created straight into requestStatus", async () => {
    const jira = new FakeJiraGateway();
    jira.seedIssue({ key: "KAN-1", statusName: REQUEST_STATUS });

    const approvalId = await computeApprovalId(jira, await jira.getIssue("KAN-1"), REQUEST_STATUS);

    expect(approvalId).toBe("created:KAN-1");
  });

  it("uses the changelog entry that moved the issue into requestStatus", async () => {
    const jira = new FakeJiraGateway();
    jira.seedIssue({ key: "KAN-1", statusName: "To Do" }, [
      { id: "1", name: "Request", toStatusName: REQUEST_STATUS },
    ]);
    await jira.transitionIssueToStatus("KAN-1", REQUEST_STATUS);

    const approvalId = await computeApprovalId(jira, await jira.getIssue("KAN-1"), REQUEST_STATUS);

    const changelog = await jira.getIssueChangelog("KAN-1");
    expect(approvalId).toBe(changelog[0]?.id);
  });

  it("uses the most recent entry into requestStatus after a revoke-then-reapprove", async () => {
    const jira = new FakeJiraGateway();
    jira.seedIssue({ key: "KAN-1", statusName: "To Do" }, [
      { id: "1", name: "Request", toStatusName: REQUEST_STATUS },
      { id: "2", name: "Revoke", toStatusName: "To Do" },
      { id: "3", name: "Request again", toStatusName: REQUEST_STATUS },
    ]);

    await jira.transitionIssueToStatus("KAN-1", REQUEST_STATUS);
    const firstApprovalId = await computeApprovalId(
      jira,
      await jira.getIssue("KAN-1"),
      REQUEST_STATUS,
    );

    await jira.transitionIssueToStatus("KAN-1", "To Do");
    await jira.transitionIssueToStatus("KAN-1", REQUEST_STATUS);
    const secondApprovalId = await computeApprovalId(
      jira,
      await jira.getIssue("KAN-1"),
      REQUEST_STATUS,
    );

    expect(secondApprovalId).not.toBe(firstApprovalId);
  });
});

function requirements(overrides: Partial<IssueRequirements> = {}): IssueRequirements {
  return {
    objective: "Do the thing",
    acceptanceCriteria: ["It works"],
    dependencies: [],
    constraints: [],
    requiredCapabilities: ["programming"],
    suggestedExecutionStrategy: null,
    ...overrides,
  };
}

describe("computeInputHash", () => {
  it("is stable for the same requirements and plan task", () => {
    const planTask: PlanTaskMetadata = {
      planVersion: "v1",
      taskId: "t1",
      parentKey: "KAN-0",
      workspaceId: "ws1",
      dependencies: [],
    };
    expect(computeInputHash(requirements(), planTask)).toBe(
      computeInputHash(requirements(), planTask),
    );
  });

  it("does not depend on dependency array order", () => {
    const a = requirements({ dependencies: ["KAN-1", "KAN-2"] });
    const b = requirements({ dependencies: ["KAN-2", "KAN-1"] });
    expect(computeInputHash(a, null)).toBe(computeInputHash(b, null));
  });

  it("changes when required capabilities change", () => {
    const a = requirements({ requiredCapabilities: ["programming"] });
    const b = requirements({ requiredCapabilities: ["programming", "testing"] });
    expect(computeInputHash(a, null)).not.toBe(computeInputHash(b, null));
  });

  it("changes when the plan version changes", () => {
    const planTaskV1: PlanTaskMetadata = {
      planVersion: "v1",
      taskId: "t1",
      parentKey: "KAN-0",
      workspaceId: "ws1",
      dependencies: [],
    };
    const planTaskV2: PlanTaskMetadata = { ...planTaskV1, planVersion: "v2" };
    expect(computeInputHash(requirements(), planTaskV1)).not.toBe(
      computeInputHash(requirements(), planTaskV2),
    );
  });
});
