import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { canHandle } from "../agent/capability.js";
import type { JiraGateway } from "../jira/gateway.js";
import type { JiraIssue } from "../jira/types.js";
import { PlanMetadataError } from "../pm/metadata.js";
import {
  getActiveAttemptForWorker,
  getAttempt,
  leaseAttempt,
  transitionAttemptState,
} from "./db/attempts.js";
import { markWorkerAssigned } from "./db/workers.js";
import {
  createJob,
  type JobRow,
  getOpenJobForIssue,
  getActiveJobs,
  getOpenJobs,
  getQueuedJobs,
  transitionJobState,
} from "./db/jobs.js";
import { findWorkspaceCandidates } from "./candidates.js";
import type { RouterConfig, WorkspaceConfig } from "./config.js";
import { canTransitionAttemptState } from "../contracts/attempt-state.js";
import { isRouteDispatch } from "../contracts/route.js";
import type { DecisionProvider, RouteContext } from "./decision.js";
import {
  checkJobAgainstJira,
  collectPlanningContext,
  type IssueApproval,
  kindForStatus,
  readIssueApproval,
  storeApproval,
} from "./issue-check.js";

/** How long a lease is valid before Router considers it expired
 *  (docs/router-service-implementation-plan.md §3 "임대: 30초"). Stage 3/4 own renewal. */
export const LEASE_DURATION_MS = 30_000;

export interface WorkerAvailability {
  workerId: string;
  /** As reported by the worker itself, before intersecting with the admin's `allowedCapabilities`
   *  (§2 "관리자가 허용한 capability·저장소와 워커가 보고한 가용성의 교집합만 사용한다"). */
  capabilities: string[];
  repositoryIds: string[];
  /** ISO timestamp of the worker's last assignment, or `null` if it has never been assigned
   *  (sorts first — §2 "워커는 가장 오래 배정받지 않은 순서"). */
  lastAssignedAt: string | null;
}

export interface SchedulerDeps {
  db: Database.Database;
  jira: JiraGateway;
  config: RouterConfig;
  decisionProvider: DecisionProvider;
  now: () => string;
  genId?: () => string;
  /** Router's own Jira account, for telling human decision replies apart from Router's own
   *  comments. Looked up once per pass via `getMyself` when not supplied. */
  routerAccountId?: string;
}

export interface SchedulerReport {
  candidatesSeen: number;
  /** Job ids created this pass, queued or waiting. */
  jobsCreated: string[];
  jobsCancelled: string[];
  jobsCancelRequested: string[];
  jobsAssigned: Array<{ jobId: string; workerId: string }>;
  held: Array<{ issueKey: string; target: "human" | "ignore"; reason: string }>;
  skipped: Array<{ issueKey: string; reason: string }>;
}

function newReport(): SchedulerReport {
  return {
    candidatesSeen: 0,
    jobsCreated: [],
    jobsCancelled: [],
    jobsCancelRequested: [],
    jobsAssigned: [],
    held: [],
    skipped: [],
  };
}

/** Extracts Jira issue keys (e.g. "PROJ-123") out of free-text dependency lines, mirroring
 *  `src/agent/runtime.ts`'s v4 dependency check. */
function extractDependencyKeys(dependencies: readonly string[]): string[] {
  return dependencies
    .map((dependency) => dependency.match(/[A-Z][A-Z0-9_]+-\d+/)?.[0])
    .filter((key): key is string => Boolean(key));
}

/** A dependency is unresolved while it still sits in an active/pending status for its own
 *  workflow — confirmed with the user: since v5 workflow has no `completionStatus`, "reached
 *  `reviewStatus` or beyond" is treated as done. */
function isDependencyUnresolved(statusName: string, workspace: WorkspaceConfig): boolean {
  const { requestStatus, planningStatus, inProgressStatus } = workspace.workflow;
  return (
    statusName === requestStatus || statusName === planningStatus || statusName === inProgressStatus
  );
}

async function resolveUnresolvedDependencies(
  jira: JiraGateway,
  workspace: WorkspaceConfig,
  dependencyKeys: readonly string[],
): Promise<string[]> {
  const unresolved: string[] = [];
  for (const key of dependencyKeys) {
    const dependency = await jira.getIssue(key);
    if (isDependencyUnresolved(dependency.statusName, workspace)) unresolved.push(key);
  }
  return unresolved;
}

