import { z } from "zod";

export const PlanOptionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  pros: z.array(z.string()).default([]),
  cons: z.array(z.string()).default([]),
});

export const PlanDecisionSchema = z.object({
  question: z.string().min(1),
  options: z.array(PlanOptionSchema).min(2),
  recommendation: z.string().optional(),
  impact: z.string().optional(),
});

export const PlanTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  acceptance: z.array(z.string()).default([]),
});

export const PlanSchema = z
  .object({
    needsDecision: z.boolean(),
    summary: z.string().min(1),
    tasks: z.array(PlanTaskSchema).default([]),
    /** Keys of existing subtasks a replan should keep as-is (not recreate or supersede). */
    keepTaskKeys: z.array(z.string()).default([]),
    decision: PlanDecisionSchema.optional(),
  })
  .superRefine((plan, ctx) => {
    if (plan.needsDecision && !plan.decision) {
      ctx.addIssue({
        code: "custom",
        path: ["decision"],
        message: "decision is required when needsDecision is true",
      });
    }
    if (!plan.needsDecision && plan.tasks.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["tasks"],
        message: "tasks must be non-empty when needsDecision is false",
      });
    }
  });

export type Plan = z.infer<typeof PlanSchema>;

/** Hand-authored JSON Schema mirroring PlanSchema, passed to the provider as outputSchema. */
export const PLAN_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["needsDecision", "summary", "tasks", "keepTaskKeys"],
  properties: {
    needsDecision: { type: "boolean" },
    summary: { type: "string" },
    tasks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "description"],
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          acceptance: { type: "array", items: { type: "string" } },
        },
      },
    },
    keepTaskKeys: { type: "array", items: { type: "string" } },
    decision: {
      type: "object",
      additionalProperties: false,
      required: ["question", "options"],
      properties: {
        question: { type: "string" },
        options: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "title"],
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              pros: { type: "array", items: { type: "string" } },
              cons: { type: "array", items: { type: "string" } },
            },
          },
        },
        recommendation: { type: "string" },
        impact: { type: "string" },
      },
    },
  },
} as const;

export class PlanParseError extends Error {
  constructor(
    message: string,
    readonly rawText: string,
  ) {
    super(`Failed to parse PM plan: ${message}`);
    this.name = "PlanParseError";
  }
}

/** Best-effort extraction of a JSON value from free text, for providers that don't honor outputSchema verbatim. */
function extractJsonFromText(text: string): unknown {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? text.match(/(\{[\s\S]*\})/)?.[1];
  if (!candidate) return undefined;
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

/** Parses a worker's structured output (or, failing that, its raw text) into a validated Plan. */
export function parsePlan(structuredOutput: unknown, rawText: string): Plan {
  const candidate = structuredOutput ?? extractJsonFromText(rawText);
  const result = PlanSchema.safeParse(candidate);
  if (!result.success) {
    throw new PlanParseError(result.error.message, rawText);
  }
  return result.data;
}
