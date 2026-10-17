import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PLAN_JSON_SCHEMA, PlanSchema } from "../src/pm/plan.js";

/**
 * PLAN_JSON_SCHEMA is hand-written (Zod 3 has no JSON Schema export) and is what the provider is
 * told to produce, while PlanSchema is what Router accepts. They drift silently unless something
 * compares them: same property names at every level, everything PlanSchema requires is required
 * in the JSON Schema too, and arrays/enums/minimums line up.
 */

interface JsonNode {
  type?: string;
  properties?: Record<string, JsonNode>;
  required?: readonly string[];
  additionalProperties?: boolean;
  items?: JsonNode;
  minItems?: number;
  enum?: readonly string[];
}

/** Strips the wrappers that do not change the value's shape. */
function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  for (;;) {
    if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
      current = current.unwrap();
    } else if (current instanceof z.ZodDefault) {
      current = current._def.innerType;
    } else if (current instanceof z.ZodEffects) {
      current = current.innerType();
    } else {
      return current;
    }
  }
}

/** A field the model may leave out: Zod accepts `undefined` for it (optional or defaulted). */
function acceptsMissing(schema: z.ZodTypeAny): boolean {
  return schema.safeParse(undefined).success;
}

function compare(zod: z.ZodTypeAny, json: JsonNode, path: string): void {
  const inner = unwrap(zod);
  if (inner instanceof z.ZodObject) {
    expect(json.type, path).toBe("object");
    expect(json.additionalProperties, `${path} additionalProperties`).toBe(false);
    const shape = inner.shape as Record<string, z.ZodTypeAny>;
    expect(Object.keys(json.properties ?? {}).sort(), `${path} properties`).toEqual(
      Object.keys(shape).sort(),
    );
    const required = new Set(json.required ?? []);
    for (const name of required) {
      expect(Object.keys(shape), `${path} requires unknown ${name}`).toContain(name);
    }
    for (const [name, field] of Object.entries(shape)) {
      if (!acceptsMissing(field)) {
        expect(required.has(name), `${path}.${name} is required by PlanSchema`).toBe(true);
      }
      const child = json.properties?.[name];
      if (!child) throw new Error(`${path}.${name} missing from the JSON Schema`);
      compare(field, child, `${path}.${name}`);
    }
    return;
  }
  if (inner instanceof z.ZodArray) {
    expect(json.type, path).toBe("array");
    const min = inner._def.minLength?.value;
    if (min !== undefined) expect(json.minItems, `${path} minItems`).toBe(min);
    if (!json.items) throw new Error(`${path} has no items schema`);
    compare(inner.element, json.items, `${path}[]`);
    return;
  }
  if (inner instanceof z.ZodEnum) {
    expect(json.type, path).toBe("string");
    expect([...(json.enum ?? [])].sort(), `${path} enum`).toEqual([...inner.options].sort());
    return;
  }
  if (inner instanceof z.ZodString) {
    expect(json.type, path).toBe("string");
    return;
  }
  if (inner instanceof z.ZodBoolean) {
    expect(json.type, path).toBe("boolean");
    return;
  }
  throw new Error(`${path}: no comparison for ${inner.constructor.name}`);
}

describe("PLAN_JSON_SCHEMA", () => {
  it("mirrors PlanSchema at every level", () => {
    compare(PlanSchema, PLAN_JSON_SCHEMA as unknown as JsonNode, "plan");
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
    expect(() => compare(PlanSchema, drifted, "plan")).toThrow();
  });
});
