import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJob, transitionJob } from "../src/job/job.js";
import { JobStore } from "../src/job/store.js";

describe("JobStore", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "ggjira-store-test-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("saves and loads a job at data/runs/<ISSUE-KEY>/<runId>/job.json", () => {
    const store = new JobStore(dataDir);
    const job = createJob("KAN-1", "run-1");

    store.saveJob(job);

    expect(existsSync(path.join(dataDir, "runs", "KAN-1", "run-1", "job.json"))).toBe(true);
    expect(store.loadJob("KAN-1", "run-1")).toEqual(job);
  });

  it("returns undefined for a job that was never saved", () => {
    const store = new JobStore(dataDir);
    expect(store.loadJob("KAN-1", "does-not-exist")).toBeUndefined();
  });

  it("persists the latest job state across saves", () => {
    const store = new JobStore(dataDir);
    let job = createJob("KAN-1", "run-1");
    store.saveJob(job);

    job = transitionJob(job, "claimed");
    store.saveJob(job);

    expect(store.loadJob("KAN-1", "run-1")?.status).toBe("claimed");
  });

  it("writes summary.md next to job.json", () => {
    const store = new JobStore(dataDir);
    store.writeSummary("KAN-1", "run-1", "# Summary\n\nDone.");

    const content = readFileSync(
      path.join(dataDir, "runs", "KAN-1", "run-1", "summary.md"),
      "utf-8",
    );
    expect(content).toContain("Done.");
  });

  it("lists issue keys and run ids under runs/", () => {
    const store = new JobStore(dataDir);
    store.saveJob(createJob("KAN-1", "run-1"));
    store.saveJob(createJob("KAN-1", "run-2"));
    store.saveJob(createJob("KAN-2", "run-1"));

    expect(store.listIssueKeys().sort()).toEqual(["KAN-1", "KAN-2"]);
    expect(store.listRunIds("KAN-1")).toEqual(["run-1", "run-2"]);
    expect(store.listRunIds("KAN-999")).toEqual([]);
  });

  it("claims an issue and persists the claim to state.json", () => {
    const store = new JobStore(dataDir);

    expect(store.claimIssue("KAN-1", "run-1")).toBe(true);
    expect(store.getClaim("KAN-1")).toBe("run-1");
    expect(existsSync(path.join(dataDir, "state.json"))).toBe(true);
  });

  it("refuses to claim an issue already claimed by a different run", () => {
    const store = new JobStore(dataDir);
    store.claimIssue("KAN-1", "run-1");

    expect(store.claimIssue("KAN-1", "run-2")).toBe(false);
    expect(store.getClaim("KAN-1")).toBe("run-1");
  });

  it("allows re-claiming with the same runId (idempotent)", () => {
    const store = new JobStore(dataDir);
    store.claimIssue("KAN-1", "run-1");

    expect(store.claimIssue("KAN-1", "run-1")).toBe(true);
  });

  it("refuses to double-claim after a simulated process restart", () => {
    const storeBeforeRestart = new JobStore(dataDir);
    expect(storeBeforeRestart.claimIssue("KAN-1", "run-1")).toBe(true);

    // Simulate a restart: a fresh JobStore instance reloading only from disk.
    const storeAfterRestart = new JobStore(dataDir);
    expect(storeAfterRestart.claimIssue("KAN-1", "run-2")).toBe(false);
    expect(storeAfterRestart.getClaim("KAN-1")).toBe("run-1");
  });

  it("releases a claim so the issue can be claimed again", () => {
    const store = new JobStore(dataDir);
    store.claimIssue("KAN-1", "run-1");

    store.releaseClaim("KAN-1");

    expect(store.getClaim("KAN-1")).toBeUndefined();
    expect(store.claimIssue("KAN-1", "run-2")).toBe(true);
  });

  it("lists all current claims", () => {
    const store = new JobStore(dataDir);
    store.claimIssue("KAN-1", "run-1");
    store.claimIssue("KAN-2", "run-5");

    expect(store.listClaims()).toEqual({ "KAN-1": "run-1", "KAN-2": "run-5" });
  });
});