/** Cancels a stale open job, respecting the state machine: `waiting`/`queued`/`leased` free the
 *  one-open-job-per-issue slot immediately; `running` can only be asked to stop
 *  (`cancel_requested`) and keeps occupying the slot until the stop is confirmed; a `failed`/
 *  `timed_out` job has nothing running, so it closes too (a human re-approved the issue — ADR 0021);
 *  `recovery_required` and an already `cancel_requested` job are left alone until a worker or an
 *  admin confirms the stop. Returns whether the slot is now free. */
export function cancelStaleJob(
  db: Database.Database,
  job: JobRow,
  now: string,
  report?: Pick<SchedulerReport, "jobsCancelled" | "jobsCancelRequested">,
): boolean {
  // An explicit state list, not `canTransitionJobState`: `cancel_requested` and
  // `recovery_required` can also reach `cancelled`, but only on a confirmed stop (worker result
  // or admin resolve) — never because a reconcile pass noticed the approval is gone.
  if (
    job.state === "waiting" ||
    job.state === "queued" ||
    job.state === "leased" ||
    job.state === "failed" ||
    job.state === "timed_out"
  ) {
    const run = db.transaction(() => {
      transitionJobState(db, job.id, "cancelled", now);
      // A leased job's attempt must go with it, or it keeps occupying the worker's
      // one-active-attempt slot even though its job is closed.
      transitionCurrentAttempt(db, job, "cancelled", now);
    });
    run();
    report?.jobsCancelled.push(job.id);
    return true;
  }
  if (job.state === "running") {
    const run = db.transaction(() => {
      transitionJobState(db, job.id, "cancel_requested", now);
      // The worker learns about it through the attempt (job/worker heartbeat).
      transitionCurrentAttempt(db, job, "cancel_requested", now);
    });
    run();
    report?.jobsCancelRequested.push(job.id);
    return false;
  }
  return false;
}

function transitionCurrentAttempt(
  db: Database.Database,
  job: JobRow,
  to: "cancelled" | "cancel_requested",
  now: string,
): void {
  if (!job.currentAttemptId) return;
  const attempt = getAttempt(db, job.currentAttemptId);
  if (attempt && canTransitionAttemptState(attempt.state, to)) {
    transitionAttemptState(db, attempt.id, to, now);
  }
}

async function reconcileIssue(
  deps: SchedulerDeps,
  workspace: WorkspaceConfig,
  issue: JiraIssue,
  genId: () => string,
  routerAccountId: () => Promise<string>,
  report: SchedulerReport,
): Promise<void> {
  const kind = kindForStatus(issue.statusName, workspace);
  let approval: IssueApproval;
  try {
    approval = await readIssueApproval(deps.jira, issue, kind, workspace);
  } catch (error) {
    if (error instanceof PlanMetadataError) {
      report.skipped.push({ issueKey: issue.key, reason: error.message });
      // Corrupted or superseded plan metadata withdraws the approval an open job relied on.
      const openJob = getOpenJobForIssue(deps.db, issue.key);
      if (openJob && VERIFIED_JOB_STATES.has(openJob.state)) {
        cancelStaleJob(deps.db, openJob, deps.now(), report);
      }
      return;
    }
    throw error;
  }
  const { requirements, planTask, approvalId, inputHash } = approval;

  const dependencyKeys = extractDependencyKeys(requirements.dependencies);
  const unresolvedDependencies = await resolveUnresolvedDependencies(
    deps.jira,
    workspace,
    dependencyKeys,
  );
  // A planning job's envelope carries comments/subtasks/decision reply; collected here, outside
  // any DB transaction, so `jobs/next` can build the envelope from SQLite alone.
  const planning =
    kind === "planning"
      ? await collectPlanningContext(deps.jira, issue, await routerAccountId())
      : undefined;
  const now = deps.now();
  storeApproval(deps.db, approval, now, planning);

  const existingJob = getOpenJobForIssue(deps.db, issue.key);
  if (existingJob) {
    const approvalCurrent =
      existingJob.approvalId === approvalId &&
      (existingJob.inputHash === null || existingJob.inputHash === inputHash) &&
      issue.assigneeAccountId !== null;
    if (approvalCurrent && existingJob.state !== "waiting") {
      // Unchanged, already dispatched/leased/running/etc — nothing for this pass to do.
      return;
    }
    if (approvalCurrent && existingJob.state === "waiting" && unresolvedDependencies.length > 0) {
      // Still waiting on the same dependencies.
      return;
    }
    // Either the approval/inputs changed underneath an open job (cancel reason per §2), or the
    // job was only "waiting" and its dependencies just resolved — both cases re-decide fresh.
    const slotFreed = cancelStaleJob(deps.db, existingJob, now, report);
    if (!slotFreed) return;
  }

  const context: RouteContext = {
    issue,
    requirements,
    planTask,
    workspace,
    unresolvedDependencies,
    executionAgentOptionId: issue.executionAgentOptionId ?? null,
  };
  const decision = deps.decisionProvider.decide(context);

  if (isRouteDispatch(decision)) {
    const job = createJob(deps.db, {
      id: genId(),
      issueKey: issue.key,
      workspaceId: decision.workspaceId,
      repositoryId: decision.repositoryId,
      kind: decision.target,
      approvalId,
      inputHash,
      state: "queued",
      pinnedWorkerId: decision.pinnedWorkerId ?? null,
      requiredCapabilities: decision.requiredCapabilities,
      now,
    });
    report.jobsCreated.push(job.id);
    return;
  }

  if (decision.target === "wait") {
    const job = createJob(deps.db, {
      id: genId(),
      issueKey: issue.key,
      workspaceId: workspace.id,
      repositoryId: workspace.repositoryId,
      kind,
      approvalId,
      inputHash,
      state: "waiting",
      requiredCapabilities: requirements.requiredCapabilities,
      now,
    });
    report.jobsCreated.push(job.id);
    return;
  }

  report.held.push({ issueKey: issue.key, target: decision.target, reason: decision.reason });
}

