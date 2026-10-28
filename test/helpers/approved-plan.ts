import type { RouterDatabase } from "../../src/router/db/connection.js";
import type { FakeJiraGateway } from "../../src/jira/fake.js";
import type { JiraIssue } from "../../src/jira/types.js";
import { PLAN_PROPERTY_KEY } from "../../src/pm/metadata.js";
import { computeDelegationApprovalIds } from "../../src/router/approval.js";
import type { WorkspaceConfig } from "../../src/router/config.js";
import { createJob } from "../../src/router/db/jobs.js";
import {
  getLatestPlanReview,
  getReviewedPlan,
  recordPlanDeployment,
  recordPlanReview,
} from "../../src/router/db/plan-delegation.js";
import {
  insertReportBatch,
  listBatchReportSteps,
  updateReportStep,
} from "../../src/router/db/report-steps.js";
import { recordResult } from "../../src/router/db/results.js";
import { planningFingerprint, syncPlanningRequest } from "../../src/router/planning-requests.js";
import {
  TODO_STATUS,
  WORKFLOW_TRANSITIONS,
  issueDescription,
  singlePlan,
} from "./router-fixtures.js";

export interface ApprovedIssueOptions {
  plan?: Record<string, unknown>;
  summary?: string;
  description?: string;
  assigneeAccountId?: string | null;
  /** Any other issue fields (a subtask's parent, its issue type, an execution-agent option). */
  fields?: Partial<JiraIssue>;
}

/**
 * Seeds an issue a human delegated and whose plan they approved (ADR 0044): moved to the request
 * status, planned, moved to plan review and from there to in progress — with the planning run,
 * its result, its applied report and the active approval recorded as Router would have. The next
 * reconcile creates the implementation job under `plan`'s contract (ADR 0047), without a worker
 * writing the plan.
 */
export async function seedApprovedIssue(
  deps: { db: RouterDatabase; jira: FakeJiraGateway; workspace: WorkspaceConfig; now: string },
  key: string,
  opts: ApprovedIssueOptions = {},
): Promise<void> {
  const { db, jira, workspace, now } = deps;
  const { requestStatus, inProgressStatus } = workspace.workflow;
  jira.seedIssue(
    {
      key,
      summary: opts.summary ?? `Implement ${key}`,
      statusName: TODO_STATUS,
      projectKey: "KAN",
      assigneeAccountId: opts.assigneeAccountId === undefined ? "user-1" : opts.assigneeAccountId,
      description: opts.description ?? issueDescription(),
      ...opts.fields,
    },
    WORKFLOW_TRANSITIONS,
  );
  await jira.transitionIssueToStatus(key, requestStatus);
  await jira.transitionIssueToStatus(key, requestStatus);
  await jira.transitionIssueToStatus(key, inProgressStatus);
  const ids = await computeDelegationApprovalIds(
    jira,
    await jira.getIssue(key),
    workspace.workflow,
  );
  if (!ids.planApprovalId) throw new Error(`seedApprovedIssue: ${key} has no plan approval`);

  const jobId = `plan-job-${key}`;
  const attemptId = `plan-attempt-${key}`;
  const resultId = `plan-result-${key}`;
  const planVersion = `plan-${key}`;
  const plan = opts.plan ?? singlePlan();
  const taskIds = ((plan.tasks as Array<{ taskId?: string }> | undefined) ?? []).map(
    (task, index) => task.taskId ?? `task-${index + 1}`,
  );
  // The plan was written well before the test's own jobs (and outside Jev's look-back window).
  const plannedAt = new Date(Date.parse(now) - 2 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(
    "INSERT INTO planning_requests (id,issue_key,entry_id,input_hash,created_at,ready_history) VALUES (?,?,?,?,?,?)",
  ).run(
    ids.requestApprovalId,
    key,
    ids.requestApprovalId,
    planningFingerprint(await jira.getIssue(key)),
    plannedAt,
    "[]",
  );
  createJob(db, {
    id: jobId,
    issueKey: key,
    workspaceId: workspace.id,
    repositoryId: workspace.repositoryId,
    kind: "planning",
    approvalId: ids.requestApprovalId,
    state: "succeeded",
    now: plannedAt,
  });
  recordResult(db, {
    resultId,
    jobId,
    attemptId,
    payload: JSON.stringify({ status: "planned", summary: "planned", plan }),
    applied: true,
    now: plannedAt,
  });
  recordPlanReview(db, {
    id: resultId,
    issueKey: key,
    workspaceId: workspace.id,
    jobId,
    attemptId,
    requestApprovalId: ids.requestApprovalId,
    planVersion,
    outcome: "planned",
    taskIds,
    now: plannedAt,
  });
  await jira.setIssueProperty(key, PLAN_PROPERTY_KEY, { version: planVersion, taskIds });
  // The plan's own report, already applied to Jira, so a later approval of it can start.
  insertReportBatch(db, {
    batchId: resultId,
    resultId,
    jobId,
    attemptId,
    issueKey: key,
    steps: [{ kind: "plan-property", params: { version: planVersion, taskIds } }],
    now: plannedAt,
  });
  for (const step of listBatchReportSteps(db, resultId)) {
    updateReportStep(db, step.id, { status: "applied", now: plannedAt });
  }
  recordPlanDeployment(db, {
    issueKey: key,
    planReviewId: resultId,
    planVersion,
    approvalId: ids.planApprovalId,
    taskIds,
    state: "active",
    now,
  });
}

/** A human approves the issue's plan again: plan review, then back to in progress — a new
 *  approval of the same plan (ADR 0044). */
export async function reapprove(
  jira: FakeJiraGateway,
  workspace: WorkspaceConfig,
  key: string,
  db: RouterDatabase,
): Promise<void> {
  await jira.transitionIssueToStatus(key, workspace.workflow.requestStatus);
  const request = await syncPlanningRequest(
    db,
    jira,
    await jira.getIssue(key),
    workspace.workflow.requestStatus,
  );

  const old = getLatestPlanReview(db, key);
  if (!request || !old) throw new Error("reapprove needs a previous plan");
  const plan = getReviewedPlan(db, old.id);
  const id = `replanned-${request.id}`;
  const now = new Date().toISOString();
  // Seed a completed replan before the human approves, as seedApprovedIssue does initially.
  recordResult(db, {
    resultId: id,
    jobId: old.jobId,
    attemptId: id,
    payload: JSON.stringify({ status: "planned", plan }),
    applied: true,
    now,
  });
  recordPlanReview(db, {
    id,
    issueKey: key,
    workspaceId: workspace.id,
    jobId: old.jobId,
    attemptId: id,
    requestApprovalId: request.id,
    planVersion: id,
    outcome: "planned",
    taskIds: old.taskIds,
    now,
  });
  await jira.setIssueProperty(key, PLAN_PROPERTY_KEY, { version: id, taskIds: old.taskIds });
  insertReportBatch(db, {
    batchId: id,
    resultId: id,
    jobId: old.jobId,
    attemptId: id,
    issueKey: key,
    steps: [{ kind: "plan-property", params: { version: id, taskIds: old.taskIds } }],
    now,
  });
  for (const step of listBatchReportSteps(db, id))
    updateReportStep(db, step.id, { status: "applied", now });
  db.prepare("UPDATE planning_requests SET ready_history = '[]' WHERE id = ?").run(request.id);
  await jira.transitionIssueToStatus(key, workspace.workflow.inProgressStatus);
}
