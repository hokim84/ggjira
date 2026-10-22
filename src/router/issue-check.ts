import type Database from "better-sqlite3";
import type { IssueSnapshot, PlanningContext } from "../contracts/envelope.js";
import type { JobKind } from "../contracts/protocol.js";
import type { QualityContext } from "../contracts/quality.js";
import type { IssueRequirements } from "../issue/requirements.js";
import { JiraApiError } from "../jira/client.js";
import type { JiraGateway } from "../jira/gateway.js";
import type { JiraComment, JiraIssue } from "../jira/types.js";
import { findHumanDecision } from "../pm/context.js";
import {
  parentPlanRequirements,
  planTaskRequirements,
  planningRequirements,
} from "../pm/contract.js";
import {
  PLAN_PROPERTY_KEY,
  PlanMetadataError,
  PlanMetadataSchema,
  type PlanTaskMetadata,
  readPlanTaskMetadata,
} from "../pm/metadata.js";
import { planTaskIds, requirementDescription } from "../pm/plan-render.js";
import { computeApprovalId, computeInputHash, inputHashMatches } from "./approval.js";
import type { RouterConfig, WorkspaceConfig } from "./config.js";
import { getApproval, upsertApproval } from "./db/approvals.js";
import type { JobRow } from "./db/jobs.js";
import {
  type PlanDeploymentRow,
  getActivePlanDeployment,
  getLatestPlanReview,
  getPlanReview,
  getReviewedPlan,
  listPlannedReviews,
} from "./db/plan-delegation.js";
import {
  latestPlanningRequest,
  planningDecision,
  planningFingerprint,
  syncPlanningRequest,
} from "./planning-requests.js";
import { taskApprovalId } from "./report-journal.js";
import { checkContext, checkSource, sourceKey } from "./workflow-checks.js";
import { approvalStatusFor } from "./workflow-mode.js";

/** An issue's approval as Jira and Router's plan records show it right now. */
export interface IssueApproval {
  issue: JiraIssue;
  kind: JobKind;
  /** The approved plan's contract for an implementation; none yet for a planning request. */
  requirements: IssueRequirements;
  planTask: PlanTaskMetadata | null;
  approvalId: string;
  /** ADR 0035: what new jobs are stamped with. */
  inputHash: string;
}

/** The issue is not delegated to AI right now (ADR 0044): not requested, or in progress without an
 *  approved plan it runs under. Callers treat it as "not approved". */
export class NotDelegatedError extends Error {}

/**
 * Which job `issue` is approved for, if any (ADR 0044, ADR 0047), and the contract it runs under:
 *
 * - in the request status: a plan, approved by the entry into it, with no contract yet;
 * - a task of a deployed plan, in progress: its implementation under that task of the plan,
 *   approved by the plan's approval and identified per run by the task's entry into in progress;
 * - a parent whose deployed plan has no tasks, in progress under that same approval: its own
 *   implementation under the plan's contract.
 *
 * Anything else — an issue a human works on in progress, a plan nobody approved, a task of a
 * withdrawn or replaced plan — throws `NotDelegatedError`. `kind` (an open job's) must match.
 * Throws `PlanMetadataError` for a corrupted `ggjira.plan-task` property, or for a plan task whose
 * parent has since been replanned (§2 "계획 버전 변경은 취소 사유다").
 */
export async function readIssueApproval(
  jira: JiraGateway,
  db: Database.Database,
  issue: JiraIssue,
  workspace: WorkspaceConfig,
  kind?: JobKind,
  now?: string,
): Promise<IssueApproval> {
  const planTask = await readPlanTaskMetadata(jira, issue.key);
  if (planTask) await assertPlanTaskCurrent(jira, issue.key, planTask);
  const approved = await readApproved(jira, db, issue, workspace, planTask, kind, now);
  return {
    issue,
    planTask,
    ...approved,
    inputHash: computeInputHash({
      kind: approved.kind,
      issue,
      requirements: approved.requirements,
      planTask,
    }),
  };
}

