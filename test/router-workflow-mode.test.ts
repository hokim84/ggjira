import { describe, expect, it } from "vitest";
import {
  approvalStatusFor,
  candidateStatuses,
  decisionTransitionTarget,
  isDependencyResolved,
  reRequestHint,
  resolveJobKind,
} from "../src/router/workflow-mode.js";
import {
  DELEGATION_DONE_STATUS,
  DELEGATION_REQUEST_STATUS,
  PLANNING_STATUS,
  PLAN_REVIEW_STATUS,
  REQUEST_STATUS,
  RESULT_REVIEW_STATUS,
  REVIEW_STATUS,
  SHARED_IN_PROGRESS_STATUS,
  delegationWorkspace,
  testWorkspace,
} from "./helpers/router-fixtures.js";
describe("status workflows", () => {
  it("keeps legacy planning and implementation requests distinct", () => {
    expect(
      resolveJobKind({ workspace: testWorkspace, issue: { statusName: PLANNING_STATUS } }),
    ).toBe("planning");
    expect(
      resolveJobKind({ workspace: testWorkspace, issue: { statusName: REQUEST_STATUS } }),
    ).toBe("implementation");
    expect(approvalStatusFor("planning", testWorkspace)).toBe(PLANNING_STATUS);
    expect(candidateStatuses(testWorkspace)).toEqual([REQUEST_STATUS, PLANNING_STATUS]);
    expect(decisionTransitionTarget(testWorkspace, "planning")).toBe(REVIEW_STATUS);
  });
  it("plans all delegated requests, including subtasks", () => {
    for (const isSubtask of [true, false])
      expect(
        resolveJobKind({
          workspace: delegationWorkspace,
          issue: { statusName: DELEGATION_REQUEST_STATUS, isSubtask },
        }),
      ).toBe("planning");
    expect(candidateStatuses(delegationWorkspace)).toEqual([DELEGATION_REQUEST_STATUS]);
    expect(approvalStatusFor("implementation", delegationWorkspace)).toBe(
      SHARED_IN_PROGRESS_STATUS,
    );
  });
  it("keeps planning questions in plan review and implementation stops in progress", () => {
    expect(decisionTransitionTarget(delegationWorkspace, "planning")).toBe(PLAN_REVIEW_STATUS);
    expect(decisionTransitionTarget(delegationWorkspace, "implementation")).toBeNull();
    expect(reRequestHint(delegationWorkspace)).toContain(PLAN_REVIEW_STATUS);
  });
  it("requires completion or an actual review confirmation for dependencies", () => {
    expect(isDependencyResolved(delegationWorkspace, RESULT_REVIEW_STATUS, false)).toBe(false);
    expect(isDependencyResolved(delegationWorkspace, RESULT_REVIEW_STATUS, true)).toBe(true);
    expect(isDependencyResolved(delegationWorkspace, DELEGATION_DONE_STATUS, false)).toBe(true);
  });
});
