/**
 * Pure attempt state machine, the attempt-level counterpart to
 * `job-state.ts`'s job state machine (docs/router-service-implementation-plan.md §3
 * "임대와 작업 상태"). An attempt row is created once a job is leased to a
 * worker and is never reopened: a manual retry creates a brand new attempt
 * row for the same job (§3 "수동 재시도는 새로운 attempt를 만든다"). `superseded`
 * marks an attempt that was left in `recovery_required` when that retry
 * happened — the retry itself is a new attempt row, not a transition of the
 * old one.
 */
export const ATTEMPT_STATES = [
  "leased",
  "running",
  "cancel_requested",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "recovery_required",
  "superseded",
] as const;

export type AttemptState = (typeof ATTEMPT_STATES)[number];

/**
 * States in which an attempt occupies the one-active-attempt-per-worker slot
 * (`attempts(worker_id)` partial unique index in `db/schema.ts`). Matches the
 * job-level `ACTIVE_ATTEMPT_JOB_STATES` in `job-state.ts` by value, but the
 * two are conceptually distinct (one indexes `jobs.state`, the other
 * `attempts.state`) and are kept as separate exports on purpose.
 */
export const ACTIVE_ATTEMPT_STATES: ReadonlySet<AttemptState> = new Set([
  "leased",
  "running",
  "cancel_requested",
]);

const ALLOWED_ATTEMPT_TRANSITIONS: Readonly<Record<AttemptState, ReadonlySet<AttemptState>>> = {
  // A lease that never saw a `start` call is cancelled, not recovered — the
  // job itself goes back to `queued` for a fresh lease (job-state.ts).
  leased: new Set(["running", "cancelled", "recovery_required"]),
  running: new Set(["succeeded", "failed", "timed_out", "cancel_requested", "recovery_required"]),
  // Lease expiry while a cancel is pending: the stop was never confirmed (ADR 0020).
  cancel_requested: new Set(["cancelled", "recovery_required"]),
  // Resolved only by a confirmed abort (worker or admin) per §3; cancelled if
  // the job is abandoned, superseded once a retry's new attempt takes over.
  recovery_required: new Set(["cancelled", "superseded"]),
  succeeded: new Set(),
  failed: new Set(),
  timed_out: new Set(),
  cancelled: new Set(),
  superseded: new Set(),
};

export class InvalidAttemptStateTransitionError extends Error {
  constructor(
    readonly from: AttemptState,
    readonly to: AttemptState,
  ) {
    super(`Invalid attempt state transition: ${from} -> ${to}`);
    this.name = "InvalidAttemptStateTransitionError";
  }
}

/** Throws if the transition isn't one of the arrows in the diagram above. */
export function assertAttemptStateTransition(from: AttemptState, to: AttemptState): void {
  if (!ALLOWED_ATTEMPT_TRANSITIONS[from].has(to)) {
    throw new InvalidAttemptStateTransitionError(from, to);
  }
}

export function canTransitionAttemptState(from: AttemptState, to: AttemptState): boolean {
  return ALLOWED_ATTEMPT_TRANSITIONS[from].has(to);
}

export function isAttemptStateTerminal(state: AttemptState): boolean {
  return ALLOWED_ATTEMPT_TRANSITIONS[state].size === 0;
}
