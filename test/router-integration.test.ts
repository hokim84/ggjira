import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkerProviderConfigSchema } from "../src/contracts/provider.js";
import { FakeJiraGateway } from "../src/jira/fake.js";
import { AdminClient } from "../src/router/admin-client.js";
import { openRouterDb } from "../src/router/db/connection.js";
import { getOpenJobForIssue, listJobs } from "../src/router/db/jobs.js";
import { RouterDaemon } from "../src/router/daemon.js";
import type { WorkerRequest, WorkerResult } from "../src/worker/provider.js";
import { fakeSuccessResult } from "../src/worker/fake.js";
import { RouterClient } from "../src/worker-runtime/client.js";
import { WorkerConfigSchema } from "../src/worker-runtime/config.js";
import { pairWorker } from "../src/worker-runtime/ops.js";
import { WorkerRunner } from "../src/worker-runtime/runner.js";
import { ResultSpool } from "../src/worker-runtime/spool.js";
import {
  buildRouterConfig,
  IN_PROGRESS_STATUS,
  issueDescription,
  PLAN_REVIEW_STATUS,
  REQUEST_STATUS,
  REVIEW_STATUS,
  singlePlan,
  WORKFLOW_TRANSITIONS,
  workerPolicy,
} from "./helpers/router-fixtures.js";

const ADMIN_TOKEN = "admin-token-at-least-16-chars";

/** Records which worker ran which issue, like a provider CLI that always succeeds: a planning
 *  run (read-only) answers with a plan, an implementation with its report. */
class RecordingProvider {
  constructor(
    private readonly workerId: string,
    private readonly log: Array<{ workerId: string; prompt: string; planning: boolean }>,
  ) {}

  async run(request: WorkerRequest): Promise<WorkerResult> {
    const planning = request.readOnly === true;
    this.log.push({ workerId: this.workerId, prompt: request.prompt, planning });
    await new Promise((resolve) => setTimeout(resolve, 50));
    return planning
      ? fakeSuccessResult({
          summary: `planned by ${this.workerId}`,
          structuredOutput: singlePlan(),
        })
      : fakeSuccessResult({ summary: `done by ${this.workerId}` });
  }
}

/**
 * docs/router-service-implementation-plan.md §5: one Router and two fake workers, all over real
 * HTTP on loopback — pairing through the admin API, central dispatch, execution, and Jira reporting
 * to the review status. Jira is the in-memory fake; the provider is a fake CLI.
 */
