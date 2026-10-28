import { spawn } from "node:child_process";
import { killProcessTree } from "./spawn.js";

export interface ValidateResult {
  ok: boolean;
  summary: string;
  /** Set when the command did not finish on its own: the timeout fired or the signal aborted. */
  stopped?: "timeout" | "cancelled";
}

/** How much of a failed command's output the summary keeps (it ends up in a Jira comment). */
const FAILURE_TAIL_CHARS = 2000;
/** How much of the last output line a passed command's summary keeps. */
const LAST_LINE_CHARS = 200;

/** Runs `workspace.validateCommand` inside the worktree after the worker finishes. */
export async function runValidateCommand(
  command: string,
  cwd: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ValidateResult> {
  if (options.signal?.aborted)
    return { ok: false, summary: "validation cancelled", stopped: "cancelled" };
  return await new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stopped: ValidateResult["stopped"];
    const stopFor = (reason: "timeout" | "cancelled") => {
      stopped ??= reason;
      if (child.pid) killProcessTree(child.pid, true);
    };
    const onAbort = () => stopFor("cancelled");
    const timer = options.timeoutMs
      ? setTimeout(() => stopFor("timeout"), options.timeoutMs)
      : undefined;
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const chunks: string[] = [];
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf-8")));
    child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf-8")));
    child.on("error", (err) => {
      cleanup();
      resolve({ ok: false, summary: `failed to run "${command}": ${err.message}` });
    });
    child.on("close", (code) => {
      cleanup();
      const output = chunks.join("");
      if (stopped) {
        resolve({
          ok: false,
          summary:
            stopped === "timeout"
              ? `"${command}" did not finish within ${formatDuration(options.timeoutMs ?? 0)} and was stopped${withTail(output)}`
              : "validation cancelled",
          stopped,
        });
        return;
      }
      if (code === 0) {
        const last = lastLine(output);
        resolve({ ok: true, summary: `"${command}" passed${last ? ` — ${last}` : ""}` });
        return;
      }
      resolve({
        ok: false,
        summary: `"${command}" exited ${signedExitCode(code)}${withTail(output)}`,
      });
    });
  });
}

/** Windows reports a process ended by TerminateProcess(-1) as 4294967295; show the signed value. */
export function signedExitCode(code: number | null): number | null {
  return code !== null && code > 0x7fffffff ? code - 0x1_0000_0000 : code;
}

/** The end of the output, starting at a line boundary so no line is shown cut in half. */
function withTail(output: string): string {
  const trimmed = output.trim();
  if (!trimmed) return "";
  if (trimmed.length <= FAILURE_TAIL_CHARS) return `: ${trimmed}`;
  const tail = trimmed.slice(-FAILURE_TAIL_CHARS);
  const newline = tail.indexOf("\n");
  return `: …\n${newline >= 0 ? tail.slice(newline + 1) : tail}`;
}

/** The last non-empty output line, e.g. unittest's "OK (skipped=3)", so a pass shows what ran. */
function lastLine(output: string): string {
  const line =
    output
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .at(-1) ?? "";
  return line.length > LAST_LINE_CHARS ? `${line.slice(0, LAST_LINE_CHARS)}…` : line;
}

function formatDuration(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000} min`;
  if (ms >= 1000) return `${Math.round(ms / 1000)} s`;
  return `${ms} ms`;
}
