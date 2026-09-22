/**
 * Pure job state machine shared by Router (persists it in SQLite) and any
 * code that needs to reason about valid transitions without touching the DB
 * (docs/router-service-implementation-plan.md §3 "임대와 작업 상태"):
 *
 *   waiting → queued → leased → running → succeeded / failed / timed_out
 *                         │        │
 *                         │        ├→ cancel_requested → cancelled
 *                         │        └→ recovery_required
 *                         └→ queued  (start 허가가 전혀 없었던 경우만)
 *
 * `failed`/`timed_out`/`recovery_required` are not fully closed: a manual
 * retry (§3 "수동 재시도는 새로운 attempt를 만든다") reopens the same job row
 * by moving it back to `queued`, and the next lease stamps a fresh attempt
 * row. Only `succeeded`/`cancelled` release the one-non-terminal-job-per-issue
 * slot (`isJobStateOpen` below) — everything else still occupies it, since
 * it either needs a human decision or can still be retried in place.
 */
export const JOB_STATES = [
  "waiting",
  "queued",
  "leased",
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "cancel_requested",
  "cancelled",
  "recovery_required",
] as const;

export type JobState = (typeof JOB_STATES)[number];

const CLOSED_JOB_STATES: ReadonlySet<JobState> = new Set(["succeeded", "cancelled"]);

const ALLOWED_JOB_TRANSITIONS: Readonly<Record<JobState, ReadonlySet<JobState>>> = {
  waiting: new Set(["queued", "cancelled"]),
  queued: new Set(["leased", "cancelled"]),
  leased: new Set(["running", "queued", "cancelled"]),
  running: new Set(["succeeded", "failed", "timed_out", "cancel_requested", "recovery_required"]),
  // `recovery_required` when the lease runs out before the worker confirms it stopped: a
  // cancel request doesn't prove the process is gone (ADR 0020).
  cancel_requested: new Set(["cancelled", "recovery_required"]),
  recovery_required: new Set(["cancelled", "queued"]),
  failed: new Set(["queued"]),
  timed_out: new Set(["queued"]),
  succeeded: new Set(),
  cancelled: new Set(),
};

export class InvalidJobStateTransitionError extends Error {
  constructor(
    readonly from: JobState,
    readonly to: JobState,
  ) {
    super(`Invalid job state transition: ${from} -> ${to}`);
    this.name = "InvalidJobStateTransitionError";
  }
}

/** True once a job no longer occupies the one-non-terminal-job-per-issue slot. */
export function isJobStateClosed(state: JobState): boolean {
  return CLOSED_JOB_STATES.has(state);
}

/** Throws if the transition isn't one of the arrows in the diagram above. */
export function assertJobStateTransition(from: JobState, to: JobState): void {
  if (!ALLOWED_JOB_TRANSITIONS[from].has(to)) {
    throw new InvalidJobStateTransitionError(from, to);
  }
}

export function canTransitionJobState(from: JobState, to: JobState): boolean {
  return ALLOWED_JOB_TRANSITIONS[from].has(to);
}

/**
 * States in which a job is leased to (or was just leased to) a specific
 * worker/attempt — used to decide when `attempts.worker_id` should occupy
 * the one-active-attempt-per-worker slot.
 */
export const ACTIVE_ATTEMPT_JOB_STATES: ReadonlySet<JobState> = new Set([
  "leased",
  "running",
  "cancel_requested",
]);
