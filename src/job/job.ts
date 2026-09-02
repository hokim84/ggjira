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
}

const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set([
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
]);

const ALLOWED_TRANSITIONS: Readonly<Record<JobStatus, ReadonlySet<JobStatus>>> = {
  queued: new Set(["claimed", "failed"]),
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
