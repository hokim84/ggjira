import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeCodeCliProvider } from "../src/worker/claude-code-cli.js";
import type { WorkerRequest } from "../src/worker/provider.js";

const FIXTURES_DIR = fileURLToPath(new URL("./fixtures/fake-workers/", import.meta.url));

function baseRequest(overrides: Partial<WorkerRequest> = {}): WorkerRequest {
  return {
    prompt: "do the thing",
    cwd: process.cwd(),
    timeoutMs: 5000,
    ...overrides,
  };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("ClaudeCodeCliProvider", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parses stream-json lines and extracts the final result on success", async () => {
    const provider = new ClaudeCodeCliProvider(undefined, {
      command: path.join(FIXTURES_DIR, "succeeds.sh"),
    });
    const events: string[] = [];

    const result = await provider.run(baseRequest(), { onEvent: (line) => events.push(line) });

    expect(events).toHaveLength(3);
    expect(result).toMatchObject({
      exitReason: "completed",
      isError: false,
      summary: "done",
      exitCode: 0,
      sessionId: "fake-session",
      totalCostUsd: 0.01,
      numTurns: 2,
    });
  });

  it("maps a non-zero exit with a result event to exitReason 'nonzero'", async () => {
    const provider = new ClaudeCodeCliProvider(undefined, {
      command: path.join(FIXTURES_DIR, "fails.sh"),
    });

    const result = await provider.run(baseRequest());

    expect(result.exitReason).toBe("nonzero");
    expect(result.isError).toBe(true);
    expect(result.summary).toBe("could not complete the task");
    expect(result.exitCode).toBe(1);
  });

  it("preserves unparsable stdout lines via onEvent without crashing", async () => {
    const provider = new ClaudeCodeCliProvider(undefined, {
      command: path.join(FIXTURES_DIR, "crashes.sh"),
    });
    const events: string[] = [];

    const result = await provider.run(baseRequest(), { onEvent: (line) => events.push(line) });

    expect(events).toEqual(["not json, this line should be preserved raw but fail to parse"]);
    expect(result.exitReason).toBe("nonzero");
    expect(result.exitCode).toBe(2);
    expect(result.summary).toContain("exited with code 2");
  });

  it("reports 'crashed' when the command cannot be spawned at all", async () => {
    const provider = new ClaudeCodeCliProvider(undefined, {
      command: "/nonexistent/path/to/binary-xyz-ggjira",
    });

    const result = await provider.run(baseRequest());

    expect(result.exitReason).toBe("crashed");
    expect(result.isError).toBe(true);
  });

  it("kills the full process group on timeout, even children that ignore SIGTERM", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ggjira-timeout-test-"));
    tempDirs.push(dir);
    const pidFile = path.join(dir, "pids.txt");

    const previousPidFile = process.env.PID_FILE;
    process.env.PID_FILE = pidFile;

    const provider = new ClaudeCodeCliProvider(undefined, {
      command: path.join(FIXTURES_DIR, "hangs-ignoring-sigterm.sh"),
      killGraceMs: 500,
    });
    const result = await provider.run(baseRequest({ timeoutMs: 800 }));

    process.env.PID_FILE = previousPidFile;

    expect(result.exitReason).toBe("timeout");
    expect(result.isError).toBe(true);

    // give the OS a brief moment to finish reaping the killed processes
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(existsSync(pidFile)).toBe(true);
    const pids = readFileSync(pidFile, "utf-8")
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);

    expect(pids.length).toBeGreaterThanOrEqual(2);
    for (const pid of pids) {
      expect(processIsAlive(pid)).toBe(false);
    }
  }, 10000);
});
