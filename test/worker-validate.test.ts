import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runValidateCommand, signedExitCode } from "../src/worker/validate.js";

// ADR 0068: what a validation summary shows in the Jira result comment.
describe("runValidateCommand summary", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ggjira-validate-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("shows a failed command's output from a line boundary, not a cut line", async () => {
    // 300 numbered lines of 20 characters each: more than the 2000-character tail.
    const command = `node -e "for (let i = 0; i < 300; i++) console.log(String(i).padStart(19, '-')); process.exit(2)"`;
    const result = await runValidateCommand(command, dir);

    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/exited 2: …\n/);
    const lines = result.summary.split("\n").slice(1);
    expect(lines.every((line) => line.length === 19)).toBe(true);
    expect(lines.at(-1)).toBe("----------------299");
  });

  it("keeps the whole output when it is short", async () => {
    const result = await runValidateCommand(
      `node -e "console.log('one failure'); process.exit(1)"`,
      dir,
    );
    expect(result.summary).toMatch(/exited 1: one failure$/);
  });

  it("names the timeout instead of a generic stop", async () => {
    const result = await runValidateCommand('node -e "setInterval(Date.now, 1000)"', dir, {
      timeoutMs: 300,
    });
    expect(result).toMatchObject({ ok: false, stopped: "timeout" });
    expect(result.summary).toContain("did not finish within 300 ms and was stopped");
  });

  it("reports the signed value of a Windows TerminateProcess exit code", () => {
    expect(signedExitCode(4294967295)).toBe(-1);
    expect(signedExitCode(3)).toBe(3);
    expect(signedExitCode(null)).toBeNull();
  });
});
