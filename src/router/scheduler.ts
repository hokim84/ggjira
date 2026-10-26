import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { canTransitionAttemptState } from "../contracts/attempt-state.js";
import { isRouteDispatch } from "../contracts/route.js";
import type { JiraGateway } from "../jira/gateway.js";
import type { JiraIssue } from "../jira/types.js";
import { PlanMetadataError } from "../pm/metadata.js";
import { inputHashMatches } from "./approval.js";
import { SETTLED_BY_NEW_APPROVAL } from "./attention.js";
import { findWorkspaceCandidates } from "./candidates.js";
import { COMMENT_TEXT } from "./comment-text.js";
import type { RouterConfig, WorkspaceConfig } from "./config.js";
import { getApproval } from "./db/approvals.js";
import {
  getActiveAttemptForWorker,
  getAttempt,
  leaseAttempt,
  transitionAttemptState,
} from "./db/attempts.js";
import { listAttentionItems, recordAttention, resolveAttention } from "./db/attention.js";
import { INPUTS_CHANGED_HOLD_ACTOR, getApprovalHoldActor, recordAdminHold } from "./db/holds.js";
import {
  type JobRow,
  createJob,
  getActiveJobs,
  getOpenJobForIssue,
  getOpenJobs,
  getQueuedJobs,
  hasSucceededJobForApproval,
  transitionJobState,
} from "./db/jobs.js";
import { getActivePlanDeployment, getPlanReview } from "./db/plan-delegation.js";
import { listProviderUsage } from "./db/provider-usage.js";
import { isLatestReviewConfirmed } from "./db/review-targets.js";
import { markWorkerAssigned } from "./db/workers.js";
import type { DecisionProvider, RouteContext } from "./decision.js";
import { reconcileDelegatedPlans } from "./delegation.js";
import type { ApprovalSnapshot } from "./issue-check.js";
import {
  type IssueApproval,
  NotDelegatedError,
  checkJobAgainstJira,
  collectPlanningContext,
  readIssueApproval,
  storeApproval,
} from "./issue-check.js";
import { integrationEvidence } from "./lifecycle.js";
import { publishedImplementation } from "./assembly.js";
import { syncPlanningRequest } from "./planning-requests.js";
import { insertReportBatch } from "./db/report-steps.js";
import { buildUncertainRunSteps, uncertainRunBatchId } from "./report-journal.js";
import { pressureRank, usagePressure } from "./usage-routing.js";
import {
  checkContext,
  checkSource,
  latestImplementation,
  verifiedNoChange,
} from "./workflow-checks.js";
import { isDependencyResolved, reRequestHint } from "./workflow-mode.js";

/** How long a lease is valid before Router considers it expired
 *  (docs/router-service-implementation-plan.md §3 "임대: 30초"). Stage 3/4 own renewal. */
export const LEASE_DURATION_MS = 30_000;

