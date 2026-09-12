import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Logger } from "../logger.js";
import type { WorkerProvider, WorkerRequest, WorkerResult, WorkerRunHooks } from "./provider.js";
import { runProcessWithTimeout } from "./spawn.js";

export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface CodexCliProviderOptions {
  command?: string;
  model?: string;
  sandbox?: CodexSandboxMode;
  killGraceMs?: number;
}

/**
 * Best-effort extraction of a JSON value from free text: a fenced ```json
 * block if present, otherwise the largest {...} span.
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

/**
 * The Codex CLI has no --append-system-prompt / --json-schema equivalent
 * (unlike Claude Code), so role instructions and schema requirements are
 * folded directly into the prompt text instead of passed as separate flags.
 */
function buildPrompt(request: WorkerRequest): string {
  const parts: string[] = [];
  if (request.systemPrompt) parts.push(request.systemPrompt, "");
  parts.push(request.prompt);
  if (request.outputSchema) {
    parts.push(
      "",
      "Respond with your final answer as a single fenced ```json code block matching this JSON Schema, and nothing else after it:",
      "```json",
      JSON.stringify(request.outputSchema),
      "```",
    );
  }
  return parts.join("\n");
}

const DEFAULT_MODEL = "gpt-5-codex";

export class CodexCliProvider implements WorkerProvider {
  private readonly command: string;
  private readonly model: string;
  private readonly sandbox: CodexSandboxMode;
  private readonly killGraceMs: number | undefined;

  constructor(
    private readonly logger?: Logger,
    options: CodexCliProviderOptions = {},
  ) {
    this.command = options.command ?? "codex";
    this.model = options.model ?? DEFAULT_MODEL;
    this.sandbox = options.sandbox ?? "workspace-write";
    this.killGraceMs = options.killGraceMs;
  }

  async run(request: WorkerRequest, hooks: WorkerRunHooks = {}): Promise<WorkerResult> {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "ggjira-codex-"));
    const lastMessagePath = path.join(tmpDir, "last-message.txt");
    const sandbox = request.readOnly ? "read-only" : this.sandbox;

    const args = [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-C",
      request.cwd,
      "--sandbox",
      sandbox,
      "-m",
      this.model,
      "--output-last-message",
      lastMessagePath,
      buildPrompt(request),
    ];

    try {
      const result = await runProcessWithTimeout({
        command: this.command,
        args,
        cwd: request.cwd,
        timeoutMs: request.timeoutMs,
        ...(this.killGraceMs !== undefined ? { killGraceMs: this.killGraceMs } : {}),
        ...(hooks.signal ? { signal: hooks.signal } : {}),
        onLine: (line) => {
          hooks.onEvent?.(line);
          try {
            JSON.parse(line);
          } catch {
            this.logger?.debug({ layer: "worker", line }, "non-JSON codex output line");
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

      let lastMessage = "";
      try {
        lastMessage = readFileSync(lastMessagePath, "utf-8").trim();
      } catch {
        // codex didn't write a last-message file (e.g. it crashed before producing one)
      }

      const structuredOutput =
        request.outputSchema && lastMessage ? extractJsonBlock(lastMessage) : undefined;

      if (result.code !== 0) {
        return {
          exitReason: "nonzero",
          isError: true,
          summary:
            lastMessage || `Worker exited with code ${result.code}. ${result.stderrTail}`.trim(),
          durationMs: result.durationMs,
          exitCode: result.code,
        };
      }

      return {
        exitReason: "completed",
        isError: false,
        summary: lastMessage || "(worker produced no final message)",
        durationMs: result.durationMs,
        exitCode: result.code,
        ...(structuredOutput !== undefined ? { structuredOutput } : {}),
      };
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}
