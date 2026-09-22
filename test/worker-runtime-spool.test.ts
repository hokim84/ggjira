import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JobResult } from "../src/contracts/envelope.js";
import { PROTOCOL_VERSION } from "../src/contracts/protocol.js";
import { ResultSpool } from "../src/worker-runtime/spool.js";

function result(resultId: string, attemptId = "attempt-1"): JobResult {
  return {
    protocolVersion: PROTOCOL_VERSION,
    jobId: "job-1",
    attemptId,
    resultId,
    status: "succeeded",
    summary: "done",
  };
}

describe("ResultSpool", () => {
  let dir: string;

  beforeEach(() => {
    dir = path.join(mkdtempSync(path.join(tmpdir(), "ggjira-spool-test-")), "spool");
  });

  afterEach(() => {
    rmSync(path.dirname(dir), { recursive: true, force: true });
  });

  it("keeps a saved result until it is acked, across a new spool instance (worker restart)", () => {
    new ResultSpool(dir).save(result("r1"));

    const afterRestart = new ResultSpool(dir);
    expect(afterRestart.listPending()).toEqual([result("r1")]);
    expect(afterRestart.hasPendingFor("attempt-1")).toBe(true);

    afterRestart.ack("r1");
    expect(afterRestart.listPending()).toEqual([]);
  });

  it("leaves no temp files behind after a save", () => {
    new ResultSpool(dir).save(result("r1"));
    expect(readdirSync(dir)).toEqual(["r1.json"]);
  });

  it("overwrites an earlier save of the same resultId atomically", () => {
    const spool = new ResultSpool(dir);
    spool.save(result("r1"));
    spool.save({ ...result("r1"), summary: "updated" });
    expect(spool.listPending()).toEqual([{ ...result("r1"), summary: "updated" }]);
  });

  it("skips a torn or foreign file instead of blocking the rest", () => {
    const spool = new ResultSpool(dir);
    spool.save(result("r2"));
    writeFileSync(path.join(dir, "r1.json"), "{ not json");
    expect(spool.listPending()).toEqual([result("r2")]);
    // Kept on disk for a human to inspect.
    expect(existsSync(path.join(dir, "r1.json"))).toBe(true);
  });

  it("refuses a resultId that could escape the spool directory", () => {
    const spool = new ResultSpool(dir);
    expect(() => spool.save(result("../evil"))).toThrow();
    expect(() => spool.ack("..")).toThrow();
  });

  it("returns an empty list when the directory does not exist yet", () => {
    expect(new ResultSpool(dir).listPending()).toEqual([]);
  });
});
