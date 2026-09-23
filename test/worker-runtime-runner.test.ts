import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "../src/contracts/protocol.js";
import { WorkerProviderConfigSchema } from "../src/contracts/provider.js";
import { getJob, getOpenJobForIssue } from "../src/router/db/jobs.js";
import type {
  WorkerProvider,
  WorkerRequest,
  WorkerResult,
  WorkerRunHooks,
} from "../src/worker/provider.js";
import { FakeWorkerProvider, fakeSuccessResult } from "../src/worker/fake.js";
import { type FetchLike, RouterClient } from "../src/worker-runtime/client.js";
import type { WorkerConfig } from "../src/worker-runtime/config.js";
import { WorkerRunner } from "../src/worker-runtime/runner.js";
import { ResultSpool } from "../src/worker-runtime/spool.js";
import { issueDescription, PLANNING_STATUS, workerPolicy } from "./helpers/router-fixtures.js";
import { RouterHarness } from "./helpers/router-harness.js";

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

  function workerConfig(): WorkerConfig {
    return {
      configVersion: 5,
      routerUrl,
      credentialPath: path.join(workDir, "credential.json"),
      // A plain (non-git) directory: the executor edits it directly instead of making a worktree.
      repositories: [{ id: "repo1", path: workDir, baseBranch: "main", validateCommand: null }],
      capabilities: ["programming"],
      backends: [],
      providers: [WorkerProviderConfigSchema.parse({ id: "default" })],
      dataDir: path.join(workDir, "worker-data"),
      logPath: path.join(workDir, "logs"),
    };
  }

  async function makeRunner(
    provider: WorkerProvider,
    opts: { fetch?: FetchLike; token?: string } = {},
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
      leaseLossMs: 300,
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
    await router.jira.transitionIssue("KAN-1", "Revoke");
    await router.reconcile();
    await polling;

    expect(provider.aborted).toBe(true);
    expect(getJob(router.db, jobId)?.state).toBe("cancelled");
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
    const result = router.db.prepare("SELECT payload FROM results").get() as { payload: string };
    expect(JSON.parse(result.payload)).toMatchObject({
      status: "cancelled",
      summary: expect.stringContaining("lost contact"),
    });
  });

  it("runs a planning envelope read-only and returns the plan as structured data", async () => {
    router.jira.seedIssue({
      key: "KAN-7",
      summary: "Plan it",
      statusName: PLANNING_STATUS,
      projectKey: "KAN",
      assigneeAccountId: "user-1",
      description: issueDescription(),
    });
    await router.reconcile();
    const plan = {
      needsDecision: false,
      summary: "Two steps",
      tasks: [
        {
          taskId: "api",
          title: "Build the API",
          description: "Endpoints",
          acceptance: [],
          requiredCapabilities: ["programming"],
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
    const result = router.db.prepare("SELECT payload FROM results").get() as { payload: string };
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

    const result = router.db.prepare("SELECT payload FROM results").get() as { payload: string };
    expect(JSON.parse(result.payload)).toMatchObject({
      status: "failed",
      failureReason: 'unknown providerId "gpt-9"',
    });
  });

  it("resends a result that was spooled but never acknowledged, after a worker restart", async () => {
    await router.seedQueuedJob();
    const jobId = getOpenJobForIssue(router.db, "KAN-1")?.id ?? "";
    const dropResults: FetchLike = async (input, init) => {
      if (input.endsWith("/result")) throw new Error("connection reset");
      return fetch(input, init);
    };
    const first = await makeRunner(new FakeWorkerProvider(fakeSuccessResult()), {
      fetch: dropResults,
    });
    await first.runner.connect();
    await first.runner.pollOnce();
    expect(first.spool.listPending()).toHaveLength(1);
    expect(getJob(router.db, jobId)?.state).toBe("running");

    // Same credential, new process, working network.
    const second = await makeRunner(new FakeWorkerProvider(fakeSuccessResult()), {
      token: first.token,
    });
    await second.runner.connect();

    expect(second.spool.listPending()).toEqual([]);
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