/** What the assignment pass needs — no Jira, so `jobs/next` can run it on demand for one worker
 *  (src/router/worker-service.ts) without waiting for the next background reconcile. */
export type AssignDeps = Pick<SchedulerDeps, "db" | "config" | "now" | "genId">;

export interface Assignment {
  jobId: string;
  workerId: string;
  attemptId: string;
}

/**
 * Leases `queued` jobs (oldest first) to matching workers. Exported so `jobs/next` can call it
 * with just the requesting worker's availability. Each lease also stamps that worker's
 * `last_assigned_at` (a no-op for workers not registered in the `workers` table), which is what
 * `buildWorkerAvailability` feeds back as `lastAssignedAt` for the next pass's fairness order.
 */
export function assignQueuedJobs(
  deps: AssignDeps,
  availableWorkers: WorkerAvailability[],
  report?: SchedulerReport,
): Assignment[] {
  const genId = deps.genId ?? randomUUID;
  const claimedWorkerIds = new Set<string>();
  const assignments: Assignment[] = [];

  for (const job of getQueuedJobs(deps.db)) {
    const candidates = availableWorkers
      .filter((worker) => !claimedWorkerIds.has(worker.workerId))
      .filter((worker) => {
        const policy = deps.config.workers.find((w) => w.workerId === worker.workerId);
        if (!policy || !policy.enabled) return false;
        if (!policy.allowedRepositoryIds.includes(job.repositoryId)) return false;
        if (!worker.repositoryIds.includes(job.repositoryId)) return false;
        if (job.pinnedWorkerId && job.pinnedWorkerId !== worker.workerId) return false;
        const effectiveCapabilities = policy.allowedCapabilities.filter((capability) =>
          worker.capabilities.includes(capability),
        );
        if (!canHandle(effectiveCapabilities, job.requiredCapabilities).ok) return false;
        return !getActiveAttemptForWorker(deps.db, worker.workerId);
      })
      .sort((a, b) => {
        const aTime = a.lastAssignedAt ?? "";
        const bTime = b.lastAssignedAt ?? "";
        return aTime !== bTime ? aTime.localeCompare(bTime) : a.workerId.localeCompare(b.workerId);
      });

    const chosen = candidates[0];
    if (!chosen) continue;

    const now = deps.now();
    const leaseExpiresAt = new Date(new Date(now).getTime() + LEASE_DURATION_MS).toISOString();
    const attemptId = genId();
    const lease = deps.db.transaction(() => {
      leaseAttempt(deps.db, {
        id: attemptId,
        jobId: job.id,
        workerId: chosen.workerId,
        leaseToken: randomUUID(),
        leaseExpiresAt,
        now,
      });
      transitionJobState(deps.db, job.id, "leased", now);
      markWorkerAssigned(deps.db, chosen.workerId, now);
    });
    lease();
    claimedWorkerIds.add(chosen.workerId);
    report?.jobsAssigned.push({ jobId: job.id, workerId: chosen.workerId });
    assignments.push({ jobId: job.id, workerId: chosen.workerId, attemptId });
  }
  return assignments;
}

