import type { CallUsage } from "../contracts/execution.js";

/**
 * Per-call token usage out of the CLIs' own event streams (M4-12, ADR 0042). Pure, so the parsing
 * is tested without spawning a CLI. Only what a stream actually carries is set; nothing defaults
 * to zero.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function withDefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/** What one Claude Code stream says about its call. */
export interface ClaudeCallInfo {
  model?: string;
  usage?: CallUsage;
}

/**
 * Claude Code stream-json: the `system`/`init` event names the model; the final `result` event
 * carries `usage` (`input_tokens`, `output_tokens`, `cache_read_input_tokens`,
 * `cache_creation_input_tokens` — cache reads are *not* part of `input_tokens`) and
 * `total_cost_usd`. Folds one event into `info`.
 */
export function readClaudeCallEvent(info: ClaudeCallInfo, event: unknown): ClaudeCallInfo {
  if (!isRecord(event)) return info;
  if (event.type === "system" && event.subtype === "init" && typeof event.model === "string") {
    return { ...info, model: event.model };
  }
  if (event.type !== "result") return info;
  const raw = isRecord(event.usage) ? event.usage : undefined;
  const cost =
    typeof event.total_cost_usd === "number" && event.total_cost_usd >= 0
      ? event.total_cost_usd
      : undefined;
  const usage = withDefined<CallUsage>({
    inputTokens: count(raw?.input_tokens),
    outputTokens: count(raw?.output_tokens),
    cacheReadTokens: count(raw?.cache_read_input_tokens),
    cacheCreationTokens: count(raw?.cache_creation_input_tokens),
    costUsd: cost,
  });
  const reported = Object.keys(usage).length > 0;
  const model =
    info.model ??
    (isRecord(event.modelUsage) ? Object.keys(event.modelUsage)[0] : undefined) ??
    undefined;
  return {
    ...(model ? { model } : {}),
    ...(reported ? { usage: { ...usage, cacheReadIncludedInInput: false } } : {}),
  };
}

/** What one Codex `exec --json` stream says about its call. */
export interface CodexCallInfo {
  threadId?: string;
  usage?: CallUsage;
  /** Why the turn failed, from `turn.failed` — the cause stderr does not tell (e.g. a model the
   *  account cannot use). */
  failure?: string;
}

/** `turn.failed` carries the API error as text, often itself a JSON error body. */
function codexFailureMessage(error: unknown): string | undefined {
  const text = isRecord(error) && typeof error.message === "string" ? error.message : undefined;
  if (!text) return undefined;
  try {
    const body: unknown = JSON.parse(text);
    if (isRecord(body)) {
      const inner = isRecord(body.error) ? body.error.message : body.message;
      if (typeof inner === "string" && inner) return inner;
    }
  } catch {
    // plain text
  }
  return text;
}

/**
 * Codex `exec --json`: `thread.started` carries the thread id; each `turn.completed` carries that
 * turn's `usage` (`input_tokens`, `cached_input_tokens`, `output_tokens` — cached input is a part
 * of `input_tokens`). Turns are summed. Folds one event into `info`.
 */
export function readCodexCallEvent(info: CodexCallInfo, event: unknown): CodexCallInfo {
  if (!isRecord(event)) return info;
  if (event.type === "thread.started" && typeof event.thread_id === "string") {
    return { ...info, threadId: event.thread_id };
  }
  if (event.type === "turn.failed") {
    const failure = codexFailureMessage(event.error);
    return failure ? { ...info, failure } : info;
  }
  if (event.type !== "turn.completed" || !isRecord(event.usage)) return info;
  const add = (a: number | undefined, b: number | undefined) =>
    a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
  const before = info.usage ?? {};
  const usage = withDefined<CallUsage>({
    inputTokens: add(before.inputTokens, count(event.usage.input_tokens)),
    outputTokens: add(before.outputTokens, count(event.usage.output_tokens)),
    cacheReadTokens: add(before.cacheReadTokens, count(event.usage.cached_input_tokens)),
  });
  return Object.keys(usage).length > 0
    ? { ...info, usage: { ...usage, cacheReadIncludedInInput: true } }
    : info;
}
