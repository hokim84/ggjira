import type Database from "better-sqlite3";
import { type IssueRequirements, readIssueRequirements } from "../issue/requirements.js";
import type { IssueSnapshot, PlanningContext } from "../contracts/envelope.js";
import type { JobKind } from "../contracts/protocol.js";
import { JiraApiError } from "../jira/client.js";
import type { JiraGateway } from "../jira/gateway.js";
import type { JiraComment, JiraIssue } from "../jira/types.js";
import { findHumanDecision } from "../pm/context.js";
import {
  PLAN_PROPERTY_KEY,
  PlanMetadataError,
  PlanMetadataSchema,
  type PlanTaskMetadata,
  readPlanTaskMetadata,
} from "../pm/metadata.js";
import {
  computeApprovalId,
  computeDelegationApprovalIds,
  computeInputHash,
  computeLegacyInputHash,
  inputHashMatches,
} from "./approval.js";
import type { RouterConfig, WorkspaceConfig } from "./config.js";
import {
  approvalStatusFor,
  hasOptIn,
  isDelegationMode,
  isLabelMode,
  optInLabelOf,
  resolveJobKind,
} from "./workflow-mode.js";
import { type ApprovalRow, getApproval, upsertApproval } from "./db/approvals.js";
import type { JobRow } from "./db/jobs.js";
import { getActivePlanDeployment } from "./db/plan-delegation.js";
import { taskApprovalId } from "./report-journal.js";

/** An issue's approval as Jira shows it right now. */
export interface IssueApproval {
  issue: JiraIssue;
  /** The job this request is for (src/router/workflow-mode.ts `resolveJobKind`). */
  kind: JobKind;
  requirements: IssueRequirements;
  planTask: PlanTaskMetadata | null;
  approvalId: string;
  /** v2 (ADR 0035): what new jobs are stamped with. */
  inputHash: string;
  /** v1 hash of the same inputs, only for comparing jobs stamped before ADR 0035. */
  legacyInputHash: string;
}

/** Reads requirements, plan-task metadata and changelog for `issue`, and decides which job the
 *  request is for unless `kind` is given (an open job keeps the kind it was created with). Throws
 *  `PlanMetadataError` for a corrupted `ggjira.plan-task` property, or for a plan task whose parent
 *  has since been replanned (§2 "계획 버전 변경은 취소 사유다") — callers treat both as "not
 *  approved". */
export async function readIssueApproval(
  jira: JiraGateway,
  issue: JiraIssue,
  workspace: WorkspaceConfig,
  kind?: JobKind,
  /** Required in `delegation` mode, where approved plans are Router's own records (ADR 0044). */
  db?: Database.Database,
): Promise<IssueApproval> {
  const planTask = await readPlanTaskMetadata(jira, issue.key);
  if (planTask) await assertPlanTaskCurrent(jira, issue.key, planTask);
  const requirements = readIssueRequirements(issue);
  if (isDelegationMode(workspace)) {
    if (!db) throw new Error("readIssueApproval needs the Router DB in delegation mode");
    const delegated = await readDelegatedApproval(jira, db, issue, workspace, planTask, kind);
    return {
      issue,
      requirements,
      planTask,
      ...delegated,
      inputHash: computeInputHash({ kind: delegated.kind, issue, requirements, planTask }),
      legacyInputHash: computeLegacyInputHash(requirements, planTask),
    };
  }
  const resolvedKind =
    kind ??
    resolveJobKind({
      workspace,
      issue,
      requirements,
      planTask,
      parentPlanHasTasks:
        isLabelMode(workspace) && !planTask && !issue.isSubtask
          ? await hasPlanTasks(jira, issue.key)
          : false,
    });
  const approvalId = await computeApprovalId(
    jira,
    issue,
    approvalStatusFor(resolvedKind, workspace),
    optInLabelOf(workspace),
  );
  const inputHash = computeInputHash({ kind: resolvedKind, issue, requirements, planTask });
  const legacyInputHash = computeLegacyInputHash(requirements, planTask);
  return {
    issue,
    kind: resolvedKind,
    requirements,
    planTask,
    approvalId,
    inputHash,
    legacyInputHash,
  };
}

