import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  missingContracts,
  parentPlanRequirements,
  planTaskRequirements,
} from "../src/pm/contract.js";
import { type PlanTaskSchema, PlanSchema } from "../src/pm/plan.js";
import { renderParentPlan } from "../src/pm/plan-render.js";

type PlanTask = z.infer<typeof PlanTaskSchema>;

function task(overrides: Partial<PlanTask> = {}): PlanTask {
  return {
    taskId: "api",
    title: "Expose the inventory API",
    description: "Add a read-only endpoint.",
    acceptance: ["GET /inventory returns the items", "Unknown ids return 404"],
    dependencies: ["KAN-7"],
    constraints: ["No schema change"],
    suggestedExecutionStrategy: "Reuse the existing repository layer",
    inScope: ["Read endpoint"],
    outOfScope: ["Write endpoints", "Changing the data model"],
    affectedAreas: ["src/api"],
    allowedPaths: ["src/api/**", "test/**/*.test.ts", "**/*.md"],
    verification: ["npm run test -- inventory", "curl /inventory: returns JSON"],
    ...overrides,
  };
}

describe("the contract a run is held to comes from the approved plan (ADR 0047)", () => {
  it("takes a task's full contract, with the dependency keys Router resolved", () => {
    const planned = task();
    expect(planTaskRequirements(planned, ["KAN-7", "KAN-12"])).toEqual({
      objective: planned.title,
      acceptanceCriteria: planned.acceptance,
      dependencies: ["KAN-7", "KAN-12"],
      constraints: planned.constraints,
      suggestedExecutionStrategy: planned.suggestedExecutionStrategy,
      verification: planned.verification,
      inScope: planned.inScope,
      outOfScope: planned.outOfScope,
      affectedAreas: planned.affectedAreas,
      allowedPaths: planned.allowedPaths,
    });
  });

  it("takes the parent's own contract from a plan without tasks", () => {
    const plan = PlanSchema.parse({
      needsDecision: false,
      summary: "Single wording change",
      acceptanceCriteria: ["The button reads Save"],
      verification: ["Open the settings page"],
      inScope: ["Button label"],
      outOfScope: ["Other labels"],
    });
    expect(parentPlanRequirements(plan, "Button label")).toMatchObject({
      objective: "Button label",
      acceptanceCriteria: ["The button reads Save"],
      verification: ["Open the settings page"],
      inScope: ["Button label"],
      outOfScope: ["Other labels"],
    });
  });

  it("names every executable unit that has no definition of done", () => {
    const single = PlanSchema.parse({
      needsDecision: false,
      summary: "s",
      verification: ["npm test"],
    });
    expect(missingContracts(single)).toEqual(["the plan has no acceptance criteria"]);
    const split = PlanSchema.parse({
      needsDecision: false,
      summary: "s",
      tasks: [task(), task({ taskId: "ui", acceptance: [], verification: [] })],
    });
    expect(missingContracts(split)).toEqual([
      "task ui has no acceptance criteria and verification",
    ]);
  });

  it("renders the parent's plan around a human-written description", () => {
    const plan = PlanSchema.parse({
      needsDecision: false,
      summary: "Single wording change",
      objective: "Fix the button label",
      acceptanceCriteria: ["The button reads Save"],
      verification: ["Open the settings page"],
    });
    const description = renderParentPlan(
      { summary: "Button label", description: "Please fix the typo on the settings page." },
      plan,
    );
    expect(description.startsWith("Please fix the typo")).toBe(true);
    expect(description).toContain("h2. Acceptance Criteria\n* The button reads Save");
  });
});

describe("a single-outcome plan", () => {
  it("is valid with no subtasks when it records the parent's own contract", () => {
    const parsed = PlanSchema.safeParse({
      needsDecision: false,
      summary: "Wording change",
      acceptanceCriteria: ["Label reads Save"],
      verification: ["Open the page"],
      tasks: [],
    });
    expect(parsed.success).toBe(true);
  });
});
