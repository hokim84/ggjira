import { describe, expect, it } from "vitest";
import { PlanParseError, parsePlan } from "../src/pm/plan.js";

describe("parsePlan", () => {
  it("parses structuredOutput directly when present", () => {
    const plan = parsePlan(
      {
        needsDecision: false,
        summary: "ok",
        tasks: [{ title: "T1", description: "D1" }],
        keepTaskKeys: [],
      },
      "",
    );
    expect(plan.needsDecision).toBe(false);
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0]?.acceptance).toEqual([]);
  });

  it("falls back to extracting a fenced json block from raw text", () => {
    const text = [
      "Here is my plan:",
      "```json",
      '{"needsDecision": false, "summary": "ok", "tasks": [{"title": "T1", "description": "D1"}], "keepTaskKeys": []}',
      "```",
    ].join("\n");

    const plan = parsePlan(undefined, text);
    expect(plan.summary).toBe("ok");
  });

  it("throws PlanParseError when needsDecision is true but no decision is given", () => {
    expect(() =>
      parsePlan(
        { needsDecision: true, summary: "need a decision", tasks: [], keepTaskKeys: [] },
        "",
      ),
    ).toThrow(PlanParseError);
  });

  it("throws PlanParseError when needsDecision is false but tasks is empty", () => {
    expect(() =>
      parsePlan({ needsDecision: false, summary: "ok", tasks: [], keepTaskKeys: [] }, ""),
    ).toThrow(PlanParseError);
  });

  it("throws PlanParseError when nothing parseable is found", () => {
    expect(() => parsePlan(undefined, "no json here at all")).toThrow(PlanParseError);
  });

  it("allows empty tasks when the plan only requests new agent profiles", () => {
    const plan = parsePlan(
      {
        needsDecision: false,
        summary: "add a unity agent",
        tasks: [],
        keepTaskKeys: [],
        agentProfiles: [
          { agentId: "unity-implement-01", role: "implement", preset: "unity-programmer" },
        ],
        disableAgentIds: [],
      },
      "",
    );
    expect(plan.tasks).toEqual([]);
    expect(plan.agentProfiles).toHaveLength(1);
    expect(plan.agentProfiles[0]?.agentId).toBe("unity-implement-01");
  });

  it("allows empty tasks when the plan only disables agent profiles", () => {
    const plan = parsePlan(
      {
        needsDecision: false,
        summary: "remove an agent",
        tasks: [],
        keepTaskKeys: [],
        agentProfiles: [],
        disableAgentIds: ["unity-implement-01"],
      },
      "",
    );
    expect(plan.disableAgentIds).toEqual(["unity-implement-01"]);
  });

  it("still rejects empty tasks with no agentProfiles/disableAgentIds either", () => {
    expect(() =>
      parsePlan(
        {
          needsDecision: false,
          summary: "ok",
          tasks: [],
          keepTaskKeys: [],
          agentProfiles: [],
          disableAgentIds: [],
        },
        "",
      ),
    ).toThrow(PlanParseError);
  });

  it("parses a task's assigneeAgentId when present", () => {
    const plan = parsePlan(
      {
        needsDecision: false,
        summary: "ok",
        tasks: [{ title: "T1", description: "D1", assigneeAgentId: "unity-implement-01" }],
        keepTaskKeys: [],
      },
      "",
    );
    expect(plan.tasks[0]?.assigneeAgentId).toBe("unity-implement-01");
  });

  it("accepts a valid decision plan", () => {
    const plan = parsePlan(
      {
        needsDecision: true,
        summary: "need to pick an approach",
        tasks: [],
        keepTaskKeys: [],
        decision: {
          question: "Which approach?",
          options: [
            {
              id: "A",
              title: "Extend existing module",
              pros: ["less code"],
              cons: ["couples concerns"],
            },
            { id: "B", title: "New module", pros: ["clean separation"], cons: ["more code"] },
          ],
          recommendation: "B",
        },
      },
      "",
    );
    expect(plan.decision?.options).toHaveLength(2);
  });
});
