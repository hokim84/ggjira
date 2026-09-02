import { describe, expect, it } from "vitest";
import { InvalidJobTransitionError, createJob, transitionJob } from "../src/job/job.js";

describe("job state machine", () => {
  it("creates a job in the queued status", () => {
    const job = createJob("KAN-1", "run-1", new Date("2026-01-01T00:00:00.000Z"));

    expect(job).toEqual({
      runId: "run-1",
      issueKey: "KAN-1",
      status: "queued",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("allows the happy-path sequence queued -> claimed -> running -> succeeded", () => {
    let job = createJob("KAN-1", "run-1", new Date("2026-01-01T00:00:00.000Z"));
    job = transitionJob(job, "claimed", {}, new Date("2026-01-01T00:00:01.000Z"));
    expect(job.status).toBe("claimed");

    job = transitionJob(job, "running", {}, new Date("2026-01-01T00:00:02.000Z"));
    expect(job.status).toBe("running");

    job = transitionJob(
      job,
      "succeeded",
      { summary: "did the thing", branch: "ggjira/KAN-1-run-1" },
      new Date("2026-01-01T00:00:03.000Z"),
    );
    expect(job.status).toBe("succeeded");
    expect(job.summary).toBe("did the thing");
    expect(job.branch).toBe("ggjira/KAN-1-run-1");
    expect(job.updatedAt).toBe("2026-01-01T00:00:03.000Z");
  });

  it.each([
    ["running", "failed"],
    ["running", "timed_out"],
    ["running", "cancelled"],
    ["claimed", "failed"],
    ["queued", "failed"],
  ] as const)("allows %s -> %s", (from, to) => {
    const job = { ...createJob("KAN-1", "run-1"), status: from };
    expect(() => transitionJob(job, to)).not.toThrow();
  });

  it("rejects skipping states (queued -> running)", () => {
    const job = createJob("KAN-1", "run-1");
    expect(() => transitionJob(job, "running")).toThrow(InvalidJobTransitionError);
  });

  it("rejects transitions out of terminal states", () => {
    let job = createJob("KAN-1", "run-1");
    job = transitionJob(job, "claimed");
    job = transitionJob(job, "running");
    job = transitionJob(job, "succeeded");

    expect(() => transitionJob(job, "running")).toThrow(InvalidJobTransitionError);
    expect(() => transitionJob(job, "failed")).toThrow(InvalidJobTransitionError);
  });

  it("rejects the reverse direction (running -> claimed)", () => {
    let job = createJob("KAN-1", "run-1");
    job = transitionJob(job, "claimed");
    job = transitionJob(job, "running");

    expect(() => transitionJob(job, "claimed")).toThrow(InvalidJobTransitionError);
  });
});
