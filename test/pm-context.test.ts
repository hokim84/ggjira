import { describe, expect, it } from "vitest";
import { buildPlanningContext, findHumanDecision } from "../src/pm/context.js";
import { DECISION_REQUEST_MARKER } from "../src/pm/marker.js";
import type { JiraComment } from "../src/jira/types.js";
import { buildTestIssue } from "./helpers/fixtures.js";

const SELF = "pm-account-id";

function comment(overrides: Partial<JiraComment> & Pick<JiraComment, "body">): JiraComment {
  return {
    id: "c",
    authorAccountId: null,
    authorDisplayName: null,
    created: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("findHumanDecision", () => {
  it("returns undefined when there is no decision-request comment", () => {
    const comments = [comment({ body: "just a note", authorAccountId: "human-1" })];
    expect(findHumanDecision(comments, SELF)).toBeUndefined();
  });

  it("returns undefined when no human has replied yet after the request", () => {
    const comments = [comment({ body: `${DECISION_REQUEST_MARKER}\n...`, authorAccountId: SELF })];
    expect(findHumanDecision(comments, SELF)).toBeUndefined();
  });

  it("extracts the option id from a 'Decision: X' reply", () => {
    const comments = [
      comment({ body: `${DECISION_REQUEST_MARKER}\n...`, authorAccountId: SELF }),
      comment({ body: "Decision: B", authorAccountId: "human-1" }),
    ];
    const decision = findHumanDecision(comments, SELF);
    expect(decision?.optionId).toBe("B");
    expect(decision?.raw).toBe("Decision: B");
  });

  it("keeps the raw text without an optionId for a free-text reply", () => {
    const comments = [
      comment({ body: `${DECISION_REQUEST_MARKER}\n...`, authorAccountId: SELF }),
      comment({ body: "let's go with the second option", authorAccountId: "human-1" }),
    ];
    const decision = findHumanDecision(comments, SELF);
    expect(decision?.optionId).toBeUndefined();
    expect(decision?.raw).toContain("second option");
  });

  it("uses the most recent decision-request when there have been multiple rounds", () => {
    const comments = [
      comment({ body: `${DECISION_REQUEST_MARKER}\nfirst question`, authorAccountId: SELF }),
      comment({ body: "Decision: A", authorAccountId: "human-1" }),
      comment({ body: `${DECISION_REQUEST_MARKER}\nsecond question`, authorAccountId: SELF }),
      comment({ body: "Decision: B", authorAccountId: "human-1" }),
    ];
    expect(findHumanDecision(comments, SELF)?.optionId).toBe("B");
  });

  it("ignores this agent's own comments when looking for the reply", () => {
    const comments = [
      comment({ body: `${DECISION_REQUEST_MARKER}\n...`, authorAccountId: SELF }),
      comment({ body: "still thinking...", authorAccountId: SELF }),
      comment({ body: "Decision: A", authorAccountId: "human-1" }),
    ];
    expect(findHumanDecision(comments, SELF)?.optionId).toBe("A");
  });
});

describe("buildPlanningContext", () => {
  it("assembles issue, comments, subtasks and human decision together", () => {
    const issue = buildTestIssue({ key: "KAN-1" });
    const comments = [
      comment({ body: `${DECISION_REQUEST_MARKER}\n...`, authorAccountId: SELF }),
      comment({ body: "Decision: A", authorAccountId: "human-1" }),
    ];
    const subtasks = [buildTestIssue({ key: "KAN-2", parentKey: "KAN-1" })];

    const ctx = buildPlanningContext(issue, comments, subtasks, SELF);

    expect(ctx.issue.key).toBe("KAN-1");
    expect(ctx.existingSubtasks).toHaveLength(1);
    expect(ctx.humanDecision?.optionId).toBe("A");
  });

  it("omits humanDecision entirely (not even as undefined) when there is none", () => {
    const issue = buildTestIssue({ key: "KAN-1" });
    const ctx = buildPlanningContext(issue, [], [], SELF);
    expect("humanDecision" in ctx).toBe(false);
  });
});
