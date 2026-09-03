import { spawn } from "node:child_process";

export interface ValidateResult {
  ok: boolean;
  summary: string;
}

/** Runs `workspace.validateCommand` inside the worktree after the worker finishes. */
export async function runValidateCommand(command: string, cwd: string): Promise<ValidateResult> {
  return await new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: string[] = [];
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf-8")));
    child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf-8")));
    child.on("error", (err) =>
      resolve({ ok: false, summary: `failed to run "${command}": ${err.message}` }),
    );
    child.on("close", (code) => {
      const tail = chunks.join("").slice(-2000).trim();
      resolve({
        ok: code === 0,
        summary:
          code === 0
            ? `"${command}" passed`
            : `"${command}" exited ${code}${tail ? `: ${tail}` : ""}`,
      });
    });
  });
}
