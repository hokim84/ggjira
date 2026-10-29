import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
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

// The fake CLIs are POSIX shell scripts (test/fixtures/*.sh), which Windows cannot spawn
// (`spawn EFTYPE`). CI and `docker-compose.test.yml` run them on Linux (runbook §13).
describe.skipIf(process.platform === "win32")("CodexCliProvider", () => {
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

  it("reads AGENTS.md only from the repository folder (ADR 0065)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ggjira-codex-args-"));
    const argsFile = path.join(dir, "args.txt");
    vi.stubEnv("GGJIRA_FAKE_ARGS_FILE", argsFile);
    try {
      const provider = new CodexCliProvider(undefined, {
        command: path.join(FIXTURES_DIR, "records-args.sh"),
      });
      await provider.run(baseRequest({ cwd: dir }));
      const args = readFileSync(argsFile, "utf-8").split("\n");
      expect(args[args.indexOf("-c") + 1]).toBe("project_root_markers=[]");
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });

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
