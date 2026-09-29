import { randomUUID } from "node:crypto";
import type { ProviderUsage } from "../contracts/api.js";
import type { JobEnvelope, JobResult } from "../contracts/envelope.js";
import { PROTOCOL_VERSION } from "../contracts/protocol.js";
import type { WorkerProviderConfig } from "../contracts/provider.js";
import type { Logger } from "../logger.js";
import type { UsageReading, WorkerProvider } from "../worker/provider.js";
import { RouterApiError, type RouterClient } from "./client.js";
import type { WorkerConfig } from "./config.js";
import { type ExecutionOutcome, executeEnvelope } from "./executor.js";
import type { ResultSpool } from "./spool.js";

/** §3 "heartbeat: 5초". */
export const HEARTBEAT_INTERVAL_MS = 5_000;
/** §3 "워커는 마지막 성공한 heartbeat 요청 시작 시점부터 20초 동안 갱신하지 못하면 실행을 중단한다". */
export const LEASE_LOSS_MS = 20_000;
const WATCHDOG_TICK_MS = 1_000;
const ERROR_BACKOFF_MS = 5_000;

export interface WorkerRunnerDeps {
  config: WorkerConfig;
  client: RouterClient;
  workerId: string;
  spool: ResultSpool;
  createProvider: (provider: WorkerProviderConfig) => WorkerProvider;
  worktreesRoot: string;
  logger?: Logger;
  /** Epoch ms. Injected so tests can drive the heartbeat/lease-loss timers. */
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
  genId?: () => string;
  heartbeatIntervalMs?: number;
  leaseLossMs?: number;
}

export type PollOutcome = "idle" | "executed";

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The worker's main loop (docs/router-service-implementation-plan.md §4 "3. Worker 통신·실행"):
 *
 *   session → resend spooled results → report attempts orphaned by a restart
 *   → loop { heartbeat → jobs/next → start → execute (job heartbeat + lease watchdog)
 *            → spool → submit → ack }
 *
 * The worker only ever talks to Router. Every result is spooled before it is submitted, so a
 * crash between "done" and "Router acknowledged" resends it on the next start.
 */
export class WorkerRunner {
  private sessionId: string | undefined;
  private readonly nowMs: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly genId: () => string;
  private readonly heartbeatIntervalMs: number;
  private readonly leaseLossMs: number;
  private usageProbe: Promise<void> | undefined;

  constructor(private readonly deps: WorkerRunnerDeps) {
    this.nowMs = deps.nowMs ?? Date.now;
    this.sleep = deps.sleep ?? defaultSleep;
    this.genId = deps.genId ?? randomUUID;
    this.heartbeatIntervalMs = deps.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.leaseLossMs = deps.leaseLossMs ?? LEASE_LOSS_MS;
  }

  /** Opens a session and settles anything left over from a previous run of this worker. */
  async connect(): Promise<void> {
    const session = await this.deps.client.openSession({
      protocolVersion: PROTOCOL_VERSION,
      workerId: this.deps.workerId,
    });
    this.sessionId = session.sessionId;
    await this.flushSpool();

    for (const pending of session.pendingAttempts) {
      // A `leased` attempt never started; `jobs/next` hands it back. A running one belonged to a
      // process that is gone, and its outcome is unknown: report the stop so Router has the
      // worker's abort confirmation, never re-run it (§1 "실행 중 연결이 끊겨 결과가 불명확한 작업은
      // 자동 재실행하지 않는다").
      if (pending.state === "leased" || this.deps.spool.hasPendingFor(pending.attemptId)) continue;
      await this.submit({
        protocolVersion: PROTOCOL_VERSION,
        jobId: pending.jobId,
        attemptId: pending.attemptId,
        resultId: this.genId(),
        status: "failed",
        summary: "Worker restarted while this attempt was running; its outcome is unknown.",
        failureReason: "worker restarted mid-run",
      });
    }
    await this.flushSpool();
    // Once per process, in the background: a Claude Code probe takes seconds and must not hold up
    // the first poll (ADR 0028).
    this.usageProbe ??= this.probeUsage();
  }

  /** Settles once the connect-time usage probe has been reported (or has failed). */
  usageProbeSettled(): Promise<void> {
    return this.usageProbe ?? Promise.resolve();
  }

  /** Runs until `signal` aborts. Transient Router errors back off and retry; a 409 on the
   *  session means another process took over, so the session is reopened. */
  async run(signal: AbortSignal): Promise<void> {
    await this.connect();
    while (!signal.aborted) {
      try {
        await this.pollOnce();
      } catch (error) {
        this.deps.logger?.warn({ err: error, layer: "worker-runtime" }, "poll cycle failed");
        if (error instanceof RouterApiError && error.body?.error === "stale_session") {
          await this.connect();
        } else {
          await this.sleep(ERROR_BACKOFF_MS);
        }
      }
    }
  }

  /** One heartbeat + `jobs/next` round, executing whatever comes back. */
  async pollOnce(): Promise<PollOutcome> {
    const sessionId = this.requireSession();
    const { config, client, workerId } = this.deps;
    await client.heartbeat({
      sessionId,
      workerId,
      availability: {
        capabilities: config.capabilities,
        repositoryIds: config.repositories.map((repo) => repo.id),
        busy: false,
      },
    });

    // One requestId per poll; a retry of this same poll after a lost response would reuse it.
    const envelope = await client.next({ sessionId, workerId, requestId: this.genId() });
    if (!envelope) return "idle";
    await this.execute(envelope);
    return "executed";
  }

