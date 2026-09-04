import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasLocalConfig } from "../src/setup/first-run.js";

describe("hasLocalConfig", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "ggjira-first-run-test-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("is false when ggjira.config.json does not exist", () => {
    expect(hasLocalConfig(cwd)).toBe(false);
  });

  it("is true once ggjira.config.json exists", () => {
    writeFileSync(path.join(cwd, "ggjira.config.json"), "{}");
    expect(hasLocalConfig(cwd)).toBe(true);
  });
});
