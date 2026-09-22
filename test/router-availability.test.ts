import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildWorkerAvailability } from "../src/router/availability.js";
import { revokeWorker, setWorkerEnabled } from "../src/router/db/workers.js";
import { workerPolicy } from "./helpers/router-fixtures.js";
import { RouterHarness } from "./helpers/router-harness.js";

describe("buildWorkerAvailability", () => {
  let router: RouterHarness;

  beforeEach(() => {
    router = new RouterHarness({
      config: {
        workers: [
          workerPolicy({ workerId: "worker-1" }),
          workerPolicy({ workerId: "worker-2" }),
          workerPolicy({ workerId: "worker-off", enabled: false }),
        ],
      },
    });
  });

  afterEach(async () => {
    await router.close();
  });

  function availableIds(): string[] {
    return buildWorkerAvailability(router.db, router.config, router.clock.now()).map(
      (worker) => worker.workerId,
    );
  }

  it("lists connected workers with their self-reported availability", async () => {
    await router.connectWorker("worker-1");
    expect(buildWorkerAvailability(router.db, router.config, router.clock.now())).toEqual([
      {
        workerId: "worker-1",
        capabilities: ["programming"],
        repositoryIds: ["repo1"],
        lastAssignedAt: null,
      },
    ]);
  });

  it("drops a worker once its heartbeat is older than 15s", async () => {
    await router.connectWorker("worker-1");
    router.clock.advance(15_001);
    expect(availableIds()).toEqual([]);
  });

  it("drops revoked workers, DB-disabled workers, and workers whose config policy is disabled", async () => {
    await router.connectWorker("worker-1");
    await router.connectWorker("worker-2");
    await router.connectWorker("worker-off");
    expect(availableIds()).toEqual(["worker-1", "worker-2"]);

    revokeWorker(router.db, "worker-1", router.clock.now());
    setWorkerEnabled(router.db, "worker-2", false);
    expect(availableIds()).toEqual([]);
  });

  it("feeds each lease's time back as lastAssignedAt for the fairness order", async () => {
    await router.seedQueuedJob();
    const worker = await router.connectWorker("worker-1");
    await router.next(worker, "req-1");

    const [entry] = buildWorkerAvailability(router.db, router.config, router.clock.now());
    expect(entry?.lastAssignedAt).toBe(router.clock.now());
  });

  it("never lets a worker's own report widen what the admin policy allows", async () => {
    await router.seedQueuedJob();
    const worker = await router.connectWorker("worker-1");
    // The worker claims a repository its policy doesn't allow; the job's repo1 is allowed, so
    // narrow the policy instead and confirm the job is not handed out.
    router.config.workers[0] = workerPolicy({
      workerId: "worker-1",
      allowedRepositoryIds: ["repo-other"],
    });
    const response = await router.next(worker, "req-1");
    expect(response.statusCode).toBe(204);
  });
});
