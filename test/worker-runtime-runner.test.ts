import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "../src/contracts/protocol.js";
import { WorkerProviderConfigSchema } from "../src/contracts/provider.js";
import { getJob, getOpenJobForIssue } from "../src/router/db/jobs.js";
import { type FetchLike, RouterClient } from "../src/worker-runtime/client.js";
import type { WorkerConfig } from "../src/worker-runtime/config.js";
import { WorkerRunner } from "../src/worker-runtime/runner.js";
import { ResultSpool } from "../src/worker-runtime/spool.js";
import { formatWorkerProgress, type WorkerProgress } from "../src/worker-runtime/progress.js";
import { FakeWorkerProvider, fakeSuccessResult } from "../src/worker/fake.js";
import type {
  UsageReading,
  WorkerProvider,
  WorkerRequest,
  WorkerResult,
  WorkerRunHooks,
} from "../src/worker/provider.js";
import {
  REQUEST_STATUS,
  TODO_STATUS,
  WORKFLOW_TRANSITIONS,
  issueDescription,
  workerPolicy,
} from "./helpers/router-fixtures.js";
import { RouterHarness } from "./helpers/router-harness.js";

/** Reports plan usage both ways a real provider does: on demand and during a run. */
class UsageProvider extends FakeWorkerProvider {
  probes = 0;

  constructor(private readonly jobUsage: UsageReading) {
    super(fakeSuccessResult());
  }

  async readUsage(): Promise<UsageReading> {
    this.probes += 1;
    return { planType: "pro", windows: [{ id: "five_hour", usedPercent: 11 }] };
  }

  override async run(request: WorkerRequest, hooks: WorkerRunHooks = {}): Promise<WorkerResult> {
    hooks.onUsage?.(this.jobUsage);
    return super.run(request, hooks);
  }
}

/** Blocks until aborted, like a long-running CLI that only stops when killed. */
class BlockingProvider implements WorkerProvider {
  started!: Promise<void>;
  aborted = false;
  private markStarted!: () => void;

  constructor() {
    this.started = new Promise((resolve) => {
      this.markStarted = resolve;
    });
  }

