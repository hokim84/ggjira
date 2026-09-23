import { describe, expect, it } from "vitest";
import type { IssueRequirements } from "../src/issue/requirements.js";
import type { JiraIssue } from "../src/jira/types.js";
import type { PlanTaskMetadata } from "../src/pm/metadata.js";
import { RuleDecisionProvider, type RouteContext } from "../src/router/decision.js";
import type { WorkspaceConfig } from "../src/router/config.js";
import { isRouteDispatch } from "../src/contracts/route.js";

const workspace: WorkspaceConfig = {
  id: "ws1",
  repositoryId: "repo1",
  projectKeys: ["KAN"],
  workflow: {
    requestStatus: "AI 작업 요청",
    inProgressStatus: "작업 중",
    reviewStatus: "AI 작업 완료",
    planningStatus: "AI 계획 요청",
  },
};

function issue(overrides: Partial<JiraIssue> = {}): JiraIssue {
  return {
    key: "KAN-1",
    id: "10001",
    summary: "Do the thing",
    description: null,
    statusName: "AI 작업 요청",
    labels: [],
    assigneeAccountId: "user-1",
    issueTypeName: "Task",
    parentKey: null,
    projectKey: "KAN",
    ...overrides,
  };
}

function requirements(overrides: Partial<IssueRequirements> = {}): IssueRequirements {
  return {
    objective: "Do the thing",
    acceptanceCriteria: [],
    dependencies: [],
    constraints: [],
    requiredCapabilities: ["programming"],
    suggestedExecutionStrategy: null,
    ...overrides,
  };
}

function context(overrides: Partial<RouteContext> = {}): RouteContext {
  return {
    issue: issue(),
    requirements: requirements(),
    planTask: null,
    workspace,
    unresolvedDependencies: [],
    executionAgentOptionId: null,
    ...overrides,
  };
}

describe("RuleDecisionProvider", () => {
  it("holds for a human when the issue has no assignee", () => {
    const provider = new RuleDecisionProvider();
    const result = provider.decide(context({ issue: issue({ assigneeAccountId: null }) }));
    expect(result).toEqual({
      target: "human",
      reason: expect.stringContaining("no human assignee"),
    });
  });

  it("holds for a human when the plan-task's workspace doesn't match", () => {
    const provider = new RuleDecisionProvider();
    const planTask: PlanTaskMetadata = {
      planVersion: "v1",
      taskId: "t1",
      parentKey: "KAN-0",
      workspaceId: "some-other-workspace",
      dependencies: [],
    };
    const result = provider.decide(context({ planTask }));
    expect(result.target).toBe("human");
  });

  it("waits when there are unresolved dependencies, even if capabilities are also unknown", () => {
    const provider = new RuleDecisionProvider();
    const result = provider.decide(
      context({
        unresolvedDependencies: ["KAN-5"],
        requirements: requirements({ requiredCapabilities: ["not-a-real-capability"] }),
      }),
    );
    expect(result).toEqual({
      target: "wait",
      reason: expect.stringContaining("KAN-5"),
    });
  });

  it("holds for a human when required capabilities are unknown", () => {
    const provider = new RuleDecisionProvider();
    const result = provider.decide(
      context({ requirements: requirements({ requiredCapabilities: ["not-a-real-capability"] }) }),
    );
    expect(result.target).toBe("human");
  });

  it("holds for a human when the execution-agent option isn't mapped to a worker", () => {
    const provider = new RuleDecisionProvider({
      fieldId: "customfield_10001",
      optionWorkerMap: { "option-a": "worker-a" },
    });
    const result = provider.decide(context({ executionAgentOptionId: "option-unknown" }));
    expect(result.target).toBe("human");
  });

  it("dispatches with a pinned worker when the execution-agent option is mapped", () => {
    const provider = new RuleDecisionProvider({
      fieldId: "customfield_10001",
      optionWorkerMap: { "option-a": "worker-a" },
    });
    const result = provider.decide(context({ executionAgentOptionId: "option-a" }));
    expect(isRouteDispatch(result) && result.pinnedWorkerId).toBe("worker-a");
  });

  it("dispatches implementation for an issue in requestStatus", () => {
    const provider = new RuleDecisionProvider();
    const result = provider.decide(context());
    expect(result).toMatchObject({
      target: "implementation",
      workspaceId: "ws1",
      repositoryId: "repo1",
    });
  });

  it("dispatches planning for an issue in planningStatus", () => {
    const provider = new RuleDecisionProvider();
    const result = provider.decide(context({ issue: issue({ statusName: "AI 계획 요청" }) }));
    expect(result.target).toBe("planning");
  });
});