/** A `delegation`-mode issue is not delegated to AI right now (ADR 0044): not requested, or in
 *  progress without an approved plan it runs under. Callers treat it as "not approved". */
export class NotDelegatedError extends Error {}

/**
 * Which job a `delegation`-mode issue is approved for, if any (ADR 0044):
 *
 * - in the request status: a plan, approved by the entry into it;
 * - a task of a deployed plan, in progress: its implementation, approved by the plan's approval
 *   and identified per run by the task's entry into in progress;
 * - a parent whose deployed plan has no tasks, in progress under that same approval: its own
 *   implementation.
 *
 * Anything else — an issue a human works on in progress, a plan nobody approved, a task of a
 * withdrawn or replaced plan — throws `NotDelegatedError`. `kind` (an open job's) must match.
 */
async function readDelegatedApproval(
  jira: JiraGateway,
  db: Database.Database,
  issue: JiraIssue,
  workspace: WorkspaceConfig,
  planTask: PlanTaskMetadata | null,
  kind: JobKind | undefined,
): Promise<{ kind: JobKind; approvalId: string }> {
  const { requestStatus, inProgressStatus, planReviewStatus } = workspace.workflow;
  if (issue.statusName === requestStatus) {
    if (kind === "implementation") {
      throw new NotDelegatedError(`${issue.key} was requested again, to be planned`);
    }
    return { kind: "planning", approvalId: await computeApprovalId(jira, issue, requestStatus) };
  }
  if (kind === "planning") {
    throw new NotDelegatedError(`${issue.key} left "${requestStatus}"`);
  }
  if (issue.statusName !== inProgressStatus) {
    throw new NotDelegatedError(`${issue.key} is in "${issue.statusName}"`);
  }
  // A task delegated on its own (planned and approved itself) runs under its own plan.
  const own = getActivePlanDeployment(db, issue.key);
  if (planTask && !own) {
    const deployment = getActivePlanDeployment(db, planTask.parentKey);
    if (
      !deployment ||
      deployment.planVersion !== planTask.planVersion ||
      !deployment.taskIds.includes(planTask.taskId)
    ) {
      throw new NotDelegatedError(
        `${issue.key}'s plan ${planTask.planVersion} is not approved (or no longer is)`,
      );
    }
    const parent = await jira.getIssue(planTask.parentKey);
    if (parent.statusName !== inProgressStatus) {
      throw new NotDelegatedError(
        `${issue.key}'s parent ${parent.key} left "${inProgressStatus}", withdrawing the plan`,
      );
    }
    const entry = await computeApprovalId(jira, issue, inProgressStatus);
    return {
      kind: "implementation",
      approvalId: taskApprovalId(deployment.approvalId, planTask.taskId, entry),
    };
  }
  const deployment = own;
  if (!deployment || deployment.taskIds.length > 0) {
    throw new NotDelegatedError(
      deployment
        ? `${issue.key} coordinates the tasks of its approved plan; it is not implemented itself`
        : `${issue.key} has no approved plan`,
    );
  }
  const { planApprovalId } = await computeDelegationApprovalIds(jira, issue, {
    requestStatus,
    planReviewStatus: planReviewStatus ?? "",
    inProgressStatus,
  });
  if (planApprovalId !== deployment.approvalId) {
    throw new NotDelegatedError(`${issue.key}'s plan approval changed`);
  }
  return { kind: "implementation", approvalId: deployment.approvalId };
}

/** Whether the issue is the parent of a GGJIRA plan that split it into tasks. */
async function hasPlanTasks(jira: JiraGateway, issueKey: string): Promise<boolean> {
  const plan = PlanMetadataSchema.safeParse(
    await jira.getIssueProperty(issueKey, PLAN_PROPERTY_KEY),
  );
  return plan.success && plan.data.taskIds.length > 0;
}