export interface WorkerAvailability {
  workerId: string;
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

/** A dependency is unresolved until it is done, or a human confirmed its result (ADR 0044,
 *  src/router/workflow-mode.ts `isDependencyResolved`). */
async function resolveUnresolvedDependencies(
  jira: JiraGateway,
  db: Database.Database,
  workspace: WorkspaceConfig,
  dependencyKeys: readonly string[],
): Promise<string[]> {
  const unresolved: string[] = [];
  for (const key of dependencyKeys) {
    const dependency = await jira.getIssue(key);
    const confirmed = isLatestReviewConfirmed(db, key);
    if (!isDependencyResolved(workspace, dependency.statusName, confirmed)) unresolved.push(key);
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
  const liveParent = getActivePlanDeployment(deps.db, issue.key);
  if (liveParent) {
    const parentReview = getPlanReview(deps.db, liveParent.planReviewId);
    if (
      parentReview &&
      [workspace.workflow.requestStatus, workspace.workflow.planningInProgressStatus].includes(
        issue.statusName,
      )
    ) {
      const request = await syncPlanningRequest(
        deps.db,
        deps.jira,
        issue,
        workspace.workflow.requestStatus,
        deps.now(),
        workspace.workflow.planningInProgressStatus,
      );
      if (request?.id === parentReview.requestApprovalId) return;
    }
  }
  let approval: IssueApproval;
  try {
    const running = getOpenJobForIssue(deps.db, issue.key);
    approval = await readIssueApproval(
      deps.jira,
      deps.db,
      issue,
      workspace,
      running?.kind === "implementation" && running.state === "running"
        ? "implementation"
        : undefined,
      deps.now(),
      deps.config.repositories.find((r) => r.id === workspace.repositoryId)?.baseBranch ?? "main",
    );
  } catch (error) {
    if (error instanceof PlanMetadataError || error instanceof NotDelegatedError) {
      report.skipped.push({ issueKey: issue.key, reason: error.message });
      // Corrupted or superseded plan metadata withdraws the approval an open job relied on, and so
      // does a plan that was withdrawn or replaced (ADR 0044).
      const openJob = getOpenJobForIssue(deps.db, issue.key);
      if (openJob && VERIFIED_JOB_STATES.has(openJob.state)) {
        cancelStaleJob(deps.db, openJob, deps.now(), report);
      }
      return;
    }
    throw error;
  }
  const { kind, requirements, planTask, approvalId, inputHash } = approval;
  if (approval.assembly)
    approval.assembly.baseBranch =
      deps.config.repositories.find((r) => r.id === workspace.repositoryId)?.baseBranch ?? "main";
  const quality =
    kind === "quality_review" || kind === "integration_check"
      ? await checkContext(
          deps.db,
          deps.jira,
          deps.config,
          workspace,
          issue,
          kind === "quality_review",
        )
      : undefined;
  if ((kind === "quality_review" || kind === "integration_check") && !quality) {
    report.held.push({
      issueKey: issue.key,
      target: "human",
      reason: "현재 결과의 PR 머지·통합 증거 또는 모든 자식의 완료를 기다립니다.",
    });
    return;
  }

  const dependencyKeys = extractDependencyKeys(requirements.dependencies);
  const unresolvedDependencies = await resolveUnresolvedDependencies(
    deps.jira,
    deps.db,
    workspace,
    dependencyKeys,
  );
  let integration: ApprovalSnapshot["integration"];
  const groupParentKey = planTask?.parentKey ?? issue.parentKey;
  if (groupParentKey && kind === "implementation") {
    const parent = getActivePlanDeployment(deps.db, groupParentKey);
    const review = parent && getPlanReview(deps.db, parent.planReviewId);
    if (review) {
      const baseBranch =
        deps.config.repositories.find((repo) => repo.id === workspace.repositoryId)?.baseBranch ??
        "main";
      const evidence = dependencyKeys.map((key) => integrationEvidence(deps.db, key, baseBranch));
      const resultCommits: string[] = [];
      for (const [index, key] of dependencyKeys.entries()) {
        const latest = latestImplementation(deps.db, key);
        const noChange = latest && verifiedNoChange(JSON.parse(latest.payload));
        const result = await publishedImplementation(deps.db, deps.jira, workspace, key);
        const published =
          result?.git?.headSha && result?.artifacts?.some((a: string) => a.startsWith("pushed:"));
        if (!evidence[index] && published && result?.git?.headSha)
          resultCommits.push(result.git.headSha);
        if (!evidence[index] && !noChange && !published && !unresolvedDependencies.includes(key))
          unresolvedDependencies.push(key);
      }
      const previous = latestImplementation(deps.db, issue.key);
      const priorResult = previous ? JSON.parse(previous.payload) : null;
      if (
        !integrationEvidence(deps.db, issue.key, baseBranch) &&
        priorResult?.git?.headSha &&
        priorResult?.artifacts?.some((a: string) => a.startsWith("pushed:"))
      )
        resultCommits.push(priorResult.git.headSha);
      const aggregate = deps.db
        .prepare(
          "SELECT t.head_sha FROM pull_requests p JOIN review_targets t ON t.attempt_id=p.attempt_id WHERE p.issue_key=? AND p.state='open' AND t.superseded_by IS NULL ORDER BY p.updated_at DESC LIMIT 1",
        )
        .get(groupParentKey) as { head_sha: string } | undefined;
      if (aggregate?.head_sha) resultCommits.push(aggregate.head_sha);
      integration = {
        parentKey: groupParentKey,
        baseBranch,
        mergeCommits: evidence.flatMap((item) => (item ? [item.mergeSha] : [])),
        resultCommits,
      };
    }
  }
  // A planning job's envelope carries comments/subtasks/decision reply; collected here, outside
  // any DB transaction, so `jobs/next` can build the envelope from SQLite alone.
  const planning =
    kind === "planning"
      ? await collectPlanningContext(deps.jira, issue, await routerAccountId(), deps.db)
      : undefined;
  const now = deps.now();
  storeApproval(deps.db, approval, now, planning);
  if (quality) {
    const stored = getApproval(deps.db, issue.key);
    deps.db
      .prepare("UPDATE approvals SET input_snapshot=? WHERE issue_key=?")
      .run(JSON.stringify({ ...(stored?.inputSnapshot as ApprovalSnapshot), quality }), issue.key);
  }
  if (integration) {
    const stored = getApproval(deps.db, issue.key);
    if (stored)
      deps.db
        .prepare("UPDATE approvals SET input_snapshot=? WHERE issue_key=?")
        .run(
          JSON.stringify({ ...(stored.inputSnapshot as ApprovalSnapshot), integration }),
          issue.key,
        );
  }

  const existingJob = getOpenJobForIssue(deps.db, issue.key);
  if (existingJob) {
    const inputsChanged =
      existingJob.approvalId === approvalId &&
      !inputHashMatches(existingJob.inputHash, approval.inputHash);
    const approvalCurrent =
      existingJob.approvalId === approvalId && !inputsChanged && issue.assigneeAccountId !== null;
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
    if (inputsChanged) holdChangedApproval(deps.db, existingJob, now);
    const slotFreed = cancelStaleJob(deps.db, existingJob, now, report);
    if (!slotFreed) return;
  }

  const holdActor = getApprovalHoldActor(deps.db, issue.key, approvalId);
  if (holdActor) {
    // An admin cancelled the job for this very approval (`ggjira router jobs cancel`), or what it
    // approved was edited (ADR 0035); only a fresh request in Jira (a new approval id) runs it again.
    report.held.push({
      issueKey: issue.key,
      target: "human",
      reason:
        holdActor === INPUTS_CHANGED_HOLD_ACTOR
          ? `the request was edited after it was approved; ${reRequestHint(workspace, kind)} to run the edited request`
          : `cancelled by an admin for this approval; ${reRequestHint(workspace, kind)} to re-run`,
    });
    return;
  }

  // ADR 0044: one request, one run. A request still showing after its run finished (its report
  // move not applied yet, or skipped) is not a new one.
  if (hasSucceededJobForApproval(deps.db, issue.key, approvalId)) {
    report.skipped.push({
      issueKey: issue.key,
      reason: `${issue.key} already ran under approval ${approvalId}`,
    });
    return;
  }

  const context: RouteContext = {
    issue,
    kind,
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
      now,
    });
    report.jobsCreated.push(job.id);
    if (approval.assembly)
      deps.db
        .prepare("INSERT INTO assembly_runs VALUES (?,?,?,?)")
        .run(job.id, issue.key, approval.assembly.cycleId, JSON.stringify(approval.assembly));
    deps.db
      .prepare("INSERT INTO job_inputs VALUES (?,?)")
      .run(job.id, JSON.stringify(getApproval(deps.db, issue.key)?.inputSnapshot));
    if (quality)
      deps.db
        .prepare(
          "INSERT INTO workflow_checks (job_id,issue_key,source_key,context) VALUES (?,?,?,?)",
        )
        .run(job.id, issue.key, checkSource(quality), JSON.stringify(quality));
    settleOnNewApproval(deps.db, issue.key, approvalId, now);
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
      now,
    });
    report.jobsCreated.push(job.id);
    settleOnNewApproval(deps.db, issue.key, approvalId, now);
    return;
  }

  if (decision.target === "human" && !issue.assigneeAccountId) {
    await holdUnassigned(deps, issue, approvalId, decision.reason, report);
    return;
  }
  report.held.push({ issueKey: issue.key, target: decision.target, reason: decision.reason });
}

