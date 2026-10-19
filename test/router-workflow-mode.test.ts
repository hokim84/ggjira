import { describe, expect, it } from "vitest";
import type { IssueRequirements } from "../src/issue/requirements.js";
import type { PlanTaskMetadata } from "../src/pm/metadata.js";
import {
  approvalStatusFor,
  candidateStatuses,
  decisionTransitionTarget,
  hasOptIn,
  isDependencyResolved,
  reRequestHint,
  resolveJobKind,
} from "../src/router/workflow-mode.js";
import {
  DELEGATION_DONE_STATUS,
  DELEGATION_REQUEST_STATUS,
  delegationWorkspace,
  PLAN_REVIEW_STATUS,
  RESULT_REVIEW_STATUS,
  SHARED_IN_PROGRESS_STATUS,
  labelWorkspace,
  LABEL_REVIEW_STATUS,
  PLANNING_STATUS,
  REQUEST_STATUS,
  REVIEW_STATUS,
  testWorkspace,
  TODO_STATUS,
} from "./helpers/router-fixtures.js";

function requirements(ready: boolean): IssueRequirements {
  return {
    objective: "Do the thing",
    acceptanceCriteria: ready ? ["It works"] : [],
    dependencies: [],
    constraints: [],
    requiredCapabilities: ["programming"],
    suggestedExecutionStrategy: null,
    verification: ready ? ["npm run test"] : [],
    inScope: [],
    outOfScope: [],
    affectedAreas: [],
    allowedPaths: [],
  };
}

const planTask: PlanTaskMetadata = {
  planVersion: "plan-1",
  taskId: "api",
  parentKey: "KAN-1",
  workspaceId: "ws1",
  dependencies: [],
};

describe("workflow mode (ADR 0037)", () => {
  describe("resolveJobKind", () => {
    it("legacy: follows the status the request was made from", () => {
      const kind = (statusName: string, ready: boolean) =>
        resolveJobKind({
          workspace: testWorkspace,
          issue: { statusName },
          requirements: requirements(ready),
          planTask: null,
          parentPlanHasTasks: false,
        });
      expect(kind(PLANNING_STATUS, true)).toBe("planning");
      expect(kind(REQUEST_STATUS, false)).toBe("implementation");
    });

    // The decision table's "To Do + label + assignee" rows.
    it.each([
      { case: "ready request", ready: true, extra: {}, kind: "implementation" },
      { case: "request without a contract", ready: false, extra: {}, kind: "planning" },
      {
        case: "parent already split into tasks (re-plan)",
        ready: true,
        extra: { parentPlanHasTasks: true },
        kind: "planning",
      },
      {
        case: "plan task without a contract (held, never planned)",
        ready: false,
        extra: { planTask },
        kind: "implementation",
      },
      {
        case: "Jira subtask without a contract (held, never planned)",
        ready: false,
        extra: { isSubtask: true },
        kind: "implementation",
      },
    ])("label: $case → $kind", ({ ready, extra, kind }) => {
      const { isSubtask, ...rest } = extra as {
        isSubtask?: boolean;
        planTask?: PlanTaskMetadata;
        parentPlanHasTasks?: boolean;
      };
      expect(
        resolveJobKind({
          workspace: labelWorkspace,
          issue: { statusName: TODO_STATUS, ...(isSubtask ? { isSubtask } : {}) },
          requirements: requirements(ready),
          planTask: null,
          parentPlanHasTasks: false,
          ...rest,
        }),
      ).toBe(kind);
    });
  });

  it("an issue opts in only with the label in label mode, compared case-insensitively", () => {
    expect(hasOptIn({ labels: [] }, labelWorkspace)).toBe(false);
    expect(hasOptIn({ labels: ["other", "AI-Enabled"] }, labelWorkspace)).toBe(true);
    expect(hasOptIn({ labels: [] }, testWorkspace)).toBe(true);
  });

  it("requests both kinds from To Do in label mode", () => {
    expect(approvalStatusFor("planning", labelWorkspace)).toBe(TODO_STATUS);
    expect(approvalStatusFor("implementation", labelWorkspace)).toBe(TODO_STATUS);
    expect(candidateStatuses(labelWorkspace)).toEqual([TODO_STATUS]);
    expect(approvalStatusFor("planning", testWorkspace)).toBe(PLANNING_STATUS);
    expect(candidateStatuses(testWorkspace)).toEqual([REQUEST_STATUS, PLANNING_STATUS]);
  });

  describe("delegation mode (ADR 0044)", () => {
    it("plans every request, whatever its contract or type", () => {
      for (const [ready, isSubtask, task] of [
        [true, false, null],
        [false, true, null],
        [true, true, planTask],
      ] as const) {
        expect(
          resolveJobKind({
            workspace: delegationWorkspace,
            issue: { statusName: DELEGATION_REQUEST_STATUS, isSubtask },
            requirements: requirements(ready),
            planTask: task,
            parentPlanHasTasks: false,
          }),
        ).toBe("planning");
      }
    });

    it("finds candidates by the request status only, and ignores labels", () => {
      expect(candidateStatuses(delegationWorkspace)).toEqual([DELEGATION_REQUEST_STATUS]);
      expect(approvalStatusFor("planning", delegationWorkspace)).toBe(DELEGATION_REQUEST_STATUS);
      expect(approvalStatusFor("implementation", delegationWorkspace)).toBe(
        SHARED_IN_PROGRESS_STATUS,
      );
      expect(hasOptIn({ labels: [] }, delegationWorkspace)).toBe(true);
    });

    it("sends a planning question to plan review and keeps an implementation stop in progress", () => {
      expect(decisionTransitionTarget(delegationWorkspace, "planning")).toBe(PLAN_REVIEW_STATUS);
      expect(decisionTransitionTarget(delegationWorkspace, "implementation")).toBeNull();
    });

    it("tells how to re-run the same plan or plan it again", () => {
      expect(reRequestHint(delegationWorkspace, "planning")).toBe(
        `move the issue to "${DELEGATION_REQUEST_STATUS}" again`,
      );
      expect(reRequestHint(delegationWorkspace, "implementation")).toContain(
        `"${PLAN_REVIEW_STATUS}" and then to "${SHARED_IN_PROGRESS_STATUS}"`,
      );
    });

    it("counts a dependency done only when done or confirmed, not on review", () => {
      expect(isDependencyResolved(delegationWorkspace, RESULT_REVIEW_STATUS, false)).toBe(false);
      expect(isDependencyResolved(delegationWorkspace, RESULT_REVIEW_STATUS, true)).toBe(true);
      expect(isDependencyResolved(delegationWorkspace, DELEGATION_DONE_STATUS, false)).toBe(true);
      // The other modes keep "reached review" as done.
      expect(isDependencyResolved(labelWorkspace, LABEL_REVIEW_STATUS, false)).toBe(true);
      expect(isDependencyResolved(testWorkspace, REQUEST_STATUS, false)).toBe(false);
    });
  });

  it("leaves a decision request where it is in label mode", () => {
    expect(decisionTransitionTarget(labelWorkspace, "planning")).toBeNull();
    expect(decisionTransitionTarget(testWorkspace, "planning")).toBe(REVIEW_STATUS);
    expect(LABEL_REVIEW_STATUS).not.toBe(REVIEW_STATUS);
  });
});