/** A plan task is runnable only under its parent's current plan version (the v4 runtime's check,
 *  src/agent/runtime.ts, carried over to Router). */
async function assertPlanTaskCurrent(
  jira: JiraGateway,
  issueKey: string,
  planTask: PlanTaskMetadata,
): Promise<void> {
  const parentPlan = PlanMetadataSchema.safeParse(
    await jira.getIssueProperty(planTask.parentKey, PLAN_PROPERTY_KEY),
  );
  if (!parentPlan.success || parentPlan.data.version !== planTask.planVersion) {
    throw new PlanMetadataError(
      `${issueKey} belongs to plan version ${planTask.planVersion}, but its parent ${planTask.parentKey}'s current plan is ${parentPlan.success ? parentPlan.data.version : "missing"}`,
    );
  }
}

export function toIssueSnapshot(issue: JiraIssue): IssueSnapshot {
  return {
    key: issue.key,
    id: issue.id,
    summary: issue.summary,
    description: issue.description,
    statusName: issue.statusName,
    labels: issue.labels,
    assigneeAccountId: issue.assigneeAccountId,
    issueTypeName: issue.issueTypeName,
    parentKey: issue.parentKey,
    projectKey: issue.projectKey,
  };
}

/**
 * What a planning worker needs to know about the issue beyond its own fields (§4 "PM context
 * 수집·계획 적용 → Router로 이동"): comments, existing subtasks, the current plan version, and the
 * human's reply to Router's last decision request. Comment authorship is judged against Router's
 * own Jira account, which only Router knows.
 */
export async function collectPlanningContext(
  jira: JiraGateway,
  issue: JiraIssue,
  routerAccountId: string,
): Promise<PlanningContext> {
  const [comments, subtasks, planProperty] = await Promise.all([
    jira.getComments(issue.key),
    jira.searchIssues(`parent = "${issue.key}"`, { all: true }),
    jira.getIssueProperty(issue.key, PLAN_PROPERTY_KEY),
  ]);
  const plan = PlanMetadataSchema.safeParse(planProperty);
  const humanDecision = findHumanDecision(comments, routerAccountId, issue.assigneeAccountId);
  return {
    ...(plan.success ? { planVersion: plan.data.version } : {}),
    comments: comments.map((comment: JiraComment) => ({
      id: comment.id,
      authorDisplayName: comment.authorDisplayName,
      body: comment.body,
      created: comment.created,
    })),
    existingSubtasks: subtasks.map(toIssueSnapshot),
    ...(humanDecision ? { humanDecision } : {}),
  };
}

/** The shape `upsertApproval` stores as `input_snapshot`; `buildJobEnvelope` reads it back. */
export interface ApprovalSnapshot {
  issue: IssueSnapshot;
  requirements: IssueRequirements;
  planTask: PlanTaskMetadata | null;
  planning?: PlanningContext;
  /** The v1 hash of these inputs (ADR 0035), so Worker API checks can still judge a job stamped
   *  before the switch without re-reading Jira. Absent from snapshots stored before it. */
  legacyInputHash?: string;
}

/** A stored approval's hashes in the shape `inputHashMatches` takes — for the Worker API checks,
 *  which judge a job from Router's DB without asking Jira. */
export function storedApprovalHashes(row: ApprovalRow): {
  inputHash: string;
  legacyInputHash?: string;
} {
  const legacy = (row.inputSnapshot as Partial<ApprovalSnapshot> | null)?.legacyInputHash;
  return {
    inputHash: row.inputHash,
    ...(typeof legacy === "string" ? { legacyInputHash: legacy } : {}),
  };
}

/**
 * Stores the latest approval for an issue. A snapshot taken without planning context (the
 * active-job check, which runs every few seconds) keeps the planning context an earlier
 * reconcile collected, so a planning job's envelope never loses it.
 */
