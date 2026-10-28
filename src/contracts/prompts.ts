import { z } from "zod";

export const AI_ROLES = ["planning", "implementation", "fci_analysis"] as const;
export const AiRoleSchema = z.enum(AI_ROLES);
export type AiRole = z.infer<typeof AiRoleSchema>;
export const AdditionalInstructionsSchema = z.string().max(20_000);
const RolePromptSchema = z.object({
  additionalInstructions: AdditionalInstructionsSchema.default(""),
});
export const RolePromptsSchema = z.object({
  planning: RolePromptSchema.default({}),
  implementation: RolePromptSchema.default({}),
  fci_analysis: RolePromptSchema.default({}),
});
export type RolePrompts = z.infer<typeof RolePromptsSchema>;
export const UpdateRolePromptSchema = z
  .object({
    additionalInstructions: AdditionalInstructionsSchema,
  })
  .strict();

export function appendRoleInstructions(base: string, additionalInstructions = ""): string {
  return additionalInstructions.trim()
    ? `${base}\n\nAdditional role instructions:\n${additionalInstructions}`
    : base;
}
