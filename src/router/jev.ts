import { z } from "zod";
import type { FetchLike } from "./github.js";

/**
 * TypeSafe's System One API (`POST /v1/systemone`, docs.typesafe.ai/api): one `state` judged
 * against typed questions, each answer with calibrated probabilities and a confidence. Router
 * uses it through `src/router/assessment.ts` only (ADR 0030); nothing here decides anything.
 */
export const JEV_BASE_URL = "https://api.typesafe.ai/v1";

export type JevQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "noul"; instructions: string };

const ChoiceAnswerSchema = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  probabilities: z.record(z.string(), z.number()).default({}),
  confidence: z.number().min(0).max(1),
});
const ScoreAnswerSchema = z.object({
  type: z.literal("score"),
  score: z.number(),
  probabilities: z.record(z.string(), z.number()).default({}),
  confidence: z.number().min(0).max(1),
});
const NoulAnswerSchema = z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) });

export const JevAnswerSchema = z.discriminatedUnion("type", [
  ChoiceAnswerSchema,
  ScoreAnswerSchema,
  NoulAnswerSchema,
]);
export type JevAnswer = z.infer<typeof JevAnswerSchema>;

export const JevResponseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), JevAnswerSchema),
  usage: z
    .object({
      input_tokens: z.number().int().optional(),
      output_tokens: z.number().int().optional(),
    })
    .default({}),
});
export type JevResponse = z.infer<typeof JevResponseSchema>;

export class JevError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "JevError";
  }
}

export interface JevClientOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

/** 429 (rate limit) and 529 (overloaded) are the documented retryable answers. */
const RETRYABLE = new Set([429, 529]);
const MAX_ATTEMPTS = 3;

export class JevClient {
  readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: JevClientOptions) {
    this.model = options.model ?? "jev-latest";
    this.baseUrl = (options.baseUrl ?? JEV_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async systemOne(
    state: unknown,
    questions: Record<string, JevQuestion>,
  ): Promise<JevResponse & { latencyMs: number }> {
    const body = JSON.stringify({ state, model: this.model, questions });
    for (let attempt = 1; ; attempt++) {
      const startedAt = Date.now();
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}/systemone`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.options.apiKey}`,
            "content-type": "application/json",
          },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        const timedOut = error instanceof Error && error.name === "TimeoutError";
        throw new JevError(
          timedOut
            ? `Jev did not answer within ${this.timeoutMs}ms`
            : `Jev request failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (RETRYABLE.has(response.status) && attempt < MAX_ATTEMPTS) {
        await this.sleep(500 * 2 ** (attempt - 1));
        continue;
      }
      const text = await response.text();
      if (!response.ok) {
        throw new JevError(
          `Jev answered ${response.status}: ${text.slice(0, 300)}`,
          response.status,
        );
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new JevError("Jev answered with non-JSON", response.status);
      }
      const parsed = JevResponseSchema.safeParse(json);
      if (!parsed.success) {
        throw new JevError(`Jev answer has an unexpected shape: ${parsed.error.message}`);
      }
      return { ...parsed.data, latencyMs: Date.now() - startedAt };
    }
  }
}