  async run(_request: WorkerRequest, hooks: WorkerRunHooks = {}): Promise<WorkerResult> {
    this.markStarted();
    await new Promise<void>((resolve) => {
      if (hooks.signal?.aborted) resolve();
      hooks.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    this.aborted = true;
    return {
      exitReason: "crashed",
      isError: true,
      summary: "killed",
      durationMs: 1,
      exitCode: null,
    };
  }
}

/**
 * End-to-end: a real Router (Fastify on a loopback port, temp SQLite, FakeJiraGateway) and a real
 * WorkerRunner speaking HTTP to it, with a Fake provider in place of the AI CLI.
 */
describe("WorkerRunner against a live Router", () => {
  let router: RouterHarness;
  let routerUrl: string;
  let workDir: string;

  beforeEach(async () => {
    router = new RouterHarness();
    routerUrl = await router.app.listen({ port: 0, host: "127.0.0.1" });
    workDir = mkdtempSync(path.join(tmpdir(), "ggjira-runner-test-"));
  });

  afterEach(async () => {
    await router.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  /** The newest stored result: the run under test, not the plan an approved issue was seeded with. */
  function latestResult(): { payload: string } {
    return router.db.prepare("SELECT payload FROM results ORDER BY rowid DESC LIMIT 1").get() as {
      payload: string;
    };
  }

  function workerConfig(): WorkerConfig {
    return {
      configVersion: 5,
      routerUrl,
      credentialPath: path.join(workDir, "credential.json"),
      // A plain (non-git) directory: the executor edits it directly instead of making a worktree.
      repositories: [
        {
          id: "repo1",
          path: workDir,
          baseBranch: "main",
          validateCommand: null,
          createPullRequest: false,
        },
      ],
      providers: [WorkerProviderConfigSchema.parse({ id: "default" })],
      dataDir: path.join(workDir, "worker-data"),
      logPath: path.join(workDir, "logs"),
    };
  }

  async function makeRunner(
    provider: WorkerProvider,
    opts: {
      fetch?: FetchLike;
      token?: string;
      sleep?: (ms: number) => Promise<void>;
      onProgress?: (event: WorkerProgress) => void;
      nowMs?: () => number;
      leaseLossMs?: number;
    } = {},
  ): Promise<{ runner: WorkerRunner; spool: ResultSpool; token: string }> {
    let token = opts.token;
    if (!token) {
      const code = await router.pairingCode("worker-1");
      const registered = await new RouterClient({ routerUrl }).register({
        protocolVersion: PROTOCOL_VERSION,
        pairingCode: code,
        workerName: "test-worker",
      });
      token = registered.workerToken;
    }
    const spool = new ResultSpool(path.join(workDir, "spool"));
    const runner = new WorkerRunner({
      config: workerConfig(),
      client: new RouterClient({
        routerUrl,
        workerToken: token,
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
      }),
      workerId: "worker-1",
      spool,
      createProvider: () => provider,
      worktreesRoot: path.join(workDir, "worktrees"),
      heartbeatIntervalMs: 20,
      leaseLossMs: opts.leaseLossMs ?? 300,
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
      ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
      ...(opts.nowMs ? { nowMs: opts.nowMs } : {}),
    });
    return { runner, spool, token };
  }

  it("executes a job end to end and leaves nothing in the spool", async () => {
    await router.seedQueuedJob();
    const jobId = getOpenJobForIssue(router.db, "KAN-1")?.id ?? "";
    const { runner, spool } = await makeRunner(new FakeWorkerProvider(fakeSuccessResult()));

    await runner.connect();
    expect(await runner.pollOnce()).toBe("executed");

    expect(getJob(router.db, jobId)?.state).toBe("succeeded");
    expect(spool.listPending()).toEqual([]);
  });
  it("shows a job lifecycle and suppresses repeated idle messages", async () => {
    const events: WorkerProgress[] = [];
    const { runner } = await makeRunner(new FakeWorkerProvider(fakeSuccessResult()), {
      onProgress: (event) => events.push(event),
    });
    await runner.connect();
    await runner.pollOnce();
    await runner.pollOnce();
    expect(events.filter((event) => event.state === "waiting")).toHaveLength(1);
    await router.seedQueuedJob();
    await runner.pollOnce();
    expect(
      events.filter((event) => event.issueKey === "KAN-1").map((event) => event.state),
    ).toEqual(["started", "progress", "reporting", "finished"]);
    expect(events.at(-1)).toMatchObject({
      state: "finished",
      resultStatus: "succeeded",
      delivered: true,
    });
    expect(formatWorkerProgress(events.at(-1) as WorkerProgress)).toContain(
      "KAN-1 구현 완료 · Router 전송 완료",
    );
    await runner.pollOnce();
    expect(events.filter((event) => event.state === "waiting")).toHaveLength(2);
  });
  it("reports the real execution stage every 30 seconds without an extra timer", async () => {
    await router.seedQueuedJob();
    const events: WorkerProgress[] = [];
    let clock = 0;
    let inAgent = false;
    let finish: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const provider: WorkerProvider = {
      run: async () => {
        await ready;
        return fakeSuccessResult();
      },
    };
    const { runner } = await makeRunner(provider, {
      nowMs: () => clock,
      leaseLossMs: 1_000_000_000,
      sleep: async (ms) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (ms === 1000 && inAgent) clock += 15_000;
      },
      onProgress: (event) => {
        events.push(event);
        if (event.state === "progress" && event.stage === "agent") {
          inAgent = true;
          if ((event.elapsedMs ?? 0) >= 60_000) finish();
        }
      },
    });
    await runner.connect();
    await runner.pollOnce();
    expect(
      events
        .filter((event) => event.state === "progress")
        .map((event) => [event.stage, event.elapsedMs]),
    ).toEqual([
      ["agent", 0],
      ["agent", 30_000],
      ["agent", 60_000],
    ]);
  });

  it("reports plan usage once on connect and again after each job (ADR 0028)", async () => {
    await router.seedQueuedJob();
    const provider = new UsageProvider({
      status: "allowed_warning",
      windows: [
        { id: "five_hour", usedPercent: 42, resetsAt: "2026-09-29T18:00:00.000Z" },
        { id: "seven_day", usedPercent: 17 },
      ],
    });
    const { runner } = await makeRunner(provider);

    await runner.connect();
    await runner.connect(); // a reconnect does not probe again
    await runner.usageProbeSettled();
    expect(provider.probes).toBe(1);
    let [usage] = router.admin.listWorkers().find((w) => w.workerId === "worker-1")
      ?.providerUsage ?? [undefined];
    expect(usage).toMatchObject({
      providerId: "default",
      providerType: "claude-code",
      source: "probe",
      planType: "pro",
      windows: [{ id: "five_hour", usedPercent: 11 }],
    });

    expect(await runner.pollOnce()).toBe("executed");
    [usage] = router.admin.listWorkers().find((w) => w.workerId === "worker-1")?.providerUsage ?? [
      undefined,
    ];
    expect(usage).toMatchObject({
      providerId: "default",
      source: "job",
      status: "allowed_warning",
      windows: [
        { id: "five_hour", usedPercent: 42, resetsAt: "2026-09-29T18:00:00.000Z" },
        { id: "seven_day", usedPercent: 17 },
      ],
    });
  });

  it("reports its local repository paths on connect; a session without them keeps the last", async () => {
    const { runner, token } = await makeRunner(new FakeWorkerProvider(fakeSuccessResult()));
    await runner.connect();
    const view = () => router.admin.listWorkers().find((w) => w.workerId === "worker-1");
    expect(view()?.repositoryPaths).toEqual({ repo1: path.resolve(workDir) });

    // An older worker opens a session without `repositories`.
    await new RouterClient({ routerUrl, workerToken: token }).openSession({
      protocolVersion: PROTOCOL_VERSION,
      workerId: "worker-1",
    });
    expect(view()?.repositoryPaths).toEqual({ repo1: path.resolve(workDir) });
  });

  it("refuses a usage report from a superseded session", async () => {
    const { runner, token } = await makeRunner(new FakeWorkerProvider(fakeSuccessResult()));
    await runner.connect();
    const client = new RouterClient({ routerUrl, workerToken: token });
    await expect(
      client.reportUsage({
        sessionId: "not-the-session",
        workerId: "worker-1",
        usage: [
          {
            providerId: "default",
            providerType: "claude-code",
            observedAt: new Date().toISOString(),
            source: "probe",
            windows: [],
          },
        ],
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("answers idle when there is no work", async () => {
    const { runner } = await makeRunner(new FakeWorkerProvider(fakeSuccessResult()));
    await runner.connect();
    expect(await runner.pollOnce()).toBe("idle");
  });

  it("stops the provider when Router asks to cancel, and reports the cancellation", async () => {
    await router.seedQueuedJob();
    const provider = new BlockingProvider();
    const { runner } = await makeRunner(provider);
    await runner.connect();

    const polling = runner.pollOnce();
    await provider.started;
    const jobId = getOpenJobForIssue(router.db, "KAN-1")?.id ?? "";
    await router.jira.transitionIssueToStatus("KAN-1", TODO_STATUS);
    await router.reconcile();
    await polling;

    expect(provider.aborted).toBe(true);
    expect(getJob(router.db, jobId)?.state).toBe("cancelled");
  });

  it("keeps trying to connect while Router is unreachable, then connects", async () => {
    let refusals = 2;
    const controller = new AbortController();
    const startingFetch: FetchLike = async (input, init) => {
      if (!input.endsWith("/workers/session")) return fetch(input, init);
      if (refusals > 0) {
        refusals -= 1;
        throw new TypeError("fetch failed");
      }
      // Connected: end the run before it starts polling.
      controller.abort();
      return fetch(input, init);
    };
    const waits: number[] = [];
    const { runner } = await makeRunner(new FakeWorkerProvider(fakeSuccessResult()), {
      fetch: startingFetch,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    await runner.run(controller.signal);

    expect(refusals).toBe(0);
    expect(waits).toEqual([5_000, 5_000]);
    expect(router.db.prepare("SELECT COUNT(*) AS n FROM worker_sessions").get()).toEqual({ n: 1 });
  });

  it("stops when Router refuses the worker's credential instead of retrying", async () => {
    const { runner } = await makeRunner(new FakeWorkerProvider(fakeSuccessResult()), {
      token: "not-a-real-token",
      sleep: async () => {
        throw new Error("must not retry a 4xx");
      },
    });
    await expect(runner.run(new AbortController().signal)).rejects.toMatchObject({ status: 401 });
  });

  it("aborts on its own after losing contact with Router for the lease-loss window", async () => {
    await router.seedQueuedJob();
    const provider = new BlockingProvider();
    let heartbeatsBlocked = false;
    const flakyFetch: FetchLike = async (input, init) => {
      if (heartbeatsBlocked && input.endsWith("/heartbeat")) throw new Error("network down");
      return fetch(input, init);
    };
    const { runner } = await makeRunner(provider, { fetch: flakyFetch });
    await runner.connect();

    const polling = runner.pollOnce();
    await provider.started;
    heartbeatsBlocked = true;
    await polling;

    expect(provider.aborted).toBe(true);
    const result = latestResult();
    expect(JSON.parse(result.payload)).toMatchObject({
      status: "cancelled",
      summary: expect.stringContaining("lost contact"),
    });
  });

  it("runs a planning envelope read-only and returns the plan as structured data", async () => {
    router.jira.seedIssue(
      {
        key: "KAN-7",
        summary: "Plan it",
        statusName: REQUEST_STATUS,
        projectKey: "KAN",
        assigneeAccountId: "user-1",
        description: issueDescription(),
      },
      WORKFLOW_TRANSITIONS,
    );
    await router.reconcile();
    const plan = {
      acceptanceCriteria: ["The API works"],
      verification: ["Run API integration tests"],
      needsDecision: false,
      summary: "Two steps",
      tasks: [
        {
          taskId: "api",
          title: "Build the API",
          description: "Endpoints",
          acceptance: ["GET /items answers 200"],
          verification: ["npm run test -- api"],
        },
      ],
    };
    const requests: WorkerRequest[] = [];
    const provider: WorkerProvider = {
      async run(request) {
        requests.push(request);
        return fakeSuccessResult({ summary: "planned", structuredOutput: plan });
      },
    };
    const { runner } = await makeRunner(provider);
    await runner.connect();

    await runner.pollOnce();

    const job = router.db.prepare("SELECT state FROM jobs WHERE issue_key = 'KAN-7'").get() as {
      state: string;
    };
    expect(job.state).toBe("succeeded");
    expect(requests[0]?.readOnly).toBe(true);
    expect(requests[0]?.prompt).toContain("KAN-7");
    const result = latestResult();
    expect(JSON.parse(result.payload)).toMatchObject({
      status: "planned",
      plan: { summary: "Two steps", tasks: [{ taskId: "api" }] },
    });
    // Nothing reached Jira from the worker; Router journaled the plan instead.
    expect(router.jira.createdIssues).toEqual([]);
    const kinds = router.db
      .prepare("SELECT kind FROM report_steps WHERE result_id IS NOT NULL ORDER BY rowid")
      .all() as Array<{ kind: string }>;
    expect(kinds.map((row) => row.kind)).toContain("create-subtask");
  });

  it("refuses a providerId the worker does not have", async () => {
    await router.close();
    router = new RouterHarness({
      config: { workers: [workerPolicy({ workerId: "worker-1", providerId: "gpt-9" })] },
    });
    routerUrl = await router.app.listen({ port: 0, host: "127.0.0.1" });
    await router.seedQueuedJob();
    const { runner } = await makeRunner(new BlockingProvider());
    await runner.connect();

    await runner.pollOnce();

    const result = latestResult();
    expect(JSON.parse(result.payload)).toMatchObject({
      status: "failed",
      failureReason: 'unknown providerId "gpt-9"',
    });
  });

  it("resends a result that was spooled but never acknowledged, after a worker restart", async () => {
    const events: WorkerProgress[] = [];
    await router.seedQueuedJob();
    const jobId = getOpenJobForIssue(router.db, "KAN-1")?.id ?? "";
    const dropResults: FetchLike = async (input, init) => {
      if (input.endsWith("/result")) throw new Error("connection reset");
      return fetch(input, init);
    };
    const first = await makeRunner(new FakeWorkerProvider(fakeSuccessResult()), {
      fetch: dropResults,
      onProgress: (event) => events.push(event),
    });
    await first.runner.connect();
    await first.runner.pollOnce();
    expect(first.spool.listPending()).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      state: "finished",
      delivered: false,
      resultStatus: "succeeded",
    });
    expect(formatWorkerProgress(events.at(-1) as WorkerProgress)).toContain(
      "결과 보관됨, Router 전송 미완료",
    );
    expect(getJob(router.db, jobId)?.state).toBe("running");

    // Same credential, new process, working network.
    const second = await makeRunner(new FakeWorkerProvider(fakeSuccessResult()), {
      token: first.token,
      onProgress: (event) => events.push(event),
    });
    await second.runner.connect();

    expect(second.spool.listPending()).toEqual([]);
    expect(events.some((event) => event.state === "resent" && event.count === 1)).toBe(true);
    expect(getJob(router.db, jobId)?.state).toBe("succeeded");
  });

  it("reports an attempt orphaned by a worker crash instead of re-running it", async () => {
    await router.seedQueuedJob();
    const jobId = getOpenJobForIssue(router.db, "KAN-1")?.id ?? "";
    const crashedProvider = new BlockingProvider();
    const crashed = await makeRunner(crashedProvider);
    await crashed.runner.connect();
    // The "crashed" process: mid-run when a new process of the same worker starts up.
    const crashedPoll = crashed.runner.pollOnce();
    await crashedProvider.started;
    expect(getJob(router.db, jobId)?.state).toBe("running");

    const restartedProvider = new BlockingProvider();
    const restarted = await makeRunner(restartedProvider, { token: crashed.token });
    await restarted.runner.connect();

    expect(getJob(router.db, jobId)?.state).toBe("failed");
    const results = (
      router.db
        .prepare("SELECT payload, applied FROM results WHERE job_id = ? ORDER BY rowid")
        .all(jobId) as Array<{
        payload: string;
        applied: number;
      }>
    ).map((row) => ({ ...JSON.parse(row.payload), applied: row.applied }));
    expect(results[0]).toMatchObject({ failureReason: "worker restarted mid-run", applied: 1 });

    // The old process loses its session: its next job heartbeat is refused, it stops the
    // provider, and its late result is kept only as an audit record.
    await crashedPoll;
    expect(crashedProvider.aborted).toBe(true);
    expect(getJob(router.db, jobId)?.state).toBe("failed");
    expect(restartedProvider.aborted).toBe(false);
  });
});