async function readApproved(
  jira: JiraGateway,
  db: Database.Database,
  issue: JiraIssue,
  workspace: WorkspaceConfig,
  planTask: PlanTaskMetadata | null,
  kind: JobKind | undefined,
  now?: string,
): Promise<{ kind: JobKind; approvalId: string; requirements: IssueRequirements }> {
  const { requestStatus, planningInProgressStatus, inProgressStatus, integrationPendingStatus } =
    workspace.workflow;
  if ([requestStatus, planningInProgressStatus].includes(issue.statusName)) {
    if (kind && kind !== "planning") {
      throw new NotDelegatedError(`${issue.key} was requested again, to be planned`);
    }
    if (issue.statusName === planningInProgressStatus && !latestPlanningRequest(db, issue.key))
      throw new NotDelegatedError("move the issue to AI 계획 to request planning first");
    const request = await syncPlanningRequest(
      db,
      jira,
      issue,
      requestStatus,
      now,
      planningInProgressStatus,
    );
    if (!request)
      throw new NotDelegatedError(
        "request changed concurrently or predates upgrade; reconcile again or delegate again after upgrade",
      );
    return {
      kind: "planning",
      approvalId: request.id,
      requirements: planningRequirements(issue.summary),
    };
  }
  if (kind === "planning") {
    throw new NotDelegatedError(`${issue.key} left "${requestStatus}"`);
  }
  if (issue.statusName === integrationPendingStatus) {
    const checkKind = "integration_check";
    if (kind && kind !== checkKind) throw new NotDelegatedError("workflow stage changed");
    const entry = await computeApprovalId(jira, issue, issue.statusName);
    const generation = db
      .prepare(`SELECT j.issue_key,j.id FROM jobs j WHERE j.kind='implementation'
      AND j.rowid=(SELECT MAX(rowid) FROM jobs WHERE issue_key=j.issue_key AND kind='implementation')
      AND (j.issue_key=? OR j.issue_key IN (SELECT issue_key FROM approvals WHERE json_extract(input_snapshot,'$.planTask.parentKey')=? OR json_extract(input_snapshot,'$.issue.parentKey')=?)) ORDER BY j.issue_key`)
      .all(issue.key, issue.key, issue.key);
    return {
      kind: checkKind,
      approvalId: await retryApprovalId(
        db,
        jira,
        issue,
        `${checkKind}:${entry}:source:${sourceKey(generation)}`,
      ),
      requirements: planningRequirements(issue.summary),
    };
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
    const parentReview = getPlanReview(db, deployment.planReviewId);
    if (
      kind !== "implementation" &&
      (latestPlanningRequest(db, parent.key)?.input_hash !== planningFingerprint(parent) ||
        latestPlanningRequest(db, parent.key)?.id !== parentReview?.requestApprovalId)
    ) {
      throw new NotDelegatedError(
        "parent requirements changed; reconcile the plan before starting more work",
      );
    }
    if (
      ![planningInProgressStatus, inProgressStatus, integrationPendingStatus].includes(
        parent.statusName,
      )
    ) {
      throw new NotDelegatedError(
        `${issue.key}'s parent ${parent.key} left "${inProgressStatus}", withdrawing the plan`,
      );
    }
    const entry = await computeApprovalId(jira, issue, inProgressStatus);
    {
      const baseline = db
        .prepare(
          "SELECT entry_id FROM child_approval_baselines WHERE parent_key=? AND plan_version=? AND task_id=?",
        )
        .get(parent.key, planTask.planVersion, planTask.taskId) as { entry_id: string } | undefined;
      if (!baseline || baseline.entry_id === entry)
        throw new NotDelegatedError(
          "move the child into in-progress after its complete contract is published",
        );
    }
    return {
      kind: "implementation",
      approvalId: await retryApprovalId(
        db,
        jira,
        issue,
        taskApprovalId(deployment.approvalId, planTask.taskId, entry),
      ),
      requirements: withLatestReview(db, issue, taskContract(db, issue.key, planTask)),
    };
  }
  const entry = await computeApprovalId(jira, issue, inProgressStatus);
  const automatic = db
    .prepare("SELECT entry_id FROM parent_progress_entries WHERE issue_key=?")
    .get(issue.key) as { entry_id: string } | undefined;
  if (automatic?.entry_id === entry)
    throw new NotDelegatedError("parent coordinates individually approved children");
  if (own?.taskIds.length) {
    const move = (await jira.getIssueChangelog(issue.key)).find((event) => event.id === entry);
    if (
      !move?.items.some(
        (item) =>
          item.field === "status" &&
          [
            workspace.workflow.implementationCompleteStatus,
            workspace.workflow.implementationCompleteStatus,
            workspace.workflow.doneStatus,
          ].includes(item.fromString ?? ""),
      )
    )
      throw new NotDelegatedError(
        "approve each child separately; parent implementation is available for rework after completion or review",
      );
  }
  const latestReview = getLatestPlanReview(db, issue.key);
  const latestRequest = latestPlanningRequest(db, issue.key);
  const publishedPlan =
    latestReview?.outcome === "planned" &&
    !latestReview.taskIds.length &&
    latestRequest?.ready_history &&
    latestReview.requestApprovalId === latestRequest.id &&
    latestRequest.input_hash === planningFingerprint(issue)
      ? getReviewedPlan(db, latestReview.id)
      : undefined;
  const requirements = publishedPlan
    ? parentPlanRequirements(publishedPlan, issue.summary)
    : {
        ...planningRequirements(issue.summary),
        inScope: [issue.summary, requirementDescription(issue.description)],
        acceptanceCriteria: ["Complete the requested work and report verifiable evidence."],
        verification: ["Verify the result against the issue requirements."],
      };
  return {
    kind: "implementation",
    approvalId: await retryApprovalId(db, jira, issue, `implementation:${entry}`),
    requirements: withLatestReview(db, issue, requirements),
  };
}

