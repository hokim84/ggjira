import type { JobResult } from "../contracts/envelope.js";
import { renderDecisionRequest } from "../pm/decision-render.js";
import type { Plan } from "../pm/plan.js";
import {
  PlanApplyError,
  type PlanTask,
  planTaskIds,
  renderTaskDescription,
  SUPERSEDED_LABEL,
  validateTaskGraph,
} from "../pm/plan-render.js";
import type { RouterConfig, WorkspaceConfig } from "./config.js";
import type { NewReportStep } from "./db/report-steps.js";
import type { JobRow } from "./db/jobs.js";
import { type ApprovalSnapshot, approvalStatusFor } from "./issue-check.js";

/**
 * Pure translation of "what happened" into the ordered Jira side effects Router owes an issue
 * (docs/router-service-implementation-plan.md §3 "실행 결과와 Jira 반영 분리"). Nothing here talks
 * to Jira: the steps are journaled in SQLite and executed by `src/router/report-processor.ts`,
 * which re-checks Jira before every write. Step params therefore carry everything a step needs
 * except what only earlier steps can produce (created subtask keys), which the processor passes
 * along as outcomes.
 */

/** A status move, applied only while the issue is still in one of `from` and still carries the
 *  job's approval (§3 "상태 전이 전에 현재 상태와 승인 조건을 재확인한다"). */
export interface TransitionParams {
  to: string;
  from: string[];
  approvalStatus: string;
  approvalId: string;
}

export interface CommentParams {
  body: string;
  /** Another issue than the step's own (e.g. a superseded subtask). */
  issueKey?: string;
}

export interface LabelParams {
  label: string;
}

export interface ParentPlanParams {
  plan: Plan;
}

export interface CreateSubtaskParams {
  taskId: string;
  projectKey: string;
  parentKey: string;
  issueTypeName: string;
  summary: string;
  description: string;
  assigneeAccountId: string | null;
}

export interface StampTaskParams {
  taskId: string;
  task: PlanTask;
  planVersion: string;
  parentKey: string;
  workspaceId: string;
}

export interface RestampKeptParams {
  issueKey: string;
  planVersion: string;
  parentKey: string;
}

export interface PlanPropertyParams {
  version: string;
  taskIds: string[];
  decisionId?: string;
}

export interface SupersedeParams {
  issueKey: string;
  label: string;
  /** Statuses that mean work already started; such a subtask is never superseded. */
  startedStatuses: string[];
}

export interface PlanCommentParams {
  summary: string;
  signature: string;
}

export type ReportStepSpec =
  | { kind: "transition"; params: TransitionParams }
  | { kind: "comment"; params: CommentParams }
  | { kind: "add-label"; params: LabelParams }
  | { kind: "remove-label"; params: LabelParams }
  | { kind: "parent-plan"; params: ParentPlanParams }
  | { kind: "create-subtask"; params: CreateSubtaskParams }
  | { kind: "stamp-task"; params: StampTaskParams }
  | { kind: "restamp-kept"; params: RestampKeptParams }
  | { kind: "plan-property"; params: PlanPropertyParams }
  | { kind: "supersede"; params: SupersedeParams }
  | { kind: "plan-comment"; params: PlanCommentParams };

export type ReportStepKind = ReportStepSpec["kind"];

function toNewSteps(specs: readonly ReportStepSpec[]): NewReportStep[] {
  return specs.map((spec) => ({
    kind: spec.kind,
    params: spec.params as unknown as Record<string, unknown>,
  }));
}

/** Batch id of the `start` journal for one attempt. */
export function startBatchId(attemptId: string): string {
  return `start:${attemptId}`;
}

/** Plan version Router stamps on a plan applied from one attempt's result. */
export function planVersionFor(attemptId: string): string {
  return `plan-${attemptId}`;
}

function signature(job: JobRow, attemptId: string): string {
  return [`ggjira job: ${job.id}`, `attempt: ${attemptId}`].join("\n");
}

/**
 * When a worker is granted execution: move the issue to `inProgressStatus` (§2 "Router가 실행
 * 직전 최신 상태를 재조회하고 진행 상태로 전이한다"), but only out of the status that approved it —
 * a human who already moved it elsewhere wins.
 */
export function buildStartSteps(job: JobRow, workspace: WorkspaceConfig): NewReportStep[] {
  const approvalStatus = approvalStatusFor(job.kind, workspace);
  return toNewSteps([
    {
      kind: "transition",
      params: {
        to: workspace.workflow.inProgressStatus,
        from: [approvalStatus],
        approvalStatus,
        approvalId: job.approvalId,
      },
    },
  ]);
}

/** Batch id of the journal for one pull request closing (merge or close), one per PR. */
export function pullRequestBatchId(repo: string, number: number): string {
  return `github:${repo.toLowerCase()}#${number}`;
}

/**
 * A worker-opened pull request was merged or closed (ADR 0027). A merge moves the issue from
 * `reviewStatus` to `doneStatus` — only out of review, so a human who already moved it wins, and
 * only while the approval the job ran under still stands. A close without merge is only reported.
 */
