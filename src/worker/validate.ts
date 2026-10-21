import { spawn } from "node:child_process";
import { killProcessTree } from "./spawn.js";

export interface ValidateResult {
  ok: boolean;
  summary: string;
}

/** Runs `workspace.validateCommand` inside the worktree after the worker finishes. */
export async function runValidateCommand(
  command: string,
  cwd: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ValidateResult> {
  if (options.signal?.aborted) return { ok: false, summary: "validation cancelled" };
  return await new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stopped = false;
    const stop = () => {
      stopped = true;
      if (child.pid) killProcessTree(child.pid, true);
    };
    const timer = options.timeoutMs ? setTimeout(stop, options.timeoutMs) : undefined;
    options.signal?.addEventListener("abort", stop, { once: true });
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);
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
      const tail = chunks.join("").slice(-2000).trim();
      resolve({
        ok: code === 0 && !stopped,
        summary: stopped
          ? "validation cancelled or timed out"
          : code === 0
            ? `"${command}" passed`
            : `"${command}" exited ${code}${tail ? `: ${tail}` : ""}`,
      });
    });
  });
}
