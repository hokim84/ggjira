import type Database from "better-sqlite3";
import { type IssueRequirements, readIssueRequirements } from "../agent/requirements.js";
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
import { computeApprovalId, computeInputHash } from "./approval.js";
import type { RouterConfig, WorkspaceConfig } from "./config.js";
import { getApproval, upsertApproval } from "./db/approvals.js";
import type { JobRow } from "./db/jobs.js";

/** An issue's approval as Jira shows it right now. */
export interface IssueApproval {
  issue: JiraIssue;
  requirements: IssueRequirements;
  planTask: PlanTaskMetadata | null;
  approvalId: string;
  inputHash: string;
}

/** Which status's changelog entry identifies the approval. A planning request is approved by
 *  entering `planningStatus`, an implementation request by entering `requestStatus` — so moving
 *  an issue between the two is itself a new approval. */
export function approvalStatusFor(kind: JobKind, workspace: WorkspaceConfig): string {
  const { planningStatus, requestStatus } = workspace.workflow;
  return kind === "planning" && planningStatus ? planningStatus : requestStatus;
}

export function kindForStatus(statusName: string, workspace: WorkspaceConfig): JobKind {
  return statusName === workspace.workflow.planningStatus ? "planning" : "implementation";
}

/** Reads requirements, plan-task metadata and changelog for `issue`. Throws `PlanMetadataError`
 *  for a corrupted `ggjira.plan-task` property, or for a plan task whose parent has since been
 *  replanned (§2 "계획 버전 변경은 취소 사유다") — callers treat both as "not approved". */
export async function readIssueApproval(
  jira: JiraGateway,
  issue: JiraIssue,
  kind: JobKind,
  workspace: WorkspaceConfig,
): Promise<IssueApproval> {
  const planTask = await readPlanTaskMetadata(jira, issue.key);
  if (planTask) await assertPlanTaskCurrent(jira, issue.key, planTask);
  const requirements = readIssueRequirements(issue);
  const approvalId = await computeApprovalId(jira, issue, approvalStatusFor(kind, workspace));
  const inputHash = computeInputHash(requirements, planTask);
  return { issue, requirements, planTask, approvalId, inputHash };
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
  | { verdict: "revoked"; reason: string };

/** Statuses an issue may sit in while its job is still approved: the request status for its
 *  kind, or `inProgressStatus` (where Router itself moves it on `start`). */
function allowedStatuses(job: JobRow, workspace: WorkspaceConfig): string[] {
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

  let approval: IssueApproval;
  try {
    approval = await readIssueApproval(jira, issue, job.kind, workspace);
  } catch (error) {
    // Corrupted plan metadata fails closed, exactly as it blocks a new dispatch.
    if (error instanceof PlanMetadataError) return { verdict: "revoked", reason: error.message };
    throw error;
  }
  if (approval.approvalId !== job.approvalId) {
    return { verdict: "revoked", reason: `${issue.key} was re-approved` };
  }
  if (job.inputHash !== null && approval.inputHash !== job.inputHash) {
    return { verdict: "revoked", reason: `${issue.key}'s inputs changed` };
  }
  return { verdict: "current", approval };
}