export function buildPullRequestClosedSteps(input: {
  job: JobRow;
  workspace: WorkspaceConfig;
  url: string;
  number: number;
  merged: boolean;
  by: string | null;
}): NewReportStep[] {
  const { job, workspace } = input;
  const done = workspace.workflow.doneStatus;
  const by = input.by ? ` by ${input.by}` : "";
  const body = input.merged
    ? [
        `Pull request #${input.number} was merged${by}.`,
        input.url,
        ...(done ? ["", `Moving the issue to "${done}".`] : []),
      ]
    : [
        `Pull request #${input.number} was closed without merging${by}.`,
        input.url,
        "",
        "The issue stays where it is. To redo the work, move it back to its request status.",
      ];
  const approvalStatus = approvalStatusFor(job.kind, workspace);
  return toNewSteps([
    { kind: "comment", params: { body: [...body, "", `ggjira job: ${job.id}`].join("\n") } },
    ...(input.merged && done
      ? [
          {
            kind: "transition" as const,
            params: {
              to: done,
              from: [workspace.workflow.reviewStatus],
              approvalStatus,
              approvalId: job.approvalId,
            },
          },
        ]
      : []),
  ]);
}

export function recoveredBatchId(attemptId: string): string {
  return `recovered:${attemptId}`;
}

/** Tells Jira that a run which lost its lease has been confirmed stopped — by the worker's late
 *  result or by an admin — and that nothing from it was applied. */
export function buildRecoveredSteps(
  job: JobRow,
  attemptId: string,
  confirmation: { status: string; summary: string } | { admin: string },
): NewReportStep[] {
  const detail =
    "admin" in confirmation
      ? `An admin (${confirmation.admin}) confirmed the run is stopped.`
      : `Its result arrived too late to apply. Worker-reported outcome: ${confirmation.status} — ${confirmation.summary}`;
  return toNewSteps([
    {
      kind: "comment",
      params: {
        body: [
          "AI execution lost contact with GGJIRA Router.",
          "",
          detail,
          "",
          "Nothing from this run was applied to the issue. To run it again, move the issue back to its request status.",
          "",
          signature(job, attemptId),
        ].join("\n"),
      },
    },
  ]);
}

export interface ResultJournalInput {
  job: JobRow;
  attemptId: string;
  /** The job's final state after the result was applied. */
  finalState: "succeeded" | "failed" | "timed_out" | "cancelled";
  result: JobResult;
  workspace: WorkspaceConfig;
  config: RouterConfig;
  /** The approval snapshot stored for the issue (parent issue + planning context). */
  snapshot: ApprovalSnapshot | undefined;
}

/** Moves out of in-progress (or the approving status, if the start move was skipped) to `to`. */
function finishTransition(input: ResultJournalInput, to: string): ReportStepSpec {
  const approvalStatus = approvalStatusFor(input.job.kind, input.workspace);
  return {
    kind: "transition",
    params: {
      to,
      from: [input.workspace.workflow.inProgressStatus, approvalStatus],
      approvalStatus,
      approvalId: input.job.approvalId,
    },
  };
}

function failureSteps(
  input: ResultJournalInput,
  summary: string,
  reason: string,
): ReportStepSpec[] {
  const lines = [
    input.finalState === "timed_out" ? "Execution timed out." : "Execution failed.",
    "",
    "Summary:",
    summary || "(no summary)",
    "",
    "Failure Reason:",
    reason,
  ];
  if (input.result.blockingIssue) lines.push("", "Blocking Issue:", input.result.blockingIssue);
  lines.push(
    "",
    `To run it again, move the issue back to "${approvalStatusFor(input.job.kind, input.workspace)}".`,
    "",
    signature(input.job, input.attemptId),
  );
  // ADR 0021: the issue stays in `inProgressStatus`; the label is what marks it failed.
  return [
    { kind: "comment", params: { body: lines.join("\n") } },
    { kind: "add-label", params: { label: input.config.reporting.failureLabel } },
  ];
}

function successComment(input: ResultJournalInput): string {
  const { result } = input;
  const lines = ["Implementation completed.", "", "Summary:", result.summary || "(no summary)"];
  if (result.changes?.length) lines.push("", "Changes:", ...result.changes.map((c) => `- ${c}`));
  if (result.validation?.length) {
    lines.push("", "Validation:", ...result.validation.map((v) => `- ${v}`));
  }
  if (result.artifacts?.length) {
    lines.push("", "Artifacts:", ...result.artifacts.map((a) => `- ${a}`));
  }
  lines.push("", signature(input.job, input.attemptId));
  return lines.join("\n");
}

/** Throws `PlanApplyError` for a plan Router must not apply (the v4 `applyPlan` checks). */
function validatePlan(input: ResultJournalInput, plan: Plan): void {
  if (plan.tasks.length > input.config.planning.maxTasksPerPlan) {
    throw new PlanApplyError(
      `Plan has ${plan.tasks.length} tasks, exceeding planning.maxTasksPerPlan (${input.config.planning.maxTasksPerPlan})`,
    );
  }
  const taskIds = planTaskIds(plan);
  if (new Set(taskIds).size !== taskIds.length) {
    throw new PlanApplyError("Plan taskId values must be unique");
  }
  validateTaskGraph(plan.tasks, taskIds);
  if (!input.snapshot?.issue.projectKey) {
    throw new PlanApplyError(`Issue ${input.job.issueKey} has no project key in its snapshot`);
  }
}

