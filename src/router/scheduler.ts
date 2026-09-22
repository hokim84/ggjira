import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { canHandle } from "../agent/capability.js";
import { readIssueRequirements } from "../agent/requirements.js";
import type { JiraGateway } from "../jira/gateway.js";
import type { JiraIssue } from "../jira/types.js";
import { PlanMetadataError, type PlanTaskMetadata, readPlanTaskMetadata } from "../pm/metadata.js";
import { getActiveAttemptForWorker, leaseAttempt } from "./db/attempts.js";
import { upsertApproval } from "./db/approvals.js";
import {
  createJob,
  type JobRow,
  getOpenJobForIssue,
  getOpenJobs,
  getQueuedJobs,
  transitionJobState,
} from "./db/jobs.js";
import { computeApprovalId, computeInputHash } from "./approval.js";
import { findWorkspaceCandidates } from "./candidates.js";
import type { RouterConfig, WorkspaceConfig } from "./config.js";
import { canTransitionJobState } from "../contracts/job-state.js";
import { isRouteDispatch } from "../contracts/route.js";
import type { DecisionProvider, RouteContext } from "./decision.js";

/** How long a lease is valid before Router considers it expired
 *  (docs/router-service-implementation-plan.md §3 "임대: 30초"). Stage 3/4 own renewal. */
const LEASE_DURATION_MS = 30_000;

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
 *  (`cancel_requested`) and keeps occupying the slot until stage 3/4 confirms it stopped; any
 *  other open state (`failed`/`timed_out`/`recovery_required`/already `cancel_requested`) is left
 *  alone for a human/CLI retry (§3 "수동 재시도는 새로운 attempt를 만든다") rather than forced
 *  through a transition the state machine doesn't allow. Returns whether the slot is now free. */
function cancelStaleJob(
  db: Database.Database,
  job: JobRow,
  now: string,
  report: SchedulerReport,
): boolean {
  if (canTransitionJobState(job.state, "cancelled")) {
    transitionJobState(db, job.id, "cancelled", now);
    report.jobsCancelled.push(job.id);
    return true;
  }
  if (canTransitionJobState(job.state, "cancel_requested")) {
    transitionJobState(db, job.id, "cancel_requested", now);
    report.jobsCancelRequested.push(job.id);
    return false;
  }
  return false;
}

async function reconcileIssue(
  deps: SchedulerDeps,
  workspace: WorkspaceConfig,
  issue: JiraIssue,
  genId: () => string,
  report: SchedulerReport,
): Promise<void> {
  let planTask: PlanTaskMetadata | null;
  try {
    planTask = await readPlanTaskMetadata(deps.jira, issue.key);
  } catch (error) {
    if (error instanceof PlanMetadataError) {
      report.skipped.push({ issueKey: issue.key, reason: error.message });
      return;
    }
    throw error;
  }

  const requirements = readIssueRequirements(issue);
  const dependencyKeys = extractDependencyKeys(requirements.dependencies);
  const unresolvedDependencies = await resolveUnresolvedDependencies(
    deps.jira,
    workspace,
    dependencyKeys,
  );
  const approvalId = await computeApprovalId(deps.jira, issue, workspace.workflow.requestStatus);
  const inputHash = computeInputHash(requirements, planTask);
  const now = deps.now();

  upsertApproval(deps.db, {
    issueKey: issue.key,
    approvalId,
    inputHash,
    inputSnapshot: { issue, requirements, planTask },
    now,
  });

  const existingJob = getOpenJobForIssue(deps.db, issue.key);
  if (existingJob) {
    const approvalCurrent = existingJob.approvalId === approvalId;
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
      state: "queued",
      pinnedWorkerId: decision.pinnedWorkerId ?? null,
      requiredCapabilities: decision.requiredCapabilities,
      now,
    });
    report.jobsCreated.push(job.id);
    return;
  }

  if (decision.target === "wait") {
    const kind =
      issue.statusName === workspace.workflow.planningStatus ? "planning" : "implementation";
    const job = createJob(deps.db, {
      id: genId(),
      issueKey: issue.key,
      workspaceId: workspace.id,
      repositoryId: workspace.repositoryId,
      kind,
      approvalId,
      state: "waiting",
      requiredCapabilities: requirements.requiredCapabilities,
      now,
    });
    report.jobsCreated.push(job.id);
    return;
  }

  report.held.push({ issueKey: issue.key, target: decision.target, reason: decision.reason });
}

function assignQueuedJobs(
  deps: SchedulerDeps,
  availableWorkers: WorkerAvailability[],
  report: SchedulerReport,
): void {
  const genId = deps.genId ?? randomUUID;
  const claimedWorkerIds = new Set<string>();

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
    leaseAttempt(deps.db, {
      id: genId(),
      jobId: job.id,
      workerId: chosen.workerId,
      leaseToken: genId(),
      leaseExpiresAt,
      now,
    });
    transitionJobState(deps.db, job.id, "leased", now);
    claimedWorkerIds.add(chosen.workerId);
    report.jobsAssigned.push({ jobId: job.id, workerId: chosen.workerId });
  }
}

/**
 * Cancels any open job whose issue didn't show up in this pass's candidate scan of any
 * configured workspace. Since Router doesn't write to Jira until stage 4, the only way an
 * open job's issue stops being a `requestStatus`/`planningStatus` candidate is a human moving
 * it elsewhere — i.e. approval revocation (§2 "실행 중 승인 철회... 는 취소 사유"). Needs no
 * extra Jira calls: "not seen this pass" is itself the signal.
 */
function reverifyStaleOpenJobs(
  deps: SchedulerDeps,
  processedIssueKeys: ReadonlySet<string>,
  report: SchedulerReport,
): void {
  const now = deps.now();
  for (const job of getOpenJobs(deps.db)) {
    if (processedIssueKeys.has(job.issueKey)) continue;
    cancelStaleJob(deps.db, job, now, report);
  }
}

/**
 * Stage 2's entry point: re-derives Router's SQLite job/attempt state from the latest Jira
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

  for (const workspace of deps.config.workspaces) {
    const candidates = await findWorkspaceCandidates(deps.jira, workspace);
    for (const issue of candidates) {
      report.candidatesSeen += 1;
      processedIssueKeys.add(issue.key);
      await reconcileIssue(deps, workspace, issue, genId, report);
    }
  }

  reverifyStaleOpenJobs(deps, processedIssueKeys, report);
  assignQueuedJobs(deps, availableWorkers, report);
  return report;
}
