import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ClaudeCodeCliProvider } from "../src/worker/claude-code-cli.js";
import { CodexCliProvider } from "../src/worker/codex-cli.js";
import type { UsageReading } from "../src/worker/provider.js";
import { parseClaudeRateLimitEvent, parseCodexRateLimits } from "../src/worker/usage.js";

const FIXTURES_DIR = fileURLToPath(new URL("./fixtures/fake-workers/", import.meta.url));

describe("plan usage parsing (ADR 0028)", () => {
  it("turns Claude Code's rate_limit_event fractions into percentages", () => {
    expect(
      parseClaudeRateLimitEvent({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed",
          unifiedWindows: {
            five_hour: { utilization: 0.11, resetsAt: 1790674200 },
            seven_day: { utilization: 0.17, resetsAt: 1790906400 },
          },
        },
      }),
    ).toEqual({
      status: "allowed",
      windows: [
        { id: "five_hour", usedPercent: 11, resetsAt: "2026-09-29T09:30:00.000Z" },
        { id: "seven_day", usedPercent: 17, resetsAt: "2026-10-02T02:00:00.000Z" },
      ],
    });
  });

  it("falls back to the single rateLimitType window, and ignores other lines", () => {
    expect(
      parseClaudeRateLimitEvent({
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", rateLimitType: "five_hour", utilization: 1 },
      }),
    ).toEqual({ status: "rejected", windows: [{ id: "five_hour", usedPercent: 100 }] });
    expect(parseClaudeRateLimitEvent({ type: "result" })).toBeUndefined();
    expect(parseClaudeRateLimitEvent("text")).toBeUndefined();
  });

  it("names Codex's windows by length and keeps the plan", () => {
    expect(
      parseCodexRateLimits({
        rateLimits: {
          primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: 1790674690 },
          secondary: { usedPercent: 1, windowDurationMins: 60 },
          planType: "plus",
          rateLimitReachedType: "primary",
        },
      }),
    ).toEqual({
      status: "rejected",
      planType: "plus",
      windows: [
        {
          id: "five_hour",
          usedPercent: 3,
          resetsAt: "2026-09-29T09:38:10.000Z",
          windowMinutes: 300,
        },
        { id: "secondary", usedPercent: 1, windowMinutes: 60 },
      ],
    });
    expect(parseCodexRateLimits({})).toBeUndefined();
  });
});

describe("ClaudeCodeCliProvider usage", () => {
  const provider = new ClaudeCodeCliProvider(undefined, {
    command: path.join(FIXTURES_DIR, "claude-usage.sh"),
  });

  it("reports the rate_limit_event it sees during a run", async () => {
    const seen: UsageReading[] = [];
    const result = await provider.run(
      { prompt: "x", cwd: process.cwd(), timeoutMs: 5000 },
      { onUsage: (usage) => seen.push(usage) },
    );
    expect(result.exitReason).toBe("completed");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      status: "allowed_warning",
      windows: [
        { id: "five_hour", usedPercent: 81.2 },
        { id: "seven_day", usedPercent: 17 },
      ],
    });
  });

  it("probes usage with a tiny run and adds the plan from auth status", async () => {
    const usage = await provider.readUsage();
    expect(usage).toMatchObject({
      planType: "max",
      status: "allowed_warning",
      windows: [{ id: "five_hour" }, { id: "seven_day" }],
    });
    expect(usage.error).toBeUndefined();
  });

  it("says why when the probe reports no usage", async () => {
    const usage = await new ClaudeCodeCliProvider(undefined, {
      command: path.join(FIXTURES_DIR, "succeeds.sh"),
    }).readUsage();
    expect(usage.windows).toEqual([]);
    expect(usage.error).toMatch(/no plan usage/);
  });
});

describe("CodexCliProvider usage", () => {
  const provider = new CodexCliProvider(undefined, {
    command: path.join(FIXTURES_DIR, "codex-app-server.sh"),
  });

  it("reads rate limits from app-server without a model call", async () => {
    expect(await provider.readUsage()).toEqual({
      planType: "plus",
      windows: [
        {
          id: "five_hour",
          usedPercent: 3,
          resetsAt: "2026-09-29T09:38:10.000Z",
          windowMinutes: 300,
        },
        {
          id: "seven_day",
          usedPercent: 61.3,
          resetsAt: "2026-10-05T01:07:55.000Z",
          windowMinutes: 10080,
        },
      ],
    });
  });

  it("reads usage after a run only when someone listens", async () => {
    const seen: UsageReading[] = [];
    const result = await provider.run(
      { prompt: "x", cwd: process.cwd(), timeoutMs: 5000 },
      { onUsage: (usage) => seen.push(usage) },
    );
    expect(result.summary).toBe("codex finished the task");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.windows).toHaveLength(2);
  });

  it("reports an error when app-server exits without answering", async () => {
    const usage = await new CodexCliProvider(undefined, {
      command: path.join(FIXTURES_DIR, "codex-fails.sh"),
    }).readUsage();
    expect(usage.windows).toEqual([]);
    expect(usage.error).toMatch(/exited/);
  });
});
