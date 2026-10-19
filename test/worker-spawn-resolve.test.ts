import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveCommand, runProcessWithTimeout } from "../src/worker/spawn.js";

/** What `npm install -g` writes for a CLI whose bin is a Node script (cmd-shim). */
const NPM_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*
`;

/**
 * Windows lookup for provider CLIs: `spawn` without a shell cannot run an npm `.cmd` shim
 * (`spawn codex ENOENT`), so the worker resolves it to the shim's Node script. The lookup runs
 * on any platform with `platform: "win32"` injected.
 */
describe("resolveCommand", () => {
  let dir: string;
  const env = (extra: NodeJS.ProcessEnv = {}) => ({
    Path: dir,
    PATHEXT: ".COM;.EXE;.BAT;.CMD;.VBS;.JS",
    ...extra,
  });

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ggjira-resolve-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs an npm .cmd shim's script with this Node instead of the shim", () => {
    writeFileSync(path.join(dir, "codex.cmd"), NPM_SHIM);
    expect(resolveCommand("codex", ["exec", "a prompt & more"], env(), "win32")).toEqual({
      command: process.execPath,
      args: [
        path.join(dir, "node_modules", "@openai", "codex", "bin", "codex.js"),
        "exec",
        "a prompt & more",
      ],
    });
  });

  it("prefers an executable found earlier in PATHEXT order", () => {
    writeFileSync(path.join(dir, "claude.exe"), "");
    writeFileSync(path.join(dir, "claude.cmd"), NPM_SHIM);
    expect(resolveCommand("claude", ["-p"], env(), "win32")).toEqual({
      command: path.join(dir, "claude.exe"),
      args: ["-p"],
    });
  });

  it("searches PATH directories in order", () => {
    const first = path.join(dir, "first");
    const second = path.join(dir, "second");
    mkdirSync(first);
    mkdirSync(second);
    writeFileSync(path.join(second, "codex.exe"), "");
    const resolved = resolveCommand(
      "codex",
      [],
      env({ Path: [first, second].join(path.delimiter) }),
      "win32",
    );
    expect(resolved.command).toBe(path.join(second, "codex.exe"));
  });

  it("leaves the command unchanged when nothing matches or off Windows", () => {
    expect(resolveCommand("codex", ["x"], env(), "win32")).toEqual({
      command: "codex",
      args: ["x"],
    });
    writeFileSync(path.join(dir, "codex.cmd"), NPM_SHIM);
    expect(resolveCommand("codex", ["x"], env(), "linux")).toEqual({
      command: "codex",
      args: ["x"],
    });
  });

  it("keeps an explicit path, and a .cmd that is not an npm shim", () => {
    const script = path.join(dir, "fake.sh");
    writeFileSync(script, "");
    expect(resolveCommand(script, [], env(), "win32").command).toBe(script);
    writeFileSync(path.join(dir, "tool.cmd"), "@echo hi\n");
    expect(resolveCommand("tool", [], env(), "win32").command).toBe(path.join(dir, "tool.cmd"));
  });

  it.runIf(process.platform === "win32")(
    "lets runProcessWithTimeout start an npm-style shim on Windows",
    async () => {
      const bin = path.join(dir, "node_modules", "@openai", "codex", "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(
        path.join(bin, "codex.js"),
        "console.log(JSON.stringify(process.argv.slice(2)));\n",
      );
      writeFileSync(path.join(dir, "fakecodex.cmd"), NPM_SHIM);
      const original = process.env.PATH;
      const lines: string[] = [];
      process.env.PATH = `${dir}${path.delimiter}${original ?? ""}`;
      try {
        const result = await runProcessWithTimeout({
          command: "fakecodex",
          args: ["exec", 'say "hi" & exit'],
          cwd: dir,
          timeoutMs: 10_000,
          onLine: (line) => lines.push(line),
        });
        expect(result.spawnError).toBeUndefined();
        expect(result.code).toBe(0);
        expect(JSON.parse(lines[0] ?? "null")).toEqual(["exec", 'say "hi" & exit']);
      } finally {
        process.env.PATH = original;
      }
    },
  );
});