function planSteps(input: ResultJournalInput, plan: Plan): ReportStepSpec[] {
  const { job, workspace, config, snapshot } = input;
  const parent = snapshot?.issue;
  if (!parent?.projectKey) throw new PlanApplyError("missing parent snapshot");
  const planVersion = planVersionFor(input.attemptId);
  const taskIds = planTaskIds(plan);
  const keep = new Set(plan.keepTaskKeys);
  const started = [workspace.workflow.inProgressStatus, workspace.workflow.reviewStatus];

  const steps: ReportStepSpec[] = [{ kind: "parent-plan", params: { plan } }];
  plan.tasks.forEach((task, index) => {
    steps.push({
      kind: "create-subtask",
      params: {
        taskId: taskIds[index] as string,
        projectKey: parent.projectKey as string,
        parentKey: job.issueKey,
        issueTypeName: config.planning.subtaskIssueType,
        summary: task.title,
        description: renderTaskDescription(task),
        // The parent's human owner stays accountable for every subtask (§2 "Assignee는 인간
        // 책임자로 유지한다").
        assigneeAccountId: parent.assigneeAccountId,
      },
    });
  });
  plan.tasks.forEach((task, index) => {
    steps.push({
      kind: "stamp-task",
      params: {
        taskId: taskIds[index] as string,
        task,
        planVersion,
        parentKey: job.issueKey,
        workspaceId: job.workspaceId,
      },
    });
  });
  for (const issueKey of keep) {
    steps.push({
      kind: "restamp-kept",
      params: { issueKey, planVersion, parentKey: job.issueKey },
    });
  }
  const decisionId = snapshot?.planning?.humanDecision?.decisionId;
  steps.push({
    kind: "plan-property",
    params: { version: planVersion, taskIds, ...(decisionId ? { decisionId } : {}) },
  });
  for (const subtask of snapshot?.planning?.existingSubtasks ?? []) {
    if (keep.has(subtask.key)) continue;
    steps.push({
      kind: "supersede",
      params: { issueKey: subtask.key, label: SUPERSEDED_LABEL, startedStatuses: started },
    });
  }
  steps.push(
    {
      kind: "plan-comment",
      params: { summary: plan.summary, signature: signature(job, input.attemptId) },
    },
    { kind: "remove-label", params: { label: config.reporting.failureLabel } },
    finishTransition(input, workspace.workflow.reviewStatus),
  );
  return steps;
}

/**
 * The Jira journal for one applied result. A planning result that cannot be applied (no plan,
 * too many tasks, a dependency cycle) is reported as a failure instead — never half-applied.
 */
export function buildResultSteps(input: ResultJournalInput): NewReportStep[] {
  const { job, result, workspace } = input;

  if (input.finalState === "cancelled") {
    return toNewSteps([
      {
        kind: "comment",
        params: {
          body: [
            "AI execution stopped.",
            "",
            result.summary,
            "",
            signature(job, input.attemptId),
          ].join("\n"),
        },
      },
    ]);
  }
  if (input.finalState === "failed" || input.finalState === "timed_out") {
    return toNewSteps(
      failureSteps(input, result.summary, result.failureReason ?? result.summary ?? "(unknown)"),
    );
  }

  if (result.status === "needs_decision") {
    if (!result.plan?.decision) {
      return toNewSteps(
        failureSteps(
          input,
          result.summary,
          "The planning result asked for a decision but carried none.",
        ),
      );
    }
    return toNewSteps([
      {
        kind: "comment",
        params: {
          body: renderDecisionRequest(result.plan, {
            planVersion: planVersionFor(input.attemptId),
            replyStatus: approvalStatusFor("planning", workspace),
            signature: signature(job, input.attemptId),
          }),
        },
      },
      // ADR 0021: without a dedicated status the question waits in review.
      finishTransition(
        input,
        workspace.workflow.needsDecisionStatus ?? workspace.workflow.reviewStatus,
      ),
    ]);
  }

  if (result.status === "planned") {
    if (!result.plan) {
      return toNewSteps(
        failureSteps(input, result.summary, "The planning result carried no plan."),
      );
    }
    try {
      validatePlan(input, result.plan);
    } catch (error) {
      if (!(error instanceof PlanApplyError)) throw error;
      return toNewSteps(
        failureSteps(input, result.summary, `The plan could not be applied: ${error.message}`),
      );
    }
    return toNewSteps(planSteps(input, result.plan));
  }

  return toNewSteps([
    { kind: "comment", params: { body: successComment(input) } },
    { kind: "remove-label", params: { label: input.config.reporting.failureLabel } },
    finishTransition(input, workspace.workflow.reviewStatus),
  ]);
}