/**
 * A request nobody is responsible for does not run (rule 1 of `RuleDecisionProvider`). Without a
 * word on the issue it would only sit in the request status, so the human is told once per
 * request, on the issue, and an attention item stays open until the issue runs. A comment that
 * fails is tried again on the next pass.
 */
async function holdUnassigned(
  deps: SchedulerDeps,
  issue: JiraIssue,
  approvalId: string,
  reason: string,
  report: SchedulerReport,
): Promise<void> {
  const told = listAttentionItems(deps.db, {
    status: "open",
    issueKey: issue.key,
    kind: "unassigned",
  }).some((item) => item.approvalId === approvalId);
  if (!told) {
    const marker = `[GGJIRA:UNASSIGNED:${approvalId}]`;
    const text = COMMENT_TEXT[deps.config.reporting.language].unassigned;
    try {
      const comments = await deps.jira.getComments(issue.key);
      if (!comments.some((comment) => comment.body.includes(marker))) {
        await deps.jira.addComment(
          issue.key,
          [marker, text.title, text.impact, text.next(issue.statusName)].join("\n"),
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.held.push({
        issueKey: issue.key,
        target: "human",
        reason: `${reason}; telling it on the issue failed (${message}), tried again next pass`,
      });
      return;
    }
    recordAttention(deps.db, {
      issueKey: issue.key,
      approvalId,
      kind: "unassigned",
      cause: "no human assignee",
      severity: "immediate",
      reason: "the issue was handed to GGJIRA without an assignee; nothing runs until it has one",
      evidence: { statusName: issue.statusName },
      now: deps.now(),
    });
  }
  report.held.push({ issueKey: issue.key, target: "human", reason });
}

/** M4-09: a fresh approval of the issue settles what earlier runs left for a human. Bookkeeping
 *  only — the approval itself, not the resolution, is what lets the new job run. */
function settleOnNewApproval(
  db: Database.Database,
  issueKey: string,
  approvalId: string,
  now: string,
): void {
  resolveAttention(db, {
    issueKey,
    kinds: SETTLED_BY_NEW_APPROVAL,
    resolution: `approved again (${approvalId})`,
    exceptApprovalId: approvalId,
    now,
  });
  resolveAttention(db, {
    issueKey,
    kinds: ["unassigned"],
    resolution: `assigned; the request runs (${approvalId})`,
    now,
  });
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
 * Leases `queued` jobs (oldest first) to matching workers. Each lease also stamps that worker's
 * `last_assigned_at` (a no-op for workers not registered in the `workers` table), which is what
 * `buildWorkerAvailability` feeds back as `lastAssignedAt` for the next pass's fairness order.
 *
 * Reported LLM plan usage (ADR 0029): a worker whose provider is at its limit is skipped until the
 * window resets, and one near its limit sorts after every worker that is not.
 *
 * With `requesterId` (`jobs/next`) only that worker can be leased a job; the others in
 * `availableWorkers` are there so it can step aside when an idle, matching worker has more
 * headroom — that one takes the job on its own next poll.
 */
export function assignQueuedJobs(
  deps: AssignDeps,
  availableWorkers: WorkerAvailability[],
  report?: SchedulerReport,
  options: { requesterId?: string } = {},
): Assignment[] {
  const genId = deps.genId ?? randomUUID;
  const claimedWorkerIds = new Set<string>();
  const assignments: Assignment[] = [];
  const usagePolicy = deps.config.scheduling.usage;
  const usageByWorker = listProviderUsage(deps.db);
  const now = deps.now();
  const pressureOf = new Map(
    availableWorkers.map((worker) => {
      const policy = deps.config.workers.find((w) => w.workerId === worker.workerId);
      const usage = usageByWorker
        .get(worker.workerId)
        ?.find((entry) => entry.providerId === policy?.providerId);
      return [worker.workerId, usagePressure(usage, now, usagePolicy.deprioritizeAtPercent)];
    }),
  );
  const rank = (workerId: string) => pressureRank(pressureOf.get(workerId) ?? "ok");

  for (const job of getQueuedJobs(deps.db)) {
    const candidates = availableWorkers
      .filter((worker) => !claimedWorkerIds.has(worker.workerId))
      .filter((worker) => {
        const policy = deps.config.workers.find((w) => w.workerId === worker.workerId);
        if (!policy || !policy.enabled) return false;
        if (!policy.allowedRepositoryIds.includes(job.repositoryId)) return false;
        if (!worker.repositoryIds.includes(job.repositoryId)) return false;
        if (job.pinnedWorkerId && job.pinnedWorkerId !== worker.workerId) return false;
        if (usagePolicy.skipExhausted && pressureOf.get(worker.workerId) === "exhausted") {
          return false;
        }
        return !getActiveAttemptForWorker(deps.db, worker.workerId);
      })
      .sort((a, b) => {
        const byPressure = rank(a.workerId) - rank(b.workerId);
        if (byPressure !== 0) return byPressure;
        const aTime = a.lastAssignedAt ?? "";
        const bTime = b.lastAssignedAt ?? "";
        return aTime !== bTime ? aTime.localeCompare(bTime) : a.workerId.localeCompare(b.workerId);
      });

    let chosen = candidates[0];
    if (options.requesterId) {
      // Only usage headroom makes the requester step aside, not fairness order: it is the one
      // asking right now, and handing it the job is what keeps latency low.
      const requester = candidates.find((worker) => worker.workerId === options.requesterId);
      if (!requester) continue;
      if (chosen && rank(chosen.workerId) < rank(requester.workerId)) {
        claimedWorkerIds.add(chosen.workerId);
        continue;
      }
      chosen = requester;
    }
    if (!chosen) continue;

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
    check = await checkJobAgainstJira(deps.jira, deps.config, job, deps.db);
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
  if (check.inputsChanged) holdChangedApproval(deps.db, job, now);
  cancelStaleJob(deps.db, job, now, report);
}

/**
 * ADR 0035: an approval approves specific inputs. Once they are edited under an open job, the
 * job is cancelled and this approval is held, so the next pass does not quietly start the edited
 * request under the old approval — a human moves the issue to the request status again.
 */
function holdChangedApproval(db: Database.Database, job: JobRow, now: string): void {
  recordAdminHold(db, {
    issueKey: job.issueKey,
    approvalId: job.approvalId,
    jobId: job.id,
    actor: INPUTS_CHANGED_HOLD_ACTOR,
    now,
  });
}

/** ADR 0062: a run left `recovery_required` is announced in Jira once per attempt, so the assignee
 *  learns it waits for them ("재시도") without the Router UI. */
function noteUncertainRuns(deps: SchedulerDeps): void {
  for (const job of getOpenJobs(deps.db)) {
    if (job.state !== "recovery_required" || !job.currentAttemptId) continue;
    if (!deps.config.workspaces.some((workspace) => workspace.id === job.workspaceId)) continue;
    insertReportBatch(deps.db, {
      batchId: uncertainRunBatchId(job.currentAttemptId),
      jobId: job.id,
      attemptId: job.currentAttemptId,
      issueKey: job.issueKey,
      steps: buildUncertainRunSteps(deps.config, job, job.currentAttemptId),
      now: deps.now(),
    });
  }
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
    // ADR 0044: approved plans and their tasks come from Router's own records, never from the
    // shared in-progress status.
    await reconcileDelegatedPlans(deps, workspace, report, async (issue) => {
      if (processedIssueKeys.has(issue.key)) return;
      report.candidatesSeen += 1;
      processedIssueKeys.add(issue.key);
      await reconcileIssue(deps, workspace, issue, genId, routerAccountId, report);
    });
  }

  await reverifyUnseenOpenJobs(deps, processedIssueKeys, report);
  noteUncertainRuns(deps);
  assignQueuedJobs(deps, availableWorkers, report);
  return report;
}
