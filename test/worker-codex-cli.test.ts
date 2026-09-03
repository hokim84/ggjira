import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CodexCliProvider } from "../src/worker/codex-cli.js";
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

describe("CodexCliProvider", () => {
  it("reads the last-message file as the summary on success", async () => {
    const provider = new CodexCliProvider(undefined, {
      command: path.join(FIXTURES_DIR, "codex-succeeds.sh"),
    });
    const events: string[] = [];

    const result = await provider.run(baseRequest(), { onEvent: (line) => events.push(line) });

    expect(result.exitReason).toBe("completed");
    expect(result.isError).toBe(false);
    expect(result.summary).toBe("codex finished the task");
    expect(events).toEqual(['{"type":"item.completed","item":{"type":"agent_message"}}']);
  });

  it("maps a non-zero exit to exitReason 'nonzero' and uses the last message as the summary", async () => {
    const provider = new CodexCliProvider(undefined, {
      command: path.join(FIXTURES_DIR, "codex-fails.sh"),
    });

    const result = await provider.run(baseRequest());

    expect(result.exitReason).toBe("nonzero");
    expect(result.isError).toBe(true);
    expect(result.summary).toBe("codex could not complete the task");
    expect(result.exitCode).toBe(1);
  });

  it("reports 'crashed' when the command cannot be spawned at all", async () => {
    const provider = new CodexCliProvider(undefined, {
      command: "/nonexistent/path/to/binary-xyz-ggjira",
    });

    const result = await provider.run(baseRequest());

    expect(result.exitReason).toBe("crashed");
    expect(result.isError).toBe(true);
  });

  it("times out and reports exitReason 'timeout'", async () => {
    const provider = new CodexCliProvider(undefined, {
      command: path.join(FIXTURES_DIR, "hangs-ignoring-sigterm.sh"),
      killGraceMs: 500,
    });

    const result = await provider.run(baseRequest({ timeoutMs: 800 }));

    expect(result.exitReason).toBe("timeout");
    expect(result.isError).toBe(true);
  }, 10000);

  it("extracts structuredOutput from a fenced json block in the last message", async () => {
    const provider = new CodexCliProvider(undefined, {
      command: path.join(FIXTURES_DIR, "codex-schema.sh"),
    });

    const result = await provider.run(baseRequest({ outputSchema: { type: "object" } }));

    expect(result.structuredOutput).toEqual({
      needsDecision: false,
      summary: "ok",
      tasks: [],
      keepTaskKeys: [],
    });
  });
});
