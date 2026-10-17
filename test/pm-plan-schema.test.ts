import { describe, expect, it } from "vitest";
import { PLAN_JSON_SCHEMA, PlanSchema } from "../src/pm/plan.js";
import { compareJsonSchema, type JsonNode } from "./helpers/json-schema-parity.js";

/**
 * PLAN_JSON_SCHEMA is hand-written (Zod 3 has no JSON Schema export) and is what the provider is
 * told to produce, while PlanSchema is what Router accepts. They drift silently unless something
 * compares them: same property names at every level, everything PlanSchema requires is required
 * in the JSON Schema too, and arrays/enums/minimums line up.
 */

describe("PLAN_JSON_SCHEMA", () => {
  it("mirrors PlanSchema at every level", () => {
    compareJsonSchema(PlanSchema, PLAN_JSON_SCHEMA as unknown as JsonNode, "plan");
  });

  it("makes the model fill every task's scope contract (ADR 0034)", () => {
    const task = PLAN_JSON_SCHEMA.properties.tasks.items;
    for (const field of ["acceptance", "verification", "inScope", "outOfScope", "affectedAreas"]) {
      expect(task.required).toContain(field);
    }
    expect(task.required).toContain("allowedPaths");
  });

  it("catches a property missing from the JSON Schema", () => {
    const drifted = structuredClone(PLAN_JSON_SCHEMA) as unknown as JsonNode;
    const taskProperties = drifted.properties?.tasks?.items?.properties ?? {};
    const { verification: _dropped, ...withoutVerification } = taskProperties;
    if (drifted.properties?.tasks?.items) {
      drifted.properties.tasks.items.properties = withoutVerification;
    }
    expect(() => compareJsonSchema(PlanSchema, drifted, "plan")).toThrow();
  });
});