/** Job states whose approval is re-checked against Jira: anything that may still be dispatched or
 *  run. `failed`/`timed_out`/`recovery_required` wait for a human instead. */
const VERIFIED_JOB_STATES = new Set(["waiting", "queued", "leased", "running"]);

/**
 * Re-checks one open job against Jira and cancels it if its approval no longer stands. Once Router
 * moves an issue to `inProgressStatus` on `start`, "absent from the candidate scan" no longer
 * means "revoked" (ADR 0019's caveat), so every out-of-scan job is asked about directly. A Jira
 * failure leaves the job alone — "couldn't ask" is never treated as "revoked".
 */
async function verifyJob(deps: SchedulerDeps, job: JobRow, report: SchedulerReport): Promise<void> {
  let check: Awaited<ReturnType<typeof checkJobAgainstJira>>;
  try {
    check = await checkJobAgainstJira(deps.jira, deps.config, job);
  } catch (error) {
    report.skipped.push({
      issueKey: job.issueKey,
      reason: `approval re-check failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    return;
  }
  const now = deps.now();
  if (check.verdict === "current") {
    storeApproval(deps.db, check.approval, now);
    return;
  }
  report.skipped.push({ issueKey: job.issueKey, reason: check.reason });
  cancelStaleJob(deps.db, job, now, report);
}

async function reverifyUnseenOpenJobs(
  deps: SchedulerDeps,
  processedIssueKeys: ReadonlySet<string>,
  report: SchedulerReport,
): Promise<void> {
  for (const job of getOpenJobs(deps.db)) {
    if (processedIssueKeys.has(job.issueKey) || !VERIFIED_JOB_STATES.has(job.state)) continue;
    await verifyJob(deps, job, report);
  }
}

/**
 * The fast path for jobs that may be running right now (§2 "활성 작업의 승인은 최대 5초 간격으로
 * 중앙에서 확인한다"): re-checks every leased/running job against Jira. A revoked running job is
 * moved to `cancel_requested`, which the worker hears on its next job heartbeat.
 */
export async function verifyActiveJobs(deps: SchedulerDeps): Promise<SchedulerReport> {
  const report = newReport();
  for (const job of getActiveJobs(deps.db)) {
    if (!VERIFIED_JOB_STATES.has(job.state)) continue;
    await verifyJob(deps, job, report);
  }
  return report;
}

/**
 * The background reconcile: re-derives Router's SQLite job/attempt state from the latest Jira
 * signals for every configured workspace, then assigns whatever is now `queued` to an available
 * worker (docs/router-service-implementation-plan.md §4 "2. Router 입력·판단"). Called on a
 * timer for the background/startup full sync (§2 "웹훅과 보완 조회"); a future webhook-driven
 * path can call it for a single issue instead once stage 3/4 exist.
 */
export async function reconcileCandidates(
  deps: SchedulerDeps,
  availableWorkers: WorkerAvailability[],
): Promise<SchedulerReport> {
  const genId = deps.genId ?? randomUUID;
  const report = newReport();
  const processedIssueKeys = new Set<string>();
  let cachedAccountId = deps.routerAccountId;
  const routerAccountId = async (): Promise<string> => {
    cachedAccountId ??= (await deps.jira.getMyself()).accountId;
    return cachedAccountId;
  };

  for (const workspace of deps.config.workspaces) {
    const candidates = await findWorkspaceCandidates(deps.jira, workspace);
    for (const issue of candidates) {
      report.candidatesSeen += 1;
      processedIssueKeys.add(issue.key);
      await reconcileIssue(deps, workspace, issue, genId, routerAccountId, report);
    }
  }

  await reverifyUnseenOpenJobs(deps, processedIssueKeys, report);
  assignQueuedJobs(deps, availableWorkers, report);
  return report;
}
