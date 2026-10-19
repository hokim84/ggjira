import { describe, expect, it } from "vitest";
import { executionRecord } from "../src/worker-runtime/executor.js";
import { readClaudeCallEvent, readCodexCallEvent } from "../src/worker/call-usage.js";
import type { WorkerResult } from "../src/worker/provider.js";
import { WorkerProviderConfigSchema } from "../src/contracts/provider.js";

/** M4-12 (ADR 0042): per-call usage as the CLIs report it, never invented. */
describe("readClaudeCallEvent", () => {
  it("takes the model from init and the usage from the result event, cache reads on top", () => {
    let info = readClaudeCallEvent({}, { type: "system", subtype: "init", model: "claude-x-1" });
    info = readClaudeCallEvent(info, { type: "assistant", message: {} });
    info = readClaudeCallEvent(info, {
      type: "result",
      total_cost_usd: 0.42,
      usage: {
        input_tokens: 120,
        output_tokens: 900,
        cache_read_input_tokens: 40000,
        cache_creation_input_tokens: 3000,
      },
    });
    expect(info).toEqual({
      model: "claude-x-1",
      usage: {
        inputTokens: 120,
        outputTokens: 900,
        cacheReadTokens: 40000,
        cacheCreationTokens: 3000,
        costUsd: 0.42,
        cacheReadIncludedInInput: false,
      },
    });
  });

  it("leaves usage out when the stream reports none, instead of zeros", () => {
    const info = readClaudeCallEvent({}, { type: "result", result: "done" });
    expect(info).toEqual({});
    expect(readClaudeCallEvent({}, "not json")).toEqual({});
  });
});

describe("readCodexCallEvent", () => {
  it("sums turns and marks cached input as part of input", () => {
    let info = readCodexCallEvent({}, { type: "thread.started", thread_id: "thread-1" });
    info = readCodexCallEvent(info, {
      type: "turn.completed",
      usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50 },
    });
    info = readCodexCallEvent(info, {
      type: "turn.completed",
      usage: { input_tokens: 500, cached_input_tokens: 400, output_tokens: 25 },
    });
    expect(info).toEqual({
      threadId: "thread-1",
      usage: {
        inputTokens: 1500,
        outputTokens: 75,
        cacheReadTokens: 1200,
        cacheReadIncludedInInput: true,
      },
    });
  });

  it("keeps fields a turn did not report absent", () => {
    const info = readCodexCallEvent({}, { type: "turn.completed", usage: { output_tokens: 7 } });
    expect(info.usage).toEqual({ outputTokens: 7, cacheReadIncludedInInput: true });
  });
});

describe("executionRecord", () => {
  const provider = WorkerProviderConfigSchema.parse({ id: "default", model: "sonnet" });
  const run = (overrides: Partial<WorkerResult>): WorkerResult => ({
    exitReason: "completed",
    isError: false,
    summary: "ok",
    durationMs: 1234.6,
    exitCode: 0,
    ...overrides,
  });

  it("names the model the CLI reported, else the configured one, and says which", () => {
    expect(
      executionRecord(provider, { result: run({ model: "claude-x-1", sessionId: "s-1" }) }),
    ).toEqual({
      providerId: "default",
      providerType: "claude-code",
      model: "claude-x-1",
      modelSource: "reported",
      callId: "s-1",
      exitReason: "completed",
      durationMs: 1235,
    });
    expect(executionRecord(provider, { result: run({}) })).toMatchObject({
      model: "sonnet",
      modelSource: "configured",
    });
  });

  it("names no model when a Codex provider leaves the choice to Codex's own config", () => {
    const codex = WorkerProviderConfigSchema.parse({ id: "codex", type: "codex" });
    expect(codex.model).toBeUndefined();
    expect(WorkerProviderConfigSchema.parse({ id: "claude" }).model).toBe("sonnet");
    const record = executionRecord(codex, { result: run({}) });
    expect(record).not.toHaveProperty("model");
    expect(record).not.toHaveProperty("modelSource");
    expect(executionRecord(codex, { result: run({ model: "gpt-x" }) })).toMatchObject({
      model: "gpt-x",
      modelSource: "reported",
    });
  });

  it("keeps a failed or crashed call, with whatever usage it reported", () => {
    expect(
      executionRecord(provider, {
        result: run({ exitReason: "timeout", isError: true, usage: { outputTokens: 10 } }),
      }),
    ).toMatchObject({ exitReason: "timeout", usage: { outputTokens: 10 } });
    expect(executionRecord(provider, { error: new Error("spawn"), durationMs: 5 })).toMatchObject({
      exitReason: "error",
      durationMs: 5,
    });
    expect(executionRecord(provider, { result: run({}) }).usage).toBeUndefined();
  });
});
