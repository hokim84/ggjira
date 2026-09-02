import { spawn } from "node:child_process";
import type { Logger } from "../logger.js";
import type { WorkerProvider, WorkerRequest, WorkerResult, WorkerRunHooks } from "./provider.js";

const DEFAULT_KILL_GRACE_MS = 5000;

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

function buildArgs(request: WorkerRequest): string[] {
  const args = [
    "-p",
    request.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    request.permissionMode,
    "--allowedTools",
    request.allowedTools.join(" "),
    "--no-session-persistence",
    "--model",
    request.model,
    "--effort",
    request.effort,
  ];
  if (request.appendSystemPrompt) {
    args.push("--append-system-prompt", request.appendSystemPrompt);
  }
  return args;
}

/** Splits a stream of chunks into complete lines, buffering any trailing partial line. */
class LineSplitter {
  private buffer = "";

  push(chunk: string, onLine: (line: string) => void): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.length > 0) onLine(line);
    }
  }

  flush(onLine: (line: string) => void): void {
    if (this.buffer.length > 0) onLine(this.buffer);
    this.buffer = "";
  }
}

export class ClaudeCodeCliProvider implements WorkerProvider {
  private readonly killGraceMs: number;

  constructor(
    private readonly logger?: Logger,
    killGraceMs: number = DEFAULT_KILL_GRACE_MS,
  ) {
    this.killGraceMs = killGraceMs;
  }

  async run(request: WorkerRequest, hooks: WorkerRunHooks = {}): Promise<WorkerResult> {
    const args = buildArgs(request);
    const start = Date.now();

    return new Promise<WorkerResult>((resolve) => {
      const child = spawn(request.command, args, {
        cwd: request.cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let finalResult: RawResultEvent | undefined;
      let timedOut = false;
      let spawnError: Error | undefined;
      const stdout = new LineSplitter();
      const stderrChunks: string[] = [];

      const killGroup = (signal: NodeJS.Signals) => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, signal);
        } catch {
          // process group may already be gone
        }
      };

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        killGroup("SIGTERM");
        setTimeout(() => killGroup("SIGKILL"), this.killGraceMs);
      }, request.timeoutMs);

      const handleLine = (line: string) => {
        hooks.onEvent?.(line);
        try {
          const parsed: unknown = JSON.parse(line);
          if (isRawResultEvent(parsed)) {
            finalResult = parsed;
          }
        } catch {
          this.logger?.warn({ layer: "worker", line }, "failed to parse stream-json line");
        }
      };

      child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk.toString("utf-8"), handleLine));
      child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString("utf-8")));

      child.on("error", (err) => {
        spawnError = err;
      });

      child.on("close", (code) => {
        clearTimeout(timeoutHandle);
        stdout.flush(handleLine);
        const durationMs = Date.now() - start;

        if (spawnError) {
          resolve({
            exitReason: "crashed",
            isError: true,
            summary: `Failed to spawn worker: ${spawnError.message}`,
            durationMs,
            exitCode: code,
          });
          return;
        }

        if (timedOut) {
          resolve({
            exitReason: "timeout",
            isError: true,
            summary: `Worker timed out after ${request.timeoutMs}ms`,
            durationMs,
            exitCode: code,
          });
          return;
        }

        if (code !== 0) {
          const stderrTail = stderrChunks.join("").slice(-2000);
          resolve({
            exitReason: "nonzero",
            isError: true,
            summary: finalResult?.result ?? `Worker exited with code ${code}. ${stderrTail}`.trim(),
            durationMs,
            exitCode: code,
            ...(finalResult?.session_id ? { sessionId: finalResult.session_id } : {}),
          });
          return;
        }

        resolve({
          exitReason: "completed",
          isError: finalResult?.is_error ?? false,
          summary: finalResult?.result ?? "(worker produced no result message)",
          durationMs,
          exitCode: code,
          ...(finalResult?.session_id ? { sessionId: finalResult.session_id } : {}),
          ...(finalResult?.total_cost_usd !== undefined
            ? { totalCostUsd: finalResult.total_cost_usd }
            : {}),
          ...(finalResult?.num_turns !== undefined ? { numTurns: finalResult.num_turns } : {}),
        });
      });
    });
  }
}
