import { describe, expect, it } from "vitest";
import { applyPlan, PlanApplyError } from "../src/pm/apply.js";
import type { Plan } from "../src/pm/plan.js";
import { FakeJiraGateway } from "../src/jira/fake.js";
import { buildTestConfig, buildTestIssue } from "./helpers/fixtures.js";

const IMPLEMENT_USER = {
  accountId: "implement-account-id",
  displayName: "GGJIRA Implement",
  emailAddress: "ggjira-implement@example.com",
};

function basePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    needsDecision: false,
    summary: "plan summary",
    tasks: [{ title: "Task A", description: "Do A", acceptance: ["works"] }],
    keepTaskKeys: [],
    ...overrides,
  };
}

describe("applyPlan", () => {
  it("creates a subtask per plan task, assigned to the resolved implement identity", async () => {
    const jira = new FakeJiraGateway();
    jira.seedUser(IMPLEMENT_USER);
    const parent = buildTestIssue({ key: "KAN-1", projectKey: "KAN" });
    jira.seedIssue(parent);
    const config = buildTestConfig();

    const result = await applyPlan(jira, config, parent, basePlan(), []);

    expect(result.createdKeys).toHaveLength(1);
    expect(jira.createdIssues[0]).toMatchObject({
      projectKey: "KAN",
      issueTypeName: "Subtask",
      summary: "Task A",
      parentKey: "KAN-1",
      assigneeAccountId: IMPLEMENT_USER.accountId,
    });
    expect(jira.createdIssues[0]?.description).toContain("Acceptance criteria");
  });

  it("transitions each created task when pm.taskReadyTransitionName is configured", async () => {
    const jira = new FakeJiraGateway();
    jira.seedUser(IMPLEMENT_USER);
    const parent = buildTestIssue({ key: "KAN-1", projectKey: "KAN" });
    jira.seedIssue(parent);
    const config = buildTestConfig({
      pm: { ...buildTestConfig().pm, taskReadyTransitionName: "Ready for Execution" },
    });

    const result = await applyPlan(jira, config, parent, basePlan(), []);

    expect(jira.transitions).toEqual([
      { key: result.createdKeys[0], transitionName: "Ready for Execution" },
    ]);
  });

  it("throws PlanApplyError when the task count exceeds maxTasksPerPlan", async () => {
    const jira = new FakeJiraGateway();
    jira.seedUser(IMPLEMENT_USER);
    const parent = buildTestIssue({ key: "KAN-1", projectKey: "KAN" });
    jira.seedIssue(parent);
    const config = buildTestConfig({ pm: { ...buildTestConfig().pm, maxTasksPerPlan: 1 } });
    const plan = basePlan({
      tasks: [
        { title: "A", description: "a", acceptance: [] },
        { title: "B", description: "b", acceptance: [] },
      ],
    });

    await expect(applyPlan(jira, config, parent, plan, [])).rejects.toBeInstanceOf(PlanApplyError);
    expect(jira.createdIssues).toHaveLength(0);
  });

  it("supersedes dropped subtasks that are still in the ready status, but keeps in-progress work untouched", async () => {
    const jira = new FakeJiraGateway();
    jira.seedUser(IMPLEMENT_USER);
    const parent = buildTestIssue({ key: "KAN-1", projectKey: "KAN" });
    jira.seedIssue(parent);
    const readyStale = buildTestIssue({ key: "KAN-2", parentKey: "KAN-1", statusName: "To Do" });
    const inProgress = buildTestIssue({
      key: "KAN-3",
      parentKey: "KAN-1",
      statusName: "In Progress",
    });
    const keptReady = buildTestIssue({ key: "KAN-4", parentKey: "KAN-1", statusName: "To Do" });
    jira.seedIssue(readyStale);
    jira.seedIssue(inProgress);
    jira.seedIssue(keptReady);
    const config = buildTestConfig();
    const plan = basePlan({ tasks: [], needsDecision: false, keepTaskKeys: ["KAN-4"] });
    // needsDecision:false with empty tasks would fail Plan's own schema validation elsewhere,
    // but applyPlan itself doesn't re-validate that invariant — it just applies what it's given.

    const result = await applyPlan(jira, config, parent, plan, [readyStale, inProgress, keptReady]);

    expect(result.supersededKeys).toEqual(["KAN-2"]);
    expect(jira.assignments).toEqual([{ key: "KAN-2", accountId: null }]);
    expect(jira.labelChanges).toEqual([
      { key: "KAN-2", label: "ggjira-superseded", action: "add" },
    ]);
  });

  it("throws PlanApplyError when pm.implementAssignee matches no Jira user", async () => {
    const jira = new FakeJiraGateway();
    const parent = buildTestIssue({ key: "KAN-1", projectKey: "KAN" });
    jira.seedIssue(parent);
    const config = buildTestConfig();

    await expect(applyPlan(jira, config, parent, basePlan(), [])).rejects.toBeInstanceOf(
      PlanApplyError,
    );
  });
});