function withLatestReview(
  db: Database.Database,
  issue: JiraIssue,
  requirements: IssueRequirements,
): IssueRequirements {
  return requirements;
}

/** A retry comment after a settled failure creates a new durable approval, never an automatic replay. */
async function retryApprovalId(
  db: Database.Database,
  jira: JiraGateway,
  issue: JiraIssue,
  base: string,
): Promise<string> {
  const last = db
    .prepare(
      "SELECT approval_id, state, updated_at FROM jobs WHERE issue_key=? AND (approval_id=? OR approval_id LIKE ?) ORDER BY rowid DESC LIMIT 1",
    )
    .get(issue.key, base, `${base}:retry:%`) as
    | { approval_id: string; state: string; updated_at: string }
    | undefined;
  if (!last) return base;
  if (!["failed", "timed_out"].includes(last.state)) return last.approval_id;
  const comments = await jira.getComments(issue.key);
  const reply = comments.find(
    (comment) =>
      comment.authorAccountId === issue.assigneeAccountId &&
      comment.body.trim() === "재시도" &&
      comment.created > last.updated_at &&
      !db
        .prepare("SELECT 1 FROM workflow_retry_comments WHERE issue_key=? AND comment_id=?")
        .get(issue.key, comment.id),
  );
  if (!reply) return last.approval_id;
  db.prepare("INSERT OR IGNORE INTO workflow_retry_comments VALUES (?,?)").run(issue.key, reply.id);
  return `${base}:retry:${reply.id}`;
}

/** The approved plan's own contract, for a parent the plan keeps as the executable unit. */
function parentContract(
  db: Database.Database,
  issue: JiraIssue,
  deployment: PlanDeploymentRow,
): IssueRequirements {
  const plan = getReviewedPlan(db, deployment.planReviewId);
  if (!plan) {
    throw new NotDelegatedError(
      `${issue.key}'s approved plan ${deployment.planVersion} is missing`,
    );
  }
  return parentPlanRequirements(plan, issue.summary);
}

/** A task's contract from the parent's plan that defined it: the approved plan for a new task, an
 *  earlier one for a task a replan kept as-is. */
