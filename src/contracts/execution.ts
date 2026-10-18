import { z } from "zod";

const TokenCount = z.number().int().nonnegative();

/**
 * Token usage of one provider call, exactly as far as the CLI reported it (M4-12, ADR 0042). A
 * missing field means "not reported" — never zero. `cacheReadIncludedInInput` says how the fields
 * relate, so nobody adds cached tokens twice: Codex counts cached input inside `inputTokens`,
 * Claude Code reports it on top.
 */
export const CallUsageSchema = z.object({
  inputTokens: TokenCount.optional(),
  outputTokens: TokenCount.optional(),
  cacheReadTokens: TokenCount.optional(),
  cacheCreationTokens: TokenCount.optional(),
  cacheReadIncludedInInput: z.boolean().optional(),
  costUsd: z.number().nonnegative().optional(),
});
export type CallUsage = z.infer<typeof CallUsageSchema>;

export const EXECUTION_EXIT_REASONS = [
  "completed",
  "timeout",
  "crashed",
  "nonzero",
  "error",
] as const;

/**
 * The provider call behind a result (M4-12): which provider and model ran, the CLI's own call id
 * (Claude Code session, Codex thread), how it ended and what it used. Present whenever the worker
 * actually called a provider — failed and cancelled runs included; absent when it refused before.
 */
export const ExecutionRecordSchema = z.object({
  providerId: z.string().min(1),
  providerType: z.string().min(1),
  model: z.string().min(1).optional(),
  /** `reported`: the CLI said which model ran; `configured`: only the worker's setting is known. */
  modelSource: z.enum(["reported", "configured"]).optional(),
  callId: z.string().min(1).optional(),
  exitReason: z.enum(EXECUTION_EXIT_REASONS),
  durationMs: z.number().int().nonnegative().optional(),
  numTurns: z.number().int().nonnegative().optional(),
  usage: CallUsageSchema.optional(),
});
export type ExecutionRecord = z.infer<typeof ExecutionRecordSchema>;
