import { tmpdir } from "node:os";
import type { Logger } from "../logger.js";
import type {
  UsageReading,
  WorkerProvider,
  WorkerRequest,
  WorkerResult,
  WorkerRunHooks,
} from "./provider.js";
import { runProcessWithTimeout } from "./spawn.js";
import { parseClaudeRateLimitEvent } from "./usage.js";

export type ClaudeCodeEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type ClaudeCodePermissionMode =
  | "acceptEdits"
  | "auto"
  | "bypassPermissions"
  | "manual"
  | "dontAsk"
  | "plan";

export interface ClaudeCodeCliProviderOptions {
  command?: string;
  model?: string;
  effort?: ClaudeCodeEffort;
  permissionMode?: ClaudeCodePermissionMode;
  allowedTools?: string[];
  killGraceMs?: number;
}

interface RawResultEvent {
  type: "result";
  is_error?: boolean;
  result?: string;
  duration_ms?: number;
  total_cost_usd?: number;
  num_turns?: number;
  session_id?: string;
}

function isRawResultEvent(value: unknown): value is RawResultEvent {
  return (
    typeof value === "object" && value !== null && (value as { type?: unknown }).type === "result"
  );
}

/**
 * Best-effort extraction of a JSON value from free text: a fenced ```json
 * block if present, otherwise the largest {...} span. Used when --json-schema
 * output doesn't land as clean, directly-parseable JSON in `result`.
 */
