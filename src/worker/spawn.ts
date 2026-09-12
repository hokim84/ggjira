import { spawn } from "node:child_process";

const DEFAULT_KILL_GRACE_MS = 5000;

export interface SpawnRunOptions {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  killGraceMs?: number;
  signal?: AbortSignal;
  /** Called with each complete stdout line as it arrives. */
  onLine?: (line: string) => void;
}

export interface SpawnRunResult {
  code: number | null;
  timedOut: boolean;
  spawnError: Error | undefined;
  /** Last ~2000 chars of stderr, for error summaries. */
  stderrTail: string;
  durationMs: number;
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

/**
 * Runs a CLI worker process to completion with a hard timeout: on timeout,
 * SIGTERMs the whole process group, then SIGKILLs it after a grace period.
 * Shared by every WorkerProvider implementation (the process-control
 * behavior — timeout, group kill, line buffering — is provider-agnostic;
 * only argument-building and result-parsing differ per CLI).
 */
export function runProcessWithTimeout(opts: SpawnRunOptions): Promise<SpawnRunResult> {
  const start = Date.now();
  const killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  return new Promise<SpawnRunResult>((resolve) => {
    const child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

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
      setTimeout(() => killGroup("SIGKILL"), killGraceMs);
    }, opts.timeoutMs);

    const handleAbort = () => {
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), killGraceMs);
    };
    opts.signal?.addEventListener("abort", handleAbort, { once: true });
    if (opts.signal?.aborted) handleAbort();

    const handleLine = (line: string) => opts.onLine?.(line);

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk.toString("utf-8"), handleLine));
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString("utf-8")));

    child.on("error", (err) => {
      spawnError = err;
    });

    child.on("close", (code) => {
      clearTimeout(timeoutHandle);
      opts.signal?.removeEventListener("abort", handleAbort);
      stdout.flush(handleLine);
      resolve({
        code,
        timedOut,
        spawnError,
        stderrTail: stderrChunks.join("").slice(-2000),
        durationMs: Date.now() - start,
      });
    });
  });
}