  private async execute(envelope: JobEnvelope): Promise<void> {
    const sessionId = this.requireSession();
    const { client } = this.deps;
    const lease = { sessionId, attemptId: envelope.attemptId, leaseToken: envelope.leaseToken };

    const start = await client.start(envelope.jobId, lease);
    if (!start.granted) return; // Router released the lease; nothing ran.

    const abort = new AbortController();
    let lastSuccessfulBeatStartedAt = this.nowMs();
    let done = false;
    let stopReason: string | undefined;
    const stop = (reason: string) => {
      stopReason ??= reason;
      abort.abort();
    };

    const heartbeatLoop = (async () => {
      while (!done) {
        await this.sleep(this.heartbeatIntervalMs);
        if (done) break;
        const startedAt = this.nowMs();
        try {
          const beat = await client.jobHeartbeat(envelope.jobId, lease);
          lastSuccessfulBeatStartedAt = startedAt;
          if (beat.cancel) stop("Router requested cancellation");
        } catch (error) {
          if (error instanceof RouterApiError && error.isConflict) {
            stop(`Router refused the lease (${error.body?.error ?? error.status})`);
          }
          // Anything else: keep trying; the watchdog decides when it's been too long.
        }
      }
    })();

    const watchdogTickMs = Math.min(WATCHDOG_TICK_MS, this.leaseLossMs / 4);
    const watchdog = (async () => {
      while (!done) {
        await this.sleep(watchdogTickMs);
        if (!done && this.nowMs() - lastSuccessfulBeatStartedAt >= this.leaseLossMs) {
          stop("lost contact with Router for 20s");
        }
      }
    })();

    const usage = new Map<string, ProviderUsage>();
    let outcome: ExecutionOutcome;
    try {
      outcome = await executeEnvelope(envelope, {
        config: this.deps.config,
        onUsage: (provider, reading) =>
          usage.set(provider.id, this.usageEntry(provider, "job", reading)),
        createProvider: this.deps.createProvider,
        worktreesRoot: this.deps.worktreesRoot,
        signal: abort.signal,
        authorize: async (stage) => {
          try {
            const answer = await client.authorize(envelope.jobId, { ...lease, stage });
            if (!answer.authorized) stop(answer.reason ?? "Router withdrew authorization");
            return answer.authorized;
          } catch (error) {
            // Fail closed: no commit/validate without a positive answer.
            stop(`authorize failed: ${error instanceof Error ? error.message : String(error)}`);
            return false;
          }
        },
      });
    } finally {
      done = true;
    }
    await Promise.all([heartbeatLoop, watchdog]);

    // Whatever the executor made of the abort, the runner knows *why* it stopped.
    if (stopReason) {
      outcome = { ...outcome, status: "cancelled", summary: `Stopped: ${stopReason}` };
    }
    await this.submit({
      protocolVersion: PROTOCOL_VERSION,
      jobId: envelope.jobId,
      attemptId: envelope.attemptId,
      resultId: this.genId(),
      ...outcome,
    });
    await this.reportUsage([...usage.values()]);
  }

  private async probeUsage(): Promise<void> {
    const readings = await Promise.all(
      this.deps.config.providers.map(async (config) => {
        try {
          const provider = this.deps.createProvider(config);
          if (!provider.readUsage) return undefined;
          return this.usageEntry(config, "probe", await provider.readUsage());
        } catch (error) {
          return this.usageEntry(config, "probe", {
            windows: [],
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );
    await this.reportUsage(readings.filter((entry) => entry !== undefined));
  }

  private usageEntry(
    provider: WorkerProviderConfig,
    source: ProviderUsage["source"],
    reading: UsageReading,
  ): ProviderUsage {
    return {
      providerId: provider.id,
      providerType: provider.type,
      observedAt: new Date(this.nowMs()).toISOString(),
      source,
      ...reading,
    };
  }

  /** Best-effort: usage is informational, so a failed report is logged and dropped. */
  private async reportUsage(usage: ProviderUsage[], retried = false): Promise<void> {
    const sessionId = this.sessionId;
    if (usage.length === 0 || !sessionId) return;
    try {
      await this.deps.client.reportUsage({ sessionId, workerId: this.deps.workerId, usage });
    } catch (error) {
      // A reconnect while the probe was running superseded the session it was sent under.
      const stale = error instanceof RouterApiError && error.body?.error === "stale_session";
      if (stale && !retried && this.sessionId !== sessionId) {
        return this.reportUsage(usage, true);
      }
      this.deps.logger?.warn({ err: error, layer: "worker-runtime" }, "usage report failed");
    }
  }

  /** Spool first, then submit; ack (delete) only once Router has answered. A failed submit
   *  leaves the file for `flushSpool` on the next start. */
  private async submit(result: JobResult): Promise<void> {
    this.deps.spool.save(result);
    try {
      await this.deps.client.submitResult(result);
      this.deps.spool.ack(result.resultId);
    } catch (error) {
      if (error instanceof RouterApiError && (error.status === 404 || error.status === 403)) {
        // Router will never accept this one (unknown attempt / not ours); keep it on disk for a
        // human, but don't resend forever.
        this.deps.logger?.error({ err: error, resultId: result.resultId }, "result rejected");
        return;
      }
      this.deps.logger?.warn(
        { err: error, resultId: result.resultId },
        "result submit failed; spooled",
      );
    }
  }

  /** Resends every spooled result. Router treats an identical resend as success. */
  async flushSpool(): Promise<void> {
    for (const result of this.deps.spool.listPending()) {
      try {
        await this.deps.client.submitResult(result);
        this.deps.spool.ack(result.resultId);
      } catch (error) {
        this.deps.logger?.warn(
          { err: error, resultId: result.resultId },
          "spooled result resend failed",
        );
      }
    }
  }

  private requireSession(): string {
    if (!this.sessionId) throw new Error("WorkerRunner: call connect() before polling");
    return this.sessionId;
  }
}