export function storeApproval(
  db: Database.Database,
  approval: IssueApproval,
  now: string,
  planning?: PlanningContext,
): void {
  const previous = getApproval(db, approval.issue.key)?.inputSnapshot as
    | Partial<ApprovalSnapshot>
    | undefined;
  const keptPlanning = planning ?? previous?.planning;
  const snapshot: ApprovalSnapshot = {
    issue: toIssueSnapshot(approval.issue),
    requirements: approval.requirements,
    planTask: approval.planTask,
    ...(keptPlanning ? { planning: keptPlanning } : {}),
    legacyInputHash: approval.legacyInputHash,
  };
  upsertApproval(db, {
    issueKey: approval.issue.key,
    approvalId: approval.approvalId,
    inputHash: approval.inputHash,
    inputSnapshot: snapshot,
    now,
  });
}

export type JobCheck =
  | { verdict: "current"; approval: IssueApproval }
  | {
      verdict: "revoked";
      reason: string;
      /** The approval itself stands but what it approved was edited (ADR 0035): the issue must
       *  not run again under this approval id. */
      inputsChanged?: boolean;
    };

/** Statuses an issue may sit in while its job is still approved: the request status for its
 *  kind, or `inProgressStatus` (where Router itself moves it on `start`). */
function allowedStatuses(job: JobRow, workspace: WorkspaceConfig): string[] {
  // ADR 0044: a delegated run never moves the issue on start, so it may only be where it runs.
  if (isDelegationMode(workspace)) return [approvalStatusFor(job.kind, workspace)];
  return [approvalStatusFor(job.kind, workspace), workspace.workflow.inProgressStatus];
}

/**
 * Re-reads an open job's issue from Jira and decides whether its approval still stands
 * (§2 "실행 중 승인 철회, 책임자 제거, 실행 대상 변경, 계획 버전 변경은 취소 사유다 / 실행 중 작업
 * 설명·요구 capability·의존성 변경도 취소하고 새 승인을 요구한다"). Comments are not part of the
 * input hash, so Router's own report comments never revoke anything.
 *
 * Throws on a transient Jira failure: the caller must not treat "couldn't ask" as "revoked".
 */
export async function checkJobAgainstJira(
  jira: JiraGateway,
  config: RouterConfig,
  job: JobRow,
  /** Required for a `delegation`-mode workspace (see `readIssueApproval`). */
  db?: Database.Database,
): Promise<JobCheck> {
  const workspace = config.workspaces.find((entry) => entry.id === job.workspaceId);
  if (!workspace) return { verdict: "revoked", reason: `workspace ${job.workspaceId} is gone` };

  let issue: JiraIssue;
  try {
    issue = await jira.getIssue(job.issueKey);
  } catch (error) {
    if (error instanceof JiraApiError && error.status === 404) {
      return { verdict: "revoked", reason: `${job.issueKey} no longer exists` };
    }
    throw error;
  }

  if (!allowedStatuses(job, workspace).includes(issue.statusName)) {
    return { verdict: "revoked", reason: `${issue.key} moved to "${issue.statusName}"` };
  }
  if (!issue.assigneeAccountId) {
    return { verdict: "revoked", reason: `${issue.key} lost its human assignee` };
  }
  if (!hasOptIn(issue, workspace)) {
    return { verdict: "revoked", reason: `${issue.key} no longer carries the opt-in label` };
  }

  let approval: IssueApproval;
  try {
    approval = await readIssueApproval(jira, issue, workspace, job.kind, db);
  } catch (error) {
    // Corrupted plan metadata fails closed, exactly as it blocks a new dispatch; so does a
    // delegated plan that was withdrawn or replaced.
    if (error instanceof PlanMetadataError || error instanceof NotDelegatedError) {
      return { verdict: "revoked", reason: error.message };
    }
    throw error;
  }
  if (approval.approvalId !== job.approvalId) {
    return { verdict: "revoked", reason: `${issue.key} was re-approved` };
  }
  if (!inputHashMatches(job.inputHash, approval)) {
    return { verdict: "revoked", reason: `${issue.key}'s inputs changed`, inputsChanged: true };
  }
  return { verdict: "current", approval };
}