function extractJsonBlock(text: string): unknown {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? text.match(/(\{[\s\S]*\})/)?.[1];
  if (!candidate) return undefined;
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

/** Claude Code has no command that reports plan usage without a model call, so the connect-time
 *  probe is the smallest possible prompt on the cheapest model, with no tools (ADR 0028). */
const USAGE_PROBE_MODEL = "haiku";
const USAGE_PROBE_TIMEOUT_MS = 60_000;

const DEFAULT_ALLOWED_TOOLS = ["Edit", "Write", "Read", "Glob", "Grep"];
const READ_ONLY_TOOLS = ["Read", "Glob", "Grep"];

export class ClaudeCodeCliProvider implements WorkerProvider {
  private readonly command: string;
  private readonly model: string;
  private readonly effort: ClaudeCodeEffort;
  private readonly permissionMode: ClaudeCodePermissionMode;
  private readonly allowedTools: string[];
  private readonly killGraceMs: number | undefined;

  constructor(
    private readonly logger?: Logger,
    options: ClaudeCodeCliProviderOptions = {},
  ) {
    this.command = options.command ?? "claude";
    this.model = options.model ?? "sonnet";
    this.effort = options.effort ?? "high";
    this.permissionMode = options.permissionMode ?? "acceptEdits";
    this.allowedTools = options.allowedTools ?? DEFAULT_ALLOWED_TOOLS;
    this.killGraceMs = options.killGraceMs;
  }

  private buildArgs(request: WorkerRequest): string[] {
    const permissionMode = request.readOnly ? "dontAsk" : this.permissionMode;
    const allowedTools = request.readOnly ? READ_ONLY_TOOLS : this.allowedTools;
    const args = [
      "-p",
      request.prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      permissionMode,
      "--allowedTools",
      allowedTools.join(" "),
      "--no-session-persistence",
      "--model",
      this.model,
      "--effort",
      this.effort,
    ];
    if (request.systemPrompt) {
      args.push("--append-system-prompt", request.systemPrompt);
    }
    if (request.outputSchema) {
      args.push("--json-schema", JSON.stringify(request.outputSchema));
    }
    return args;
  }

  async run(request: WorkerRequest, hooks: WorkerRunHooks = {}): Promise<WorkerResult> {
    let finalResult: RawResultEvent | undefined;

    const result = await runProcessWithTimeout({
      command: this.command,
      args: this.buildArgs(request),
      cwd: request.cwd,
      timeoutMs: request.timeoutMs,
      ...(this.killGraceMs !== undefined ? { killGraceMs: this.killGraceMs } : {}),
      ...(hooks.signal ? { signal: hooks.signal } : {}),
      onLine: (line) => {
        hooks.onEvent?.(line);
        try {
          const parsed: unknown = JSON.parse(line);
          if (isRawResultEvent(parsed)) {
            finalResult = parsed;
          }
          const usage = parseClaudeRateLimitEvent(parsed);
          if (usage) hooks.onUsage?.(usage);
        } catch {
          this.logger?.warn({ layer: "worker", line }, "failed to parse stream-json line");
        }
      },
    });

    if (result.spawnError) {
      return {
        exitReason: "crashed",
        isError: true,
        summary: `Failed to spawn worker: ${result.spawnError.message}`,
        durationMs: result.durationMs,
        exitCode: result.code,
      };
    }

    if (result.timedOut) {
      return {
        exitReason: "timeout",
        isError: true,
        summary: `Worker timed out after ${request.timeoutMs}ms`,
        durationMs: result.durationMs,
        exitCode: result.code,
      };
    }

    const structuredOutput =
      request.outputSchema && finalResult?.result
        ? extractJsonBlock(finalResult.result)
        : undefined;

    if (result.code !== 0) {
      return {
        exitReason: "nonzero",
        isError: true,
        summary:
          finalResult?.result ??
          `Worker exited with code ${result.code}. ${result.stderrTail}`.trim(),
        durationMs: result.durationMs,
        exitCode: result.code,
        ...(finalResult?.session_id ? { sessionId: finalResult.session_id } : {}),
      };
    }

    return {
      exitReason: "completed",
      isError: finalResult?.is_error ?? false,
      summary: finalResult?.result ?? "(worker produced no result message)",
      durationMs: result.durationMs,
      exitCode: result.code,
      ...(finalResult?.session_id ? { sessionId: finalResult.session_id } : {}),
      ...(finalResult?.total_cost_usd !== undefined
        ? { totalCostUsd: finalResult.total_cost_usd }
        : {}),
      ...(finalResult?.num_turns !== undefined ? { numTurns: finalResult.num_turns } : {}),
      ...(structuredOutput !== undefined ? { structuredOutput } : {}),
    };
  }

  async readUsage(): Promise<UsageReading> {
    let usage: UsageReading | undefined;
    const probe = await runProcessWithTimeout({
      command: this.command,
      args: [
        "-p",
        "Reply with OK.",
        "--output-format",
        "stream-json",
        "--verbose",
        "--no-session-persistence",
        "--model",
        USAGE_PROBE_MODEL,
        "--tools",
        "",
        "--permission-mode",
        "dontAsk",
      ],
      cwd: tmpdir(),
      timeoutMs: USAGE_PROBE_TIMEOUT_MS,
      onLine: (line) => {
        try {
          usage = parseClaudeRateLimitEvent(JSON.parse(line)) ?? usage;
        } catch {
          // not JSON; ignore
        }
      },
    });
    const planType = await this.readPlanType();
    const withPlan = planType ? { planType } : {};
    if (usage) return { ...usage, ...withPlan };
    const why = probe.spawnError
      ? `could not run ${this.command}: ${probe.spawnError.message}`
      : probe.timedOut
        ? "usage probe timed out"
        : probe.code !== 0
          ? `usage probe exited with code ${probe.code}. ${probe.stderrTail}`.trim()
          : "Claude Code reported no plan usage (API key billing has no plan limits)";
    return { windows: [], error: why, ...withPlan };
  }

  /** `claude auth status` prints JSON with `subscriptionType` (pro, max, ...). */
  private async readPlanType(): Promise<string | undefined> {
    const lines: string[] = [];
    const result = await runProcessWithTimeout({
      command: this.command,
      args: ["auth", "status"],
      cwd: tmpdir(),
      timeoutMs: 15_000,
      onLine: (line) => lines.push(line),
    });
    if (result.spawnError || result.code !== 0) return undefined;
    try {
      const status = JSON.parse(lines.join("\n")) as { subscriptionType?: unknown };
      return typeof status.subscriptionType === "string" ? status.subscriptionType : undefined;
    } catch {
      return undefined;
    }
  }
}
