import { describe, expect, it } from "vitest";
import {
  approvalStatusFor,
  decisionTransitionTarget,
  isDependencyResolved,
  reRequestHint,
} from "../src/router/workflow-mode.js";
import {
  DONE_STATUS,
  IN_PROGRESS_STATUS,
  PLAN_REVIEW_STATUS,
  REQUEST_STATUS,
  REVIEW_STATUS,
  testWorkspace,
} from "./helpers/router-fixtures.js";

describe("workflow rules (ADR 0044, ADR 0047)", () => {
  it("requests a plan from the request status and runs an implementation in progress", () => {
    expect(approvalStatusFor("planning", testWorkspace)).toBe(REQUEST_STATUS);
    expect(approvalStatusFor("implementation", testWorkspace)).toBe(IN_PROGRESS_STATUS);
  });

  it("keeps planning questions in plan review and implementation stops in progress", () => {
    expect(decisionTransitionTarget(testWorkspace, "planning")).toBeNull();
    expect(decisionTransitionTarget(testWorkspace, "implementation")).toBeNull();
  });

  it("asks for a new approval the way each kind is approved", () => {
    expect(reRequestHint(testWorkspace)).toContain(PLAN_REVIEW_STATUS);
    expect(reRequestHint(testWorkspace, "planning")).toBe(
      'ask the assignee to comment "재시도" or edit the title or description',
    );
  });

  it("requires completion or an actual review confirmation for dependencies", () => {
    expect(isDependencyResolved(testWorkspace, REVIEW_STATUS, false)).toBe(false);
    expect(isDependencyResolved(testWorkspace, REVIEW_STATUS, true)).toBe(true);
    expect(isDependencyResolved(testWorkspace, DONE_STATUS, false)).toBe(true);
  });
});
