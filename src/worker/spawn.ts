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
 * Terminates `pid` and every process it spawned (docs/router-service-implementation-plan.md
 * §3 "Windows와 Linux의 프로세스 트리 종료를 모두 구현·검증한다").
 *
 * - Windows has no process groups addressable by `process.kill(-pid)` (that throws), so this
 *   uses `taskkill /T` — first politely, then with `/F` when `force` is set.
 * - Elsewhere the child was spawned `detached`, which makes it a process-group leader, so
 *   signalling `-pid` reaches the whole group.
 *
 * Best-effort by design: the tree may already be gone.
 */
export function killProcessTree(pid: number, force: boolean): void {
  if (process.platform === "win32") {
    const args = ["/pid", String(pid), "/T", ...(force ? ["/F"] : [])];
    try {
      const killer = spawn("taskkill", args, { stdio: "ignore", windowsHide: true });
      killer.on("error", () => {
        // taskkill missing or the tree already exited; nothing more to do.
      });
    } catch {
      // spawn itself failed synchronously; same as above.
    }
    return;
  }
  try {
    process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    // process group may already be gone
  }
}

/**
 * Runs a CLI worker process to completion with a hard timeout: on timeout,
 * asks the whole process tree to stop, then force-kills it after a grace period.
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
      // Process-group leader on POSIX so `killProcessTree` can signal `-pid`. On Windows,
      // `detached` would only open a separate console; `taskkill /T` walks the tree instead.
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let timedOut = false;
    let spawnError: Error | undefined;
    const stdout = new LineSplitter();
    const stderrChunks: string[] = [];

    let exited = false;
    let forceKillHandle: NodeJS.Timeout | undefined;
    // Ask the tree to stop, then force it after the grace period (§3 "중단 시 자식 프로세스 종료를
    // 요청하고 5초 후 강제 종료한다"). Only the first request schedules the force kill.
    const stopTree = () => {
      if (child.pid === undefined || exited || forceKillHandle) return;
      const pid = child.pid;
      killProcessTree(pid, false);
      forceKillHandle = setTimeout(() => {
        if (!exited) killProcessTree(pid, true);
      }, killGraceMs);
    };

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      stopTree();
    }, opts.timeoutMs);

    const handleAbort = () => stopTree();
    opts.signal?.addEventListener("abort", handleAbort, { once: true });
    if (opts.signal?.aborted) handleAbort();

    const handleLine = (line: string) => opts.onLine?.(line);

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk.toString("utf-8"), handleLine));
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString("utf-8")));

    child.on("error", (err) => {
      spawnError = err;
    });

    child.on("close", (code) => {
      exited = true;
      clearTimeout(timeoutHandle);
      if (forceKillHandle) clearTimeout(forceKillHandle);
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
