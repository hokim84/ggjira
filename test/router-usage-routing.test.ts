import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProviderUsage } from "../src/contracts/api.js";
import { getActiveAttemptForWorker } from "../src/router/db/attempts.js";
import { saveProviderUsage } from "../src/router/db/provider-usage.js";
import { usagePressure } from "../src/router/usage-routing.js";
import { type RegisteredWorker, RouterHarness } from "./helpers/router-harness.js";

const NOW = "2026-01-01T00:00:00.000Z";
const HOUR = 3600_000;

function usage(
  windows: ProviderUsage["windows"],
  overrides: Partial<ProviderUsage> = {},
): ProviderUsage {
  return {
    providerId: "default",
    providerType: "claude-code",
    observedAt: NOW,
    source: "job",
    windows,
    ...overrides,
  };
}

const inAnHour = new Date(Date.parse(NOW) + HOUR).toISOString();

describe("usagePressure (ADR 0029)", () => {
  it("is ok without a report or below the threshold", () => {
    expect(usagePressure(undefined, NOW, 90)).toBe("ok");
    expect(usagePressure(usage([{ id: "five_hour", usedPercent: 89.9 }]), NOW, 90)).toBe("ok");
  });

  it("is high at the threshold and exhausted at 100% until the window resets", () => {
    const high = usage([{ id: "five_hour", usedPercent: 90, resetsAt: inAnHour }]);
    const full = usage([
      { id: "five_hour", usedPercent: 40, resetsAt: inAnHour },
      { id: "seven_day", usedPercent: 100, resetsAt: inAnHour },
    ]);
    expect(usagePressure(high, NOW, 90)).toBe("high");
    expect(usagePressure(full, NOW, 90)).toBe("exhausted");
    expect(usagePressure(full, inAnHour, 90)).toBe("ok");
  });

  it("trusts a window without a reset time only for its own length", () => {
    const full = usage([{ id: "primary", usedPercent: 100, windowMinutes: 60 }]);
    expect(usagePressure(full, new Date(Date.parse(NOW) + HOUR - 1).toISOString(), 90)).toBe(
      "exhausted",
    );
    expect(usagePressure(full, inAnHour, 90)).toBe("ok");
    const unknownLength = usage([{ id: "primary", usedPercent: 100 }]);
    expect(
      usagePressure(unknownLength, new Date(Date.parse(NOW) + 5 * HOUR).toISOString(), 90),
    ).toBe("ok");
  });
});

describe("usage-aware assignment (ADR 0029)", () => {
  let router: RouterHarness;
  let w1: RegisteredWorker;
  let w2: RegisteredWorker;

  beforeEach(async () => {
    router = new RouterHarness();
    w1 = await router.connectWorker("worker-1");
    w2 = await router.connectWorker("worker-2");
  });

  afterEach(async () => {
    await router.close();
  });

  function report(workerId: string, windows: ProviderUsage["windows"], providerId = "default") {
    saveProviderUsage(router.db, {
      workerId,
      usage: [usage(windows, { providerId, observedAt: router.clock.now() })],
      now: router.clock.now(),
    });
  }

  it("background assignment prefers the worker with headroom", async () => {
    // worker-1 would win on fairness (both never assigned, id order) but is near its limit.
    report("worker-1", [{ id: "five_hour", usedPercent: 95, resetsAt: inAnHour }]);
    const result = await router.seedQueuedJobAndAssign();
    expect(result.jobsAssigned).toEqual([{ jobId: expect.any(String), workerId: "worker-2" }]);
  });

  it("still assigns a near-limit worker when it is the only match", async () => {
    report("worker-1", [{ id: "five_hour", usedPercent: 95, resetsAt: inAnHour }]);
    report("worker-2", [{ id: "five_hour", usedPercent: 97, resetsAt: inAnHour }]);
    const result = await router.seedQueuedJobAndAssign();
    expect(result.jobsAssigned).toHaveLength(1);
  });

  it("skips an exhausted worker until its window resets", async () => {
    report("worker-1", [{ id: "five_hour", usedPercent: 100, resetsAt: inAnHour }]);
    report("worker-2", [{ id: "seven_day", usedPercent: 100, resetsAt: inAnHour }]);
    await router.seedQueuedJob();

    expect((await router.next(w1, "r1")).statusCode).toBe(204);
    expect((await router.next(w2, "r2")).statusCode).toBe(204);

    router.clock.advance(HOUR);
    await router.heartbeat(w1.workerId, w1.token, w1.sessionId);
    expect((await router.next(w1, "r3")).statusCode).toBe(200);
  });

  it("ignores usage of a provider the worker's jobs don't use", async () => {
    report("worker-1", [{ id: "five_hour", usedPercent: 100, resetsAt: inAnHour }], "other");
    await router.seedQueuedJob();
    expect((await router.next(w1, "r1")).statusCode).toBe(200);
  });

  it("jobs/next: a near-limit worker steps aside for an idle worker with headroom", async () => {
    report("worker-1", [{ id: "five_hour", usedPercent: 95, resetsAt: inAnHour }]);
    await router.seedQueuedJob();

    expect((await router.next(w1, "r1")).statusCode).toBe(204);
    expect((await router.next(w2, "r2")).statusCode).toBe(200);
    expect(getActiveAttemptForWorker(router.db, "worker-2")).toBeDefined();
  });

  it("jobs/next: takes the job anyway once the worker with headroom is offline", async () => {
    report("worker-1", [{ id: "five_hour", usedPercent: 95, resetsAt: inAnHour }]);
    await router.seedQueuedJob();

    router.clock.advance(20_000); // worker-2's heartbeat goes stale
    await router.heartbeat(w1.workerId, w1.token, w1.sessionId);
    expect((await router.next(w1, "r1")).statusCode).toBe(200);
  });

  it("shows the pressure in the admin workers view", async () => {
    report("worker-1", [{ id: "five_hour", usedPercent: 100, resetsAt: inAnHour }]);
    report("worker-2", [{ id: "five_hour", usedPercent: 91, resetsAt: inAnHour }]);
    const pressures = Object.fromEntries(
      router.admin.listWorkers().map((w) => [w.workerId, w.usagePressure]),
    );
    expect(pressures).toEqual({ "worker-1": "exhausted", "worker-2": "high" });
  });
});
