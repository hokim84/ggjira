export type JobStatus =
  | "queued"
  | "claimed"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled";

export type FailureStage = "jira" | "poller" | "job" | "worker" | "reporter";

export interface Job {
  runId: string;
  issueKey: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  branch?: string;
  summary?: string;
  failureStage?: FailureStage;
  error?: string;
  /** True when the job itself finished, but writing the outcome back to Jira failed. */
  reportingFailed?: boolean;
  reportingError?: string;
}

const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set([
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
]);

const ALLOWED_TRANSITIONS: Readonly<Record<JobStatus, ReadonlySet<JobStatus>>> = {
  queued: new Set(["claimed", "failed", "cancelled"]),
  claimed: new Set(["running", "failed"]),
  running: new Set(["succeeded", "failed", "timed_out", "cancelled"]),
  succeeded: new Set(),
  failed: new Set(),
  timed_out: new Set(),
  cancelled: new Set(),
};

export class InvalidJobTransitionError extends Error {
  constructor(
    readonly from: JobStatus,
    readonly to: JobStatus,
  ) {
    super(`Invalid job transition: ${from} -> ${to}`);
    this.name = "InvalidJobTransitionError";
  }
}

export function isTerminalStatus(status: JobStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function createJob(issueKey: string, runId: string, now: Date = new Date()): Job {
  const timestamp = now.toISOString();
  return {
    runId,
    issueKey,
    status: "queued",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/**
 * Records that reporting the (already-terminal) job outcome back to Jira
 * failed. Does not change `status` — the job itself already succeeded or
 * failed; this only flags that Jira was never told.
 */
export function markReportingFailed(job: Job, error: unknown, now: Date = new Date()): Job {
  return {
    ...job,
    reportingFailed: true,
    reportingError: error instanceof Error ? error.message : String(error),
    updatedAt: now.toISOString(),
  };
}

export function transitionJob(
  job: Job,
  next: JobStatus,
  patch: Partial<Omit<Job, "runId" | "issueKey" | "createdAt" | "status" | "updatedAt">> = {},
  now: Date = new Date(),
): Job {
  if (!ALLOWED_TRANSITIONS[job.status].has(next)) {
    throw new InvalidJobTransitionError(job.status, next);
  }
  return {
    ...job,
    ...patch,
    status: next,
    updatedAt: now.toISOString(),
  };
}
