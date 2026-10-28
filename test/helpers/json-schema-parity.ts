import { expect } from "vitest";
import { z } from "zod";

/**
 * Hand-written provider JSON Schemas (Zod 3 has no JSON Schema export) drift from the Zod schema
 * Router or the worker accepts unless something compares them: same property names at every level,
 * everything the Zod schema requires is required in the JSON Schema too, and arrays/enums/minimums
 * line up. The JSON Schema may require more, so the model always fills optional fields.
 */

export interface JsonNode {
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
    } else if (current instanceof z.ZodDefault || current instanceof z.ZodCatch) {
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

export function compareJsonSchema(zod: z.ZodTypeAny, json: JsonNode, path: string): void {
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
      compareJsonSchema(field, child, `${path}.${name}`);
    }
    return;
  }
  if (inner instanceof z.ZodArray) {
    expect(json.type, path).toBe("array");
    const min = inner._def.minLength?.value;
    if (min !== undefined) expect(json.minItems, `${path} minItems`).toBe(min);
    if (!json.items) throw new Error(`${path} has no items schema`);
    compareJsonSchema(inner.element, json.items, `${path}[]`);
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
