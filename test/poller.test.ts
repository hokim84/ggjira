import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeJiraGateway } from "../src/jira/fake.js";
import { JobStore } from "../src/job/store.js";
import { PLAN_TASK_PROPERTY_KEY } from "../src/pm/metadata.js";
import { buildAssignedJql, findAssignedJobs } from "../src/poller/poller.js";
import { AGENT_LABEL, WORKSPACE_LABEL } from "../src/profile/types.js";
import { buildTestConfig, buildTestIssue } from "./helpers/fixtures.js";

const SELF = {
  accountId: "self-id",
  displayName: "GGJIRA Implement",
  emailAddress: "ggjira-implement@example.com",
};

describe("buildAssignedJql", () => {
  it("builds assignee + readyStatus JQL by default", () => {
    const config = buildTestConfig();
    expect(buildAssignedJql(config)).toBe(
      'assignee = currentUser() AND status = "To Do" ORDER BY created ASC',
    );
  });

  it("uses jira.jql verbatim when set", () => {
    const config = buildTestConfig({
      jira: { baseUrl: "https://example.atlassian.net", jql: "project = KAN" },
    });
    expect(buildAssignedJql(config)).toBe("project = KAN");
  });
});

describe("findAssignedJobs", () => {
  let dataDir: string;
  let store: JobStore;
  const config = buildTestConfig();

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "ggjira-poller-test-"));
    store = new JobStore(dataDir);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns issues assigned to this agent that are ready to claim", async () => {
    const jira = new FakeJiraGateway();
    jira.setSelf(SELF);
    jira.seedIssue(
      buildTestIssue({ key: "KAN-1", assigneeAccountId: SELF.accountId, statusName: "To Do" }),
    );
    jira.seedIssue(
      buildTestIssue({ key: "KAN-2", assigneeAccountId: SELF.accountId, statusName: "To Do" }),
    );
    jira.seedIssue(
      buildTestIssue({ key: "KAN-3", assigneeAccountId: "someone-else", statusName: "To Do" }),
    );
    jira.seedIssue(
      buildTestIssue({
        key: "KAN-4",
        assigneeAccountId: SELF.accountId,
        statusName: "In Progress",
      }),
    );

    const candidates = await findAssignedJobs(jira, config, store);

    expect(candidates.map((i) => i.key).sort()).toEqual(["KAN-1", "KAN-2"]);
  });

  it("filters out issues already claimed locally", async () => {
    const jira = new FakeJiraGateway();
    jira.setSelf(SELF);
    jira.seedIssue(
      buildTestIssue({ key: "KAN-1", assigneeAccountId: SELF.accountId, statusName: "To Do" }),
    );
    jira.seedIssue(
      buildTestIssue({ key: "KAN-2", assigneeAccountId: SELF.accountId, statusName: "To Do" }),
    );
    store.claimIssue("KAN-1", "run-1");

    const candidates = await findAssignedJobs(jira, config, store);

    expect(candidates.map((i) => i.key)).toEqual(["KAN-2"]);
  });

  it("excludes GGJIRA meta issues (Agent Profile / Workspace Configuration) even if assigned to this agent", async () => {
    const jira = new FakeJiraGateway();
    jira.setSelf(SELF);
    jira.seedIssue(
      buildTestIssue({ key: "KAN-1", assigneeAccountId: SELF.accountId, statusName: "To Do" }),
    );
    jira.seedIssue(
      buildTestIssue({
        key: "KAN-2",
        assigneeAccountId: SELF.accountId,
        statusName: "To Do",
        labels: [AGENT_LABEL],
        summary: "[AGENT] pm-01",
      }),
    );
    jira.seedIssue(
      buildTestIssue({
        key: "KAN-3",
        assigneeAccountId: SELF.accountId,
        statusName: "To Do",
        labels: [WORKSPACE_LABEL],
        summary: "[GGJIRA] Workspace Configuration",
      }),
    );

    const candidates = await findAssignedJobs(jira, config, store);

    expect(candidates.map((i) => i.key)).toEqual(["KAN-1"]);
  });

  it("only returns a distributed task once its plan-task metadata names this workspace", async () => {
    const jira = new FakeJiraGateway();
    const distributed = buildTestConfig({
      configVersion: 4,
      workflow: {
        ...config.workflow,
        planningStatus: "AI Planning",
        implementationStatus: "AI Implementation",
        inProgressStatus: "In Progress",
        reviewStatus: "In Review",
      },
      distribution: {
        enabled: true,
        executionAgentFieldId: "customfield_12345",
        executionAgentOptionId: "agent-a",
        workspaceId: "workspace-a",
      },
    });
    jira.seedIssue(
      buildTestIssue({
        key: "KAN-11",
        parentKey: "KAN-10",
        statusName: "AI Implementation",
        executionAgentOptionId: "agent-a",
      }),
    );
    // Moving the task to implementationStatus (its statusName above) is itself the approval
    // (ADR 0017) -- the only thing the poller still gates on is workspace identity.
    await jira.setIssueProperty("KAN-11", PLAN_TASK_PROPERTY_KEY, {
      planVersion: "v1",
      taskId: "task-1",
      parentKey: "KAN-10",
      workspaceId: "some-other-workspace",
      dependencies: [],
    });

    expect(await findAssignedJobs(jira, distributed, store)).toEqual([]);

    await jira.setIssueProperty("KAN-11", PLAN_TASK_PROPERTY_KEY, {
      planVersion: "v1",
      taskId: "task-1",
      parentKey: "KAN-10",
      workspaceId: "workspace-a",
      dependencies: [],
    });
    expect((await findAssignedJobs(jira, distributed, store)).map((issue) => issue.key)).toEqual([
      "KAN-11",
    ]);
  });

  it("excludes only the issue with corrupted plan-task metadata, not the whole cycle", async () => {
    const jira = new FakeJiraGateway();
    const distributed = buildTestConfig({
      configVersion: 4,
      workflow: {
        ...config.workflow,
        planningStatus: "AI Planning",
        implementationStatus: "AI Implementation",
        inProgressStatus: "In Progress",
        reviewStatus: "In Review",
      },
      distribution: {
        enabled: true,
        executionAgentFieldId: "customfield_12345",
        executionAgentOptionId: "agent-a",
        workspaceId: "workspace-a",
      },
    });
    jira.seedIssue(
      buildTestIssue({
        key: "KAN-11",
        parentKey: "KAN-10",
        statusName: "AI Implementation",
        executionAgentOptionId: "agent-a",
      }),
    );
    // Present but not schema-shaped -- absent (null) would be treated as a manually created,
    // untracked task instead, which is a different case (poller.test.ts's other assertions).
    await jira.setIssueProperty("KAN-11", PLAN_TASK_PROPERTY_KEY, { planVersion: "v1" });
    jira.seedIssue(
      buildTestIssue({
        key: "KAN-12",
        parentKey: "KAN-10",
        statusName: "AI Implementation",
        executionAgentOptionId: "agent-a",
      }),
    );
    await jira.setIssueProperty("KAN-12", PLAN_TASK_PROPERTY_KEY, {
      planVersion: "v1",
      taskId: "task-2",
      parentKey: "KAN-10",
      workspaceId: "workspace-a",
      dependencies: [],
    });

    const candidates = await findAssignedJobs(jira, distributed, store);

    expect(candidates.map((issue) => issue.key)).toEqual(["KAN-12"]);
  });
});
