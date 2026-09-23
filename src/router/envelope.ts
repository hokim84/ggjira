import type Database from "better-sqlite3";
import {
  type IssueSnapshot,
  IssueSnapshotSchema,
  type JobEnvelope,
  type PlanningContext,
  PlanningContextSchema,
} from "../contracts/envelope.js";
import { PROTOCOL_VERSION } from "../contracts/protocol.js";
import { buildPmSystemPrompt } from "../pm/prompt.js";
import { buildImplementSystemPrompt } from "../worker/prompt.js";
import type { RouterConfig } from "./config.js";
import type { AttemptRow } from "./db/attempts.js";
import { getApproval } from "./db/approvals.js";
import type { JobRow } from "./db/jobs.js";

export class EnvelopeUnavailableError extends Error {
  constructor(
    readonly jobId: string,
    reason: string,
  ) {
    super(`Cannot build a job envelope for ${jobId}: ${reason}`);
    this.name = "EnvelopeUnavailableError";
  }
}

/** The approval snapshot `storeApproval` writes (src/router/issue-check.ts). Only `issue` and
 *  `planning` are read here; both are re-validated rather than trusted, since they round-trip
 *  through JSON. */
interface StoredApprovalSnapshot {
  issue?: unknown;
  planning?: unknown;
}

function toIssueSnapshot(jobId: string, snapshot: unknown): IssueSnapshot {
  const issue = (snapshot as StoredApprovalSnapshot | null)?.issue;
  const parsed = IssueSnapshotSchema.safeParse(issue);
  if (!parsed.success) {
    throw new EnvelopeUnavailableError(
      jobId,
      `stored issue snapshot is invalid: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

function toPlanningContext(jobId: string, snapshot: unknown): PlanningContext {
  const planning = (snapshot as StoredApprovalSnapshot | null)?.planning;
  // A planning job whose issue was never scanned with planning context (it cannot normally
  // happen: reconcile collects it before creating the job) still gets the issue itself.
  const parsed = PlanningContextSchema.safeParse(planning ?? {});
  if (!parsed.success) {
    throw new EnvelopeUnavailableError(
      jobId,
      `stored planning context is invalid: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/**
 * Assembles what a worker receives for a leased attempt entirely from Router's own DB — the
 * issue snapshot and input hash captured by the last reconcile — so `jobs/next` never waits on
 * Jira (§3 "네트워크 호출을 DB 트랜잭션 안에서 기다리지 않는다"). A planning job also gets the
 * comments/subtasks/decision reply reconcile collected, and the PM system prompt.
 */
export function buildJobEnvelope(
  db: Database.Database,
  config: RouterConfig,
  job: JobRow,
  attempt: AttemptRow,
): JobEnvelope {
  const approval = getApproval(db, job.issueKey);
  if (!approval) throw new EnvelopeUnavailableError(job.id, "no approval row for its issue");
  const policy = config.workers.find((entry) => entry.workerId === attempt.workerId);
  if (!policy) {
    throw new EnvelopeUnavailableError(job.id, `worker ${attempt.workerId} has no config policy`);
  }

  return {
    protocolVersion: PROTOCOL_VERSION,
    jobId: job.id,
    attemptId: attempt.id,
    leaseToken: attempt.leaseToken,
    workspaceId: job.workspaceId,
    repositoryId: job.repositoryId,
    kind: job.kind,
    providerId: policy.providerId,
    approvalId: job.approvalId,
    inputHash: job.inputHash ?? approval.inputHash,
    issueSnapshot: toIssueSnapshot(job.id, approval.inputSnapshot),
    ...(job.kind === "planning"
      ? { planningContext: toPlanningContext(job.id, approval.inputSnapshot) }
      : {}),
    systemPrompt: job.kind === "planning" ? buildPmSystemPrompt() : buildImplementSystemPrompt(),
    timeoutMs: config.execution.timeoutMs,
  };
}
