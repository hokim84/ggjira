import { z } from "zod";

/**
 * A question an agent hands back to a human instead of choosing itself. Planning (`plan.decision`)
 * and implementation (`implementation.decision`, ADR 0036) share this shape, so both are rendered
 * and read the same way and neither has to fake the other's payload.
 */
export const DecisionOptionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  pros: z.array(z.string()).default([]),
  cons: z.array(z.string()).default([]),
});

export const DecisionRequestSchema = z.object({
  question: z.string().min(1),
  options: z.array(DecisionOptionSchema).min(2),
  recommendation: z.string().optional(),
  impact: z.string().optional(),
});
export type DecisionRequest = z.infer<typeof DecisionRequestSchema>;

/** Hand-authored JSON Schema for `DecisionRequestSchema`, embedded in the provider schemas. */
export const DECISION_REQUEST_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["question", "options"],
  properties: {
    question: { type: "string" },
    options: {
      type: "array",
      minItems: 2,
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
} as const;
