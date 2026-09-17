import { describe, expect, it } from "vitest";
import { FakeJiraGateway } from "../src/jira/fake.js";
import { PlanApplyError, applyPlan } from "../src/pm/apply.js";
import { PLAN_PROPERTY_KEY, PLAN_TASK_PROPERTY_KEY } from "../src/pm/metadata.js";
import type { Plan } from "../src/pm/plan.js";
import {
  claimAgentProfile,
  createAgentProfile,
  findAgentProfiles,
} from "../src/profile/profile.js";
import type { AgentProfile } from "../src/profile/types.js";
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
    agentProfiles: [],
    disableAgentIds: [],
    ...overrides,
  };
}

describe("applyPlan", () => {
  it("stores versioned plan/task metadata for human distribution", async () => {
    const jira = new FakeJiraGateway();
    const parent = buildTestIssue({ key: "KAN-1", projectKey: "KAN", statusName: "Planning" });
    jira.seedIssue(parent);
    const config = buildTestConfig({
      configVersion: 4,
      workflow: {
        ...buildTestConfig().workflow,
        planningStatus: "Planning",
        planningInProgressStatus: "Planning In Progress",
        planReviewStatus: "Plan Review",
        executionApprovedStatus: "Execution Approved",
        taskWaitingStatus: "To Do",
        implementationStatus: "AI Implementation",
        inProgressStatus: "In Progress",
        reviewStatus: "In Review",
      },
      distribution: {
        enabled: true,
        executionAgentFieldId: "customfield_12345",
        workspaceId: "workspace-a",
      },
    });

    const result = await applyPlan(
      jira,
      config,
      parent,
      basePlan({
        tasks: [
          { taskId: "foundation", title: "Foundation", description: "Build base", acceptance: [] },
          {
            taskId: "feature",
            title: "Feature",
            description: "Build feature",
            acceptance: [],
            dependencies: ["foundation"],
          },
        ],
      }),
      [],
      undefined,
      undefined,
      "v1",
    );

    expect(jira.getStoredProperty("KAN-1", PLAN_PROPERTY_KEY)).toEqual({
      version: "v1",
      status: "review",
      taskIds: ["foundation", "feature"],
    });
    expect(jira.getStoredProperty(result.createdKeys[0] as string, PLAN_TASK_PROPERTY_KEY)).toEqual(
      {
        planVersion: "v1",
        taskId: "foundation",
        parentKey: "KAN-1",
        workspaceId: "workspace-a",
        dependencies: [],
      },
    );
    expect(jira.getStoredProperty(result.createdKeys[1] as string, PLAN_TASK_PROPERTY_KEY)).toEqual(
      {
        planVersion: "v1",
        taskId: "feature",
        parentKey: "KAN-1",
        workspaceId: "workspace-a",
        dependencies: [result.createdKeys[0]],
      },
    );
    expect((await jira.getIssue(result.createdKeys[1] as string)).description).toContain(
      result.createdKeys[0],
    );
    expect(jira.createdIssues[0]?.assigneeAccountId).toBeUndefined();
  });

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

  it("rejects cyclic taskId dependencies before creating partial Jira tasks", async () => {
    const jira = new FakeJiraGateway();
    const parent = buildTestIssue({ key: "KAN-1", projectKey: "KAN" });
    jira.seedIssue(parent);
    const config = buildTestConfig({
      configVersion: 4,
      workflow: {
        ...buildTestConfig().workflow,
        planningStatus: "Planning",
        planningInProgressStatus: "Planning In Progress",
        planReviewStatus: "Plan Review",
        executionApprovedStatus: "Execution Approved",
        taskWaitingStatus: "Waiting",
        implementationStatus: "AI Implementation",
        inProgressStatus: "In Progress",
        reviewStatus: "In Review",
      },
      distribution: {
        enabled: true,
        executionAgentFieldId: "customfield_12345",
        workspaceId: "workspace-a",
      },
    });
    const plan = basePlan({
      tasks: [
        { taskId: "a", title: "A", description: "a", acceptance: [], dependencies: ["b"] },
        { taskId: "b", title: "B", description: "b", acceptance: [], dependencies: ["a"] },
      ],
    });

    await expect(applyPlan(jira, config, parent, plan, [])).rejects.toThrow("dependency cycle");
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

  function buildDistributionConfig() {
    return buildTestConfig({
      configVersion: 4,
      workflow: {
        ...buildTestConfig().workflow,
        planningStatus: "Planning",
        planningInProgressStatus: "Planning In Progress",
        planReviewStatus: "Plan Review",
        executionApprovedStatus: "Execution Approved",
        taskWaitingStatus: "Waiting for Assignment",
        implementationStatus: "AI Implementation",
        inProgressStatus: "In Progress",
        reviewStatus: "In Review",
      },
      distribution: {
        enabled: true,
        executionAgentFieldId: "customfield_12345",
        workspaceId: "workspace-a",
      },
    });
  }

  it("supersedes a dropped subtask sitting at taskWaitingStatus, even though it never reached workflow.readyStatus", async () => {
    const jira = new FakeJiraGateway();
    const parent = buildTestIssue({ key: "KAN-1", projectKey: "KAN", statusName: "Planning" });
    jira.seedIssue(parent);
    // Distribution mode parks a fresh task at taskWaitingStatus ("Waiting for Assignment"), never
    // workflow.readyStatus ("To Do") -- a supersede check pinned to readyStatus would never fire.
    const waitingStale = buildTestIssue({
      key: "KAN-2",
      parentKey: "KAN-1",
      statusName: "Waiting for Assignment",
    });
    const inProgress = buildTestIssue({
      key: "KAN-3",
      parentKey: "KAN-1",
      statusName: "In Progress",
    });
    jira.seedIssue(waitingStale);
    jira.seedIssue(inProgress);
    const config = buildDistributionConfig();
    const plan = basePlan({ tasks: [], needsDecision: false, keepTaskKeys: [] });

    const result = await applyPlan(jira, config, parent, plan, [waitingStale, inProgress]);

    expect(result.supersededKeys).toEqual(["KAN-2"]);
  });

  it("re-stamps a kept task's plan-task metadata to the new planVersion on replan", async () => {
    const jira = new FakeJiraGateway();
    const parent = buildTestIssue({ key: "KAN-1", projectKey: "KAN", statusName: "Planning" });
    jira.seedIssue(parent);
    const kept = buildTestIssue({
      key: "KAN-2",
      parentKey: "KAN-1",
      statusName: "Waiting for Assignment",
    });
    jira.seedIssue(kept);
    await jira.setIssueProperty(kept.key, PLAN_TASK_PROPERTY_KEY, {
      planVersion: "v1",
      taskId: "foundation",
      parentKey: "KAN-1",
      workspaceId: "workspace-a",
      dependencies: [],
    });
    // taskWaitingStatus matches FakeJiraGateway's default creation status ("To Do") so the newly
    // created "feature" task doesn't need a seeded transition -- unrelated to what this test
    // covers (the *kept* task's metadata, not the new task's post-creation transition).
    const config = buildDistributionConfig();
    config.workflow.taskWaitingStatus = "To Do";
    const plan = basePlan({
      tasks: [
        {
          taskId: "feature",
          title: "Feature",
          description: "Build feature",
          acceptance: [],
          dependencies: ["KAN-2"],
        },
      ],
      keepTaskKeys: ["KAN-2"],
    });

    await applyPlan(jira, config, parent, plan, [kept], undefined, undefined, "v2");

    // Left at "v1", KAN-2 would fail its version check at execution time against the parent's
    // new "v2" plan property (agent/runtime.ts), even though the board still shows it approved.
    expect(jira.getStoredProperty("KAN-2", PLAN_TASK_PROPERTY_KEY)).toEqual({
      planVersion: "v2",
      taskId: "foundation",
      parentKey: "KAN-1",
      workspaceId: "workspace-a",
      dependencies: [],
    });
    expect(jira.getStoredProperty("KAN-1", PLAN_PROPERTY_KEY)).toMatchObject({
      version: "v2",
      taskIds: expect.arrayContaining(["feature", "foundation"]),
    });
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

  describe("agent routing (profile mode)", () => {
    async function makeRegisteredAgent(
      jira: FakeJiraGateway,
      agentId: string,
      machineId: string,
    ): Promise<AgentProfile> {
      const profile = await createAgentProfile(jira, {
        projectKey: "KAN",
        issueTypeName: "Task",
        agentId,
        displayName: agentId,
        role: "implement",
        preset: null,
        capabilities: [],
        workStyle: [],
        humanInstructions: [],
      });
      await claimAgentProfile(jira, profile, machineId, { settleMs: 0 });
      const roster = await findAgentProfiles(jira, "KAN");
      const registered = roster.find((a) => a.agentId === agentId);
      if (!registered) throw new Error("test setup failed: agent not found after claim");
      return registered;
    }

    it("routes a task to its requested assigneeAgentId when that agent is routable", async () => {
      const jira = new FakeJiraGateway();
      jira.setSelf({ accountId: "pm-account", displayName: "PM", emailAddress: null });
      const parent = buildTestIssue({ key: "KAN-1", projectKey: "KAN" });
      jira.seedIssue(parent);
      const agentA = await makeRegisteredAgent(jira, "agent-a", "machine-a");
      const agentB = await makeRegisteredAgent(jira, "agent-b", "machine-b");
      const roster = [agentA, agentB];
      const config = buildTestConfig();
      const plan = basePlan({
        tasks: [{ title: "T", description: "D", acceptance: [], assigneeAgentId: "agent-b" }],
      });

      await applyPlan(jira, config, parent, plan, [], roster);

      expect(jira.createdIssues.at(-1)?.assigneeAccountId).toBe(agentB.registration?.jiraAccountId);
    });

    it("falls back to the first routable implement agent when no assigneeAgentId is given", async () => {
      const jira = new FakeJiraGateway();
      jira.setSelf({ accountId: "pm-account", displayName: "PM", emailAddress: null });
      const parent = buildTestIssue({ key: "KAN-1", projectKey: "KAN" });
      jira.seedIssue(parent);
      const agentA = await makeRegisteredAgent(jira, "agent-a", "machine-a");
      const roster = [agentA];
      const config = buildTestConfig();

      await applyPlan(jira, config, parent, basePlan(), [], roster);

      expect(jira.createdIssues.at(-1)?.assigneeAccountId).toBe(agentA.registration?.jiraAccountId);
    });

    it("falls back to the roster default when the requested assigneeAgentId is unregistered or unknown", async () => {
      const jira = new FakeJiraGateway();
      jira.setSelf({ accountId: "pm-account", displayName: "PM", emailAddress: null });
      const parent = buildTestIssue({ key: "KAN-1", projectKey: "KAN" });
      jira.seedIssue(parent);
      const agentA = await makeRegisteredAgent(jira, "agent-a", "machine-a");
      const roster = [agentA];
      const config = buildTestConfig();
      const plan = basePlan({
        tasks: [
          { title: "T", description: "D", acceptance: [], assigneeAgentId: "nonexistent-agent" },
        ],
      });

      await applyPlan(jira, config, parent, plan, [], roster);

      expect(jira.createdIssues.at(-1)?.assigneeAccountId).toBe(agentA.registration?.jiraAccountId);
    });

    it("falls back to the legacy pm.implementAssignee when the roster has no routable implement agent", async () => {
      const jira = new FakeJiraGateway();
      jira.seedUser(IMPLEMENT_USER);
      const parent = buildTestIssue({ key: "KAN-1", projectKey: "KAN" });
      jira.seedIssue(parent);
      const config = buildTestConfig();

      const result = await applyPlan(jira, config, parent, basePlan(), [], []);

      expect(jira.createdIssues[0]?.assigneeAccountId).toBe(IMPLEMENT_USER.accountId);
      expect(result.createdKeys).toHaveLength(1);
    });

    it("creates a requested agent profile idempotently (skips if the agentId already exists)", async () => {
      const jira = new FakeJiraGateway();
      jira.setSelf({ accountId: "pm-account", displayName: "PM", emailAddress: null });
      const parent = buildTestIssue({ key: "KAN-1", projectKey: "KAN" });
      jira.seedIssue(parent);
      const config = buildTestConfig();
      const plan = basePlan({
        tasks: [],
        agentProfiles: [
          { agentId: "unity-implement-01", role: "implement", capabilities: ["Unity"] },
        ],
      });

      const result = await applyPlan(jira, config, parent, plan, []);
      expect(result.createdProfileKeys).toHaveLength(1);
      const createdCount = jira.createdIssues.length;

      // Re-applying a plan requesting the same agentId must not create a duplicate.
      const result2 = await applyPlan(jira, config, parent, plan, []);
      expect(result2.createdProfileKeys).toHaveLength(0);
      expect(jira.createdIssues).toHaveLength(createdCount);
    });

    it("disables a requested agent by agentId, adding the ggjira-disabled label", async () => {
      const jira = new FakeJiraGateway();
      jira.setSelf({ accountId: "pm-account", displayName: "PM", emailAddress: null });
      const parent = buildTestIssue({ key: "KAN-1", projectKey: "KAN" });
      jira.seedIssue(parent);
      const agentA = await makeRegisteredAgent(jira, "agent-a", "machine-a");
      const config = buildTestConfig();
      const plan = basePlan({ tasks: [], disableAgentIds: ["agent-a"] });

      const result = await applyPlan(jira, config, parent, plan, [], [agentA]);

      expect(result.disabledAgentIds).toEqual(["agent-a"]);
      expect(jira.labelChanges).toContainEqual({
        key: agentA.issueKey,
        label: "ggjira-disabled",
        action: "add",
      });
    });
  });
});
