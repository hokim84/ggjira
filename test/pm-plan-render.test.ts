import { describe, expect, it } from "vitest";
import { readIssueRequirements } from "../src/issue/requirements.js";
import { type PlanTaskSchema, PlanSchema } from "../src/pm/plan.js";
import { renderParentPlan, renderTaskDescription } from "../src/pm/plan-render.js";
import type { z } from "zod";
import { buildTestIssue } from "./helpers/fixtures.js";

type PlanTask = z.infer<typeof PlanTaskSchema>;

function task(overrides: Partial<PlanTask> = {}): PlanTask {
  return {
    taskId: "api",
    title: "Expose the inventory API",
    description: "Add a read-only endpoint.",
    acceptance: ["GET /inventory returns the items", "Unknown ids return 404"],
    dependencies: ["KAN-7"],
    constraints: ["No schema change"],
    requiredCapabilities: ["programming"],
    suggestedExecutionStrategy: "Reuse the existing repository layer",
    inScope: ["Read endpoint"],
    outOfScope: ["Write endpoints", "Changing the data model"],
    affectedAreas: ["src/api"],
    allowedPaths: ["src/api/**", "test/**/*.test.ts", "**/*.md"],
    verification: ["npm run test -- inventory", "curl /inventory: returns JSON"],
    ...overrides,
  };
}

function readBack(description: string) {
  return readIssueRequirements(buildTestIssue({ key: "KAN-1", description }));
}

describe("plan rendering round-trips through the issue parser (ADR 0034)", () => {
  it("reads back a task's full contract", () => {
    const rendered = task();
    expect(readBack(renderTaskDescription(rendered))).toEqual({
      objective: rendered.title,
      acceptanceCriteria: rendered.acceptance,
      dependencies: rendered.dependencies,
      constraints: rendered.constraints,
      requiredCapabilities: rendered.requiredCapabilities,
      suggestedExecutionStrategy: rendered.suggestedExecutionStrategy,
      verification: rendered.verification,
      inScope: rendered.inScope,
      outOfScope: rendered.outOfScope,
      affectedAreas: rendered.affectedAreas,
      allowedPaths: rendered.allowedPaths,
    });
  });

  it("keeps free-text headings and `Label: value` lines out of the contract", () => {
    const description = [
      "Background: the old endpoint was removed.",
      "",
      "h2. Notes",
      "* Owner: platform team",
      "Ticket: see KAN-3",
    ].join("\n");
    const requirements = readBack(renderTaskDescription(task({ description })));
    expect(requirements.acceptanceCriteria).toEqual(task().acceptance);
    expect(requirements.verification).toEqual(task().verification);
    expect(requirements.objective).toBe(task().title);
  });

  it("renders empty contract sections so they read back empty", () => {
    const requirements = readBack(
      renderTaskDescription(
        task({
          inScope: [],
          outOfScope: [],
          affectedAreas: [],
          allowedPaths: [],
          verification: [],
        }),
      ),
    );
    expect(requirements).toMatchObject({
      inScope: [],
      outOfScope: [],
      affectedAreas: [],
      allowedPaths: [],
      verification: [],
    });
  });

  it("reads back the parent's own contract around a human-written description", () => {
    const plan = PlanSchema.parse({
      needsDecision: false,
      summary: "Single wording change",
      objective: "Fix the button label",
      acceptanceCriteria: ["The button reads Save"],
      verification: ["Open the settings page"],
      inScope: ["Button label"],
      outOfScope: ["Other labels"],
      requiredCapabilities: ["programming"],
    });
    const description = renderParentPlan(
      { summary: "Button label", description: "Please fix the typo on the settings page." },
      plan,
    );
    expect(description.startsWith("Please fix the typo")).toBe(true);
    expect(readBack(description)).toMatchObject({
      objective: "Fix the button label",
      acceptanceCriteria: ["The button reads Save"],
      verification: ["Open the settings page"],
      inScope: ["Button label"],
      outOfScope: ["Other labels"],
      requiredCapabilities: ["programming"],
    });
  });
});

describe("a single-outcome plan", () => {
  it("is valid with no subtasks when it records the parent's own capabilities", () => {
    const parsed = PlanSchema.safeParse({
      needsDecision: false,
      summary: "Wording change",
      acceptanceCriteria: ["Label reads Save"],
      verification: ["Open the page"],
      requiredCapabilities: ["programming"],
      tasks: [],
    });
    expect(parsed.success).toBe(true);
  });
});
