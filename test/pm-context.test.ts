import { describe, expect, it } from "vitest";
import type { JiraComment } from "../src/jira/types.js";
import { findHumanDecision } from "../src/pm/context.js";
import { renderDecisionRequest } from "../src/pm/decision-render.js";
import { DECISION_REQUEST_MARKER } from "../src/pm/marker.js";
import { PlanSchema } from "../src/pm/plan.js";
import { buildPlanningPrompt } from "../src/pm/prompt.js";
import { COMMENT_TEXT } from "../src/router/comment-text.js";
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
  const plan = PlanSchema.parse({
    needsDecision: true,
    summary: "Choose storage",
    decision: {
      question: "SQL or NoSQL?",
      options: [
        { id: "sql", title: "SQL", pros: ["Transactions"], cons: ["Schema migration"] },
        { id: "nosql", title: "NoSQL" },
      ],
      recommendation: "nosql",
    },
  });
  const request = (version = "v1") =>
    renderDecisionRequest(plan, {
      planVersion: version,
      replyStatus: "AI 계획 요청",
      signature: "ggjira job: planning",
      text: COMMENT_TEXT.ko.decision,
    });

  it("numbers the choices and recommendation, with a concrete reply example", () => {
    const body = request();
    expect(body).toContain("1. SQL\n  장점: Transactions\n  단점: Schema migration");
    expect(body).toContain("추천: 2. NoSQL");
    expect(body).toContain("2. NoSQL");
    expect(body).toContain("선택지 번호만 댓글로 남기세요(예: 2)");
    expect(body).not.toContain("Decision:");
  });

  it.each(["2", " 2번 "])(
    "maps reply %s to the displayed option and preserves planning context",
    (body) => {
      const comments = [
        comment({ body: request(), authorAccountId: SELF }),
        comment({ body, authorAccountId: "human-1" }),
      ];
      const decision = findHumanDecision(comments, SELF);
      expect(decision).toMatchObject({ raw: body, optionId: "nosql", planVersion: "v1" });
      if (!decision) throw new Error("Expected a numbered decision");
      const prompt = buildPlanningPrompt({
        issue: { key: "KAN-1", summary: "Storage", description: null },
        comments,
        existingSubtasks: [],
        humanDecision: decision,
      });
      expect(prompt).toContain("Previous decision request:");
      expect(prompt).toContain("SQL or NoSQL?");
      expect(prompt).toContain("2. NoSQL");
    },
  );

  it("ignores invalid numbers and accepts a corrected choice after the newest request", () => {
    const comments = [
      comment({ body: request("old"), authorAccountId: SELF }),
      comment({ body: "1", authorAccountId: "human-1" }),
      comment({ body: request("new"), authorAccountId: SELF }),
      comment({ body: "-1", authorAccountId: "human-1" }),
      comment({ body: "0", authorAccountId: "human-1" }),
      comment({ body: "3", authorAccountId: "human-1" }),
    ];
    expect(findHumanDecision(comments, SELF)).toBeUndefined();
    comments.push(comment({ body: "2", authorAccountId: "human-1" }));
    expect(findHumanDecision(comments, SELF)).toMatchObject({
      optionId: "nosql",
      planVersion: "new",
    });
  });

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

  it("accepts a matching decision ID from the human owner even when Jira uses the agent account", () => {
    const comments = [
      comment({
        body: `${DECISION_REQUEST_MARKER}\nplanVersion: v1\ndecisionId: d1`,
        authorAccountId: SELF,
      }),
      comment({ body: "Decision: A\ndecisionId: stale", authorAccountId: SELF }),
      comment({ body: "Decision: B\ndecisionId: d1", authorAccountId: SELF }),
    ];

    const decision = findHumanDecision(comments, SELF, SELF);

    expect(decision).toMatchObject({ optionId: "B", decisionId: "d1", planVersion: "v1" });
  });

  it("accepts a plain 'Decision: X' reply with no decisionId line, even when the request has one", () => {
    // The human-facing instructions never ask for a decisionId line (pm/prompt.ts) -- a real
    // reply won't have one, and it's already scoped to comments after the latest request, so
    // nothing else could be answering.
    const comments = [
      comment({
        body: `${DECISION_REQUEST_MARKER}\nplanVersion: v1\ndecisionId: d1`,
        authorAccountId: SELF,
      }),
      comment({ body: "Decision: A", authorAccountId: "human-1" }),
    ];

    const decision = findHumanDecision(comments, SELF);

    expect(decision).toMatchObject({ optionId: "A", decisionId: "d1", planVersion: "v1" });
  });
});
