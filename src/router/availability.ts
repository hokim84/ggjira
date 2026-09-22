import type Database from "better-sqlite3";
import type { RouterConfig } from "./config.js";
import { listWorkers, type WorkerRow } from "./db/workers.js";
import type { WorkerAvailability } from "./scheduler.js";

/** A worker is offered work only while its general heartbeat is this fresh. Three missed 5s
 *  heartbeats (§3 "heartbeat: 5초") — long enough to ride out one slow request, short enough that
 *  a vanished worker stops receiving leases well within one 30s lease period. */
export const WORKER_HEARTBEAT_FRESHNESS_MS = 15_000;

/** Whether a registered worker may be handed new work right now, independent of any job. */
export function isWorkerDispatchable(
  worker: WorkerRow,
  config: RouterConfig,
  now: string,
): boolean {
  if (worker.revokedAt || !worker.enabled || !worker.currentSessionId) return false;
  if (!worker.lastHeartbeatAt) return false;
  if (Date.parse(now) - Date.parse(worker.lastHeartbeatAt) > WORKER_HEARTBEAT_FRESHNESS_MS) {
    return false;
  }
  const policy = config.workers.find((entry) => entry.workerId === worker.id);
  return Boolean(policy?.enabled);
}

export function toWorkerAvailability(worker: WorkerRow): WorkerAvailability {
  return {
    workerId: worker.id,
    capabilities: worker.reportedCapabilities,
    repositoryIds: worker.reportedRepositoryIds,
    lastAssignedAt: worker.lastAssignedAt,
  };
}

/**
 * The adapter stage 2 left open (ADR 0019 §3): turns the `workers` table — registration,
 * session, last heartbeat's self-reported availability — into the `WorkerAvailability[]` that
 * `reconcileCandidates`/`assignQueuedJobs` take as pure input. The admin policy intersection
 * itself stays in the scheduler; this only decides who is online and eligible at all.
 */
export function buildWorkerAvailability(
  db: Database.Database,
  config: RouterConfig,
  now: string,
): WorkerAvailability[] {
  return listWorkers(db)
    .filter((worker) => isWorkerDispatchable(worker, config, now))
    .map(toWorkerAvailability);
}