function taskContract(
  db: Database.Database,
  issueKey: string,
  planTask: PlanTaskMetadata,
): IssueRequirements {
  for (const review of listPlannedReviews(db, planTask.parentKey)) {
    const plan = getReviewedPlan(db, review.id);
    if (!plan) continue;
    const task = plan.tasks[planTaskIds(plan).indexOf(planTask.taskId)];
    if (task) return planTaskRequirements(task, planTask.dependencies);
  }
  throw new NotDelegatedError(
    `${issueKey}'s task ${planTask.taskId} is in no plan Router recorded for ${planTask.parentKey}`,
  );
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
  db?: Database.Database,
): Promise<PlanningContext> {
  const [comments, subtasks, planProperty] = await Promise.all([
    jira.getComments(issue.key),
    jira.searchIssues(`parent = "${issue.key}"`, { all: true }),
    jira.getIssueProperty(issue.key, PLAN_PROPERTY_KEY),
  ]);
  const plan = PlanMetadataSchema.safeParse(planProperty);
  const taskContracts = db
    ? await Promise.all(
        subtasks.map(async (subtask) => {
          const metadata = await readPlanTaskMetadata(jira, subtask.key);
          return metadata
            ? { issueKey: subtask.key, taskId: metadata.taskId, planVersion: metadata.planVersion }
            : undefined;
        }),
      )
    : [];
  const humanDecision = db
    ? planningDecision(latestPlanningRequest(db, issue.key))
    : findHumanDecision(comments, routerAccountId, issue.assigneeAccountId);
  return {
    ...(db ? { existingTaskContracts: taskContracts.flatMap((task) => (task ? [task] : [])) } : {}),
    ...(db ? { lifecycleVersion: 2 } : {}),
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
  quality?: QualityContext;
  integration?: QualityContext["integration"];
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
    ...(previous?.quality ? { quality: previous.quality } : {}),
    ...(previous?.integration ? { integration: previous.integration } : {}),
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

/**
 * Re-reads an open job's issue from Jira and decides whether its approval still stands
 * (§2 "실행 중 승인 철회, 책임자 제거, 실행 대상 변경, 계획 버전 변경은 취소 사유다 / 실행 중 작업
 * 설명·의존성 변경도 취소하고 새 승인을 요구한다"). Comments are not part of the
 * input hash, so Router's own report comments never revoke anything.
 *
 * Throws on a transient Jira failure: the caller must not treat "couldn't ask" as "revoked".
 */
export async function checkJobAgainstJira(
  jira: JiraGateway,
  config: RouterConfig,
  job: JobRow,
  db: Database.Database,
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

  // A run never moves its issue on start, so it may only be where it runs (ADR 0044).
  if (job.kind === "quality_review" || job.kind === "integration_check") {
    const stored = getApproval(db, issue.key);
    const check = db.prepare("SELECT source_key FROM workflow_checks WHERE job_id=?").get(job.id) as
      | { source_key: string }
      | undefined;
    if (
      issue.statusName !== approvalStatusFor(job.kind, workspace) ||
      !issue.assigneeAccountId ||
      stored?.approvalId !== job.approvalId ||
      !check
    )
      return { verdict: "revoked", reason: "workflow stage or authority changed" };
    const context = await checkContext(
      db,
      jira,
      config,
      workspace,
      issue,
      job.kind === "quality_review",
    );
    if (!context || checkSource(context) !== check.source_key)
      return { verdict: "revoked", reason: "integration target changed" };
    const approval = await readIssueApproval(jira, db, issue, workspace, job.kind);
    return approval.approvalId === job.approvalId &&
      inputHashMatches(job.inputHash, approval.inputHash)
      ? { verdict: "current", approval }
      : { verdict: "revoked", reason: "review inputs or approval changed" };
  }
  if (
    issue.statusName !== approvalStatusFor(job.kind, workspace) &&
    !(job.kind === "planning" && issue.statusName === workspace.workflow.planningInProgressStatus)
  ) {
    return { verdict: "revoked", reason: `${issue.key} moved to "${issue.statusName}"` };
  }
  if (!issue.assigneeAccountId) {
    return { verdict: "revoked", reason: `${issue.key} lost its human assignee` };
  }

  let approval: IssueApproval;
  try {
    approval = await readIssueApproval(jira, db, issue, workspace, job.kind);
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
  if (!inputHashMatches(job.inputHash, approval.inputHash)) {
    return { verdict: "revoked", reason: `${issue.key}'s inputs changed`, inputsChanged: true };
  }
  return { verdict: "current", approval };
}