describe("Router with two workers over HTTP", () => {
  let dir: string;
  let db: Database.Database;
  let daemon: RouterDaemon;
  let routerUrl: string;
  const jira = new FakeJiraGateway();
  const controllers: AbortController[] = [];
  const runs: Promise<void>[] = [];

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ggjira-integration-"));
    db = openRouterDb(path.join(dir, "router.sqlite3"));
    jira.setSelf({ accountId: "router-bot", displayName: "Router", emailAddress: null });
    for (const key of ["KAN-1", "KAN-2", "KAN-3"]) {
      jira.seedIssue(
        {
          key,
          summary: `Implement ${key}`,
          statusName: REQUEST_STATUS,
          projectKey: "KAN",
          assigneeAccountId: "user-1",
          description: issueDescription(),
        },
        WORKFLOW_TRANSITIONS,
      );
    }
    daemon = new RouterDaemon({
      db,
      jira,
      config: buildRouterConfig({
        workers: [workerPolicy({ workerId: "worker-a" }), workerPolicy({ workerId: "worker-b" })],
        reconciliation: {
          startupFullSyncOnBoot: true,
          backgroundIntervalMs: 60_000,
          activeJobPollIntervalMs: 100,
        },
      }),
      webhookSecret: "webhook-secret-at-least-16-chars",
      adminToken: ADMIN_TOKEN,
      siteId: "site-1",
      intervals: { eventPollMs: 50, reportMs: 50, leaseSweepMs: 200 },
      longPollMs: 200,
    });
    routerUrl = await daemon.listen("127.0.0.1", 0);
    daemon.start();
  });

  afterEach(async () => {
    for (const controller of controllers.splice(0)) controller.abort();
    await Promise.allSettled(runs.splice(0));
    await daemon.stop();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function startWorker(
    workerId: string,
    log: Array<{ workerId: string; prompt: string; planning: boolean }>,
  ): Promise<void> {
    const admin = new AdminClient({ routerUrl, adminToken: ADMIN_TOKEN, actor: "test" });
    const { pairingCode } = await admin.post<{ pairingCode: string }>("/pairing-codes", {
      workerId,
    });
    const workerDir = path.join(dir, workerId);
    const repoDir = path.join(workerDir, "repo");
    mkdirSync(repoDir, { recursive: true });
    const credentialPath = path.join(workerDir, "credential.json");
    const credential = await pairWorker({
      client: new RouterClient({ routerUrl }),
      pairingCode,
      workerName: workerId,
      credentialPath,
    });
    const config = WorkerConfigSchema.parse({
      configVersion: 5,
      routerUrl,
      credentialPath,
      // Plain directories: the executor edits in place, no git needed for the scenario.
      repositories: [{ id: "repo1", path: repoDir }],
      capabilities: ["programming"],
      providers: [WorkerProviderConfigSchema.parse({ id: "default" })],
      dataDir: path.join(workerDir, "data"),
    });
    const runner = new WorkerRunner({
      config,
      client: new RouterClient({ routerUrl, workerToken: credential.workerToken }),
      workerId: credential.workerId,
      spool: new ResultSpool(path.join(workerDir, "data", "spool")),
      createProvider: () => new RecordingProvider(workerId, log),
      worktreesRoot: path.join(workerDir, "data", "worktrees"),
      heartbeatIntervalMs: 50,
    });
    const controller = new AbortController();
    controllers.push(controller);
    runs.push(runner.run(controller.signal));
  }

  it("plans every request, runs each approved plan once and reports it to the review status", async () => {
    const log: Array<{ workerId: string; prompt: string; planning: boolean }> = [];
    await startWorker("worker-a", log);
    await startWorker("worker-b", log);

    await vi.waitFor(
      async () => {
        for (const key of ["KAN-1", "KAN-2", "KAN-3"]) {
          expect((await jira.getIssue(key)).statusName).toBe(PLAN_REVIEW_STATUS);
          expect(
            (
              db
                .prepare(
                  "SELECT ready_history FROM planning_requests WHERE issue_key = ? ORDER BY rowid DESC LIMIT 1",
                )
                .get(key) as { ready_history: string | null } | undefined
            )?.ready_history,
          ).toBeTruthy();
        }
      },
      { timeout: 20_000, interval: 100 },
    );
    expect(log.every((entry) => entry.planning)).toBe(true);
    // A human approves each plan on the board; Router finds the moves on its next pass.
    for (const key of ["KAN-1", "KAN-2", "KAN-3"]) {
      await jira.transitionIssueToStatus(key, IN_PROGRESS_STATUS);
    }
    await daemon.reconcileNow();

    await vi.waitFor(
      async () => {
        for (const key of ["KAN-1", "KAN-2", "KAN-3"]) {
          expect((await jira.getIssue(key)).statusName).toBe(REVIEW_STATUS);
        }
      },
      { timeout: 20_000, interval: 100 },
    );

    const jobs = listJobs(db, { limit: 10 }).jobs;
    expect(jobs.map((job) => job.state)).toEqual(Array(6).fill("succeeded"));
    expect(jobs.every((job) => job.attemptCount === 1)).toBe(true);
    // Each issue was planned once and ran once, across both workers.
    expect(log).toHaveLength(6);
    for (const key of ["KAN-1", "KAN-2", "KAN-3"]) {
      const runs = log.filter((entry) => entry.prompt.includes(key));
      expect(runs.map((entry) => entry.planning)).toEqual([true, false]);
      expect(getOpenJobForIssue(db, key)).toBeUndefined();
      const comments = await jira.getComments(key);
      expect(comments.some((comment) => comment.body.includes("done by worker-"))).toBe(true);
    }
    // Two rounds of real HTTP polling (plan, then implementation) take longer than the default.
  }, 30_000);
});
