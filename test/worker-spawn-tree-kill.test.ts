import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { runProcessWithTimeout } from "../src/worker/spawn.js";

/** Parent: spawns a long-lived grandchild, prints both pids, then idles forever. */
const PARENT_SCRIPT = `
const { spawn } = require("node:child_process");
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
console.log(JSON.stringify({ parent: process.pid, grandchild: grandchild.pid }));
setInterval(() => {}, 1000);
`;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else — still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitUntilDead(pids: number[], timeoutMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let alive = pids.filter(isAlive);
  while (alive.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    alive = alive.filter(isAlive);
  }
  return alive;
}

/**
 * Uses a real `node` child and grandchild — no AI CLI — to check that abort and timeout both
 * take down the whole tree, not just the direct child, on this platform (win32 via
 * `taskkill /T`, POSIX via process-group signals). docs/router-service-implementation-plan.md §5
 * "Windows·Linux에서 provider 실행과 프로세스 트리 취소를 검증한다".
 */
describe("runProcessWithTimeout process-tree termination", () => {
  async function runAndCapturePids(
    trigger: "abort" | "timeout",
  ): Promise<{ pids: number[]; timedOut: boolean }> {
    const abort = new AbortController();
    let pids: number[] = [];
    const result = await runProcessWithTimeout({
      command: process.execPath,
      args: ["-e", PARENT_SCRIPT],
      cwd: tmpdir(),
      timeoutMs: trigger === "timeout" ? 1_500 : 60_000,
      killGraceMs: 1_000,
      signal: abort.signal,
      onLine: (line) => {
        const parsed = JSON.parse(line) as { parent: number; grandchild: number };
        pids = [parsed.parent, parsed.grandchild];
        if (trigger === "abort") abort.abort();
      },
    });
    return { pids, timedOut: result.timedOut };
  }

  it("kills the child and its grandchild on abort", async () => {
    const { pids } = await runAndCapturePids("abort");
    expect(pids).toHaveLength(2);
    expect(await waitUntilDead(pids, 5_000)).toEqual([]);
  }, 20_000);

  it("kills the child and its grandchild on timeout", async () => {
    const { pids, timedOut } = await runAndCapturePids("timeout");
    expect(timedOut).toBe(true);
    expect(pids).toHaveLength(2);
    expect(await waitUntilDead(pids, 5_000)).toEqual([]);
  }, 20_000);
});
