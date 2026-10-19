import type { JobResult } from "../contracts/envelope.js";
import {
  renderDecisionRequest,
  renderImplementationDecisionRequest,
} from "../pm/decision-render.js";
import { missingContracts } from "../pm/contract.js";
import {
  PlanApplyError,
  type PlanTask,
  SUPERSEDED_LABEL,
  planTaskIds,
  renderTaskDescription,
  validateTaskGraph,
} from "../pm/plan-render.js";
import type { Plan } from "../pm/plan.js";
import type { RouterConfig, WorkspaceConfig } from "./config.js";
import type { JobRow } from "./db/jobs.js";
import type { NewReportStep } from "./db/report-steps.js";
import type { ApprovalSnapshot } from "./issue-check.js";
import type { ReviewAssessment } from "./review-gate.js";
import { approvalStatusFor, decisionTransitionTarget, reRequestHint } from "./workflow-mode.js";

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
  /** Set for an implementation (ADR 0044), whose approval is not an entry into
   *  `approvalStatus`. Steps journaled without it keep the rule they were written under. */
  approvalRule?: ApprovalRule;
  /** Another issue than the step's own (a plan task moved when its plan is deployed). */
  issueKey?: string;
}

/**
 * How an implementation's transition re-derives the approval it was journaled under:
 *
 * - `plan-approval`: the plan's approval — the latest move of `issueKey` (the plan's parent) from
 *   `planReviewStatus` to `inProgressStatus` after its latest request.
 * - `plan-task`: a task run — the latest entry of the task into `inProgressStatus`, which is the
 *   part of the run's approval id after `@` (`taskApprovalId`).
 */
export type ApprovalRule =
  | {
      kind: "plan-approval";
      issueKey: string;
      requestStatus: string;
      planReviewStatus: string;
      inProgressStatus: string;
    }
  | { kind: "plan-task"; inProgressStatus: string };

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
  /** What the human does next: review, then approve or re-plan. */
  next?: string[];
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

/** A status move guarded by the job's approval (see `TransitionParams`). */
function transition(
  job: JobRow,
  workspace: WorkspaceConfig,
  to: string,
  from: string[],
): ReportStepSpec {
  const approvalRule = delegatedApprovalRule(job, workspace);
  return {
    kind: "transition",
    params: {
      to,
      from,
      approvalStatus: approvalStatusFor(job.kind, workspace),
      approvalId: job.approvalId,
      ...(approvalRule ? { approvalRule } : {}),
    },
  };
}

/** The rule an implementation's approval is re-derived with; `undefined` for a planning job,
 *  whose approval is the latest entry into `approvalStatus`. */
function delegatedApprovalRule(job: JobRow, workspace: WorkspaceConfig): ApprovalRule | undefined {
  if (job.kind !== "implementation") return undefined;
  if (parseTaskApprovalId(job.approvalId)) {
    return { kind: "plan-task", inProgressStatus: workspace.workflow.inProgressStatus };
  }
  return planApprovalRule(workspace, job.issueKey);
}

/** The `plan-approval` rule for the plan whose parent is `issueKey`. */
export function planApprovalRule(workspace: WorkspaceConfig, issueKey: string): ApprovalRule {
  const { requestStatus, planReviewStatus, inProgressStatus } = workspace.workflow;
  return {
    kind: "plan-approval",
    issueKey,
    requestStatus,
    planReviewStatus,
    inProgressStatus,
  };
}

/**
 * The approval id of one run of a task of a deployed plan: the plan's approval, the task, and the
 * task's entry into in progress. Moving the task out of in progress and back is a new run of the
 * same approved task; the approval of the plan itself stays the human's (ADR 0044).
 */
export function taskApprovalId(planApprovalId: string, taskId: string, entryId: string): string {
  return `${planApprovalId}#${taskId}@${entryId}`;
}

export function parseTaskApprovalId(
  approvalId: string,
): { planApprovalId: string; taskId: string; entryId: string } | undefined {
  const match = approvalId.match(/^(.+)#([^#@]+)@([^#@]+)$/);
  if (!match) return undefined;
  return {
    planApprovalId: match[1] as string,
    taskId: match[2] as string,
    entryId: match[3] as string,
  };
}

/**
 * When a worker is granted execution (ADR 0044): no status moves. A plan is written while the
 * issue stays in the request status, and an approved implementation already sits in progress; a
 * planning run only says on the card that it started.
 */
export function buildStartSteps(
  job: JobRow,
  workspace: WorkspaceConfig,
  attemptId: string,
): NewReportStep[] {
  if (job.kind !== "planning") return [];
  return toNewSteps([
    {
      kind: "comment",
      params: {
        body: [
          `GGJIRA started planning this request. The issue stays in "${workspace.workflow.requestStatus}" until the plan is ready for review.`,
          "",
          signature(job, attemptId),
        ].join("\n"),
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
  /** Why the merge is not taken as acceptance of the reviewed result (M4-11): no move to done. */
  doneWithheld?: string;
  /** The merge moves the issue, but its head could not be compared with the reviewed commit. */
  headNotCompared?: string;
  /** The reviewed result was high risk; only GitHub's branch protection enforces its review. */
  highRisk?: boolean;
}): NewReportStep[] {
  const { job, workspace } = input;
  const done = input.doneWithheld ? undefined : workspace.workflow.doneStatus;
  const by = input.by ? ` by ${input.by}` : "";
  const body = input.merged
    ? [
        `Pull request #${input.number} was merged${by}.`,
        input.url,
        ...(input.doneWithheld
          ? [
              "",
              `GGJIRA did not move the issue: ${input.doneWithheld}.`,
              "Check what was merged and move the issue yourself.",
            ]
          : []),
        ...(input.headNotCompared
          ? ["", `Head commit not compared: ${input.headNotCompared}.`]
          : []),
        ...(input.highRisk
          ? [
              "",
              "This result was flagged high risk. GGJIRA does not block merges; only the repository's branch protection enforces a required review.",
            ]
          : []),
        ...(done ? ["", `Moving the issue to "${done}".`] : []),
      ]
    : [
        `Pull request #${input.number} was closed without merging${by}.`,
        input.url,
        "",
        "The issue stays where it is. To redo the work, move it back to its request status.",
      ];
  return toNewSteps([
    { kind: "comment", params: { body: [...body, "", `ggjira job: ${job.id}`].join("\n") } },
    ...(input.merged && done
      ? [transition(job, workspace, done, [workspace.workflow.reviewStatus])]
      : []),
  ]);
}

/** Batch id of the journal for one review judgment (F01), one per review record. */
export function reviewJudgmentBatchId(recordId: number): string {
  return `review:${recordId}`;
}

/**
 * A human held a review target or asked for rework on the review screen (F01, ADR 0043). One
 * comment, no status move: the judgment records what a person said; it approves, completes or
 * reruns nothing. The name is what the caller declared behind the shared admin token.
 */
export function buildReviewJudgmentSteps(input: {
  job: JobRow;
  workspace: WorkspaceConfig;
  action: "hold" | "rework";
  attemptId: string;
  headSha: string | null;
  actor: string;
  note: string;
}): NewReportStep[] {
  const { job, workspace } = input;
  const subject = input.headSha
    ? `the result of attempt ${input.attemptId} (commit ${input.headSha.slice(0, 12)})`
    : `the result of attempt ${input.attemptId} (no commit)`;
  const who = `${input.actor} (name declared with the shared admin token)`;
  const body =
    input.action === "hold"
      ? [
          `Review on hold: ${subject}.`,
          `By ${who}.`,
          "",
          `Reason: ${input.note}`,
          "",
          "Nothing was approved or moved. The result stays waiting for review.",
        ]
      : [
          `Rework requested: ${subject}.`,
          `By ${who}.`,
          "",
          `Reason: ${input.note}`,
          "",
          `GGJIRA does not rerun it by itself. Next: ${reRequestHint(workspace, job.kind)}.`,
        ];
  return toNewSteps([
    {
      kind: "comment",
      params: { body: [...body, "", signature(job, input.attemptId)].join("\n") },
    },
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
  /** What a human has to look at in this result (M4-11); absent for cancelled runs. */
  review?: ReviewAssessment;
}

/** A run never moves the issue on start, so it finishes from where it ran: the request status for
 *  a plan, in progress for an implementation. */
function finishTransition(input: ResultJournalInput, to: string): ReportStepSpec {
  return transition(input.job, input.workspace, to, [
    approvalStatusFor(input.job.kind, input.workspace),
  ]);
}

/** A result that waits for a human decision: a plan waits in plan review; an implementation stays
 *  in progress, where the comment says what to do. */
function decisionTransition(input: ResultJournalInput): ReportStepSpec[] {
  const to = decisionTransitionTarget(input.workspace, input.job.kind);
  return to ? [finishTransition(input, to)] : [];
}

/** Where a failed run leaves the issue: the status it ran in. */
function failedRunStatus(input: ResultJournalInput): string {
  return approvalStatusFor(input.job.kind, input.workspace);
}

/** The status a human moves the issue to after answering a decision request: always the request
 *  status, since a changed request is planned again (ADR 0044). */
function decisionReplyStatus(input: ResultJournalInput): string {
  return input.workspace.workflow.requestStatus;
}

/** How a human asks for the job again: a fresh approval (ADR 0019, ADR 0044). */
function reRequest(input: ResultJournalInput): string {
  return reRequestHint(input.workspace, input.job.kind);
}

/**
 * Change → impact → what the human does → evidence (M4-09). A retry that fails the same way is
 * counted on its attention item instead of posting this again (src/router/worker-service.ts).
 */
function failureSteps(
  input: ResultJournalInput,
  summary: string,
  reason: string,
): ReportStepSpec[] {
  const lines = [
    input.finalState === "timed_out" ? "Execution timed out." : "Execution failed.",
    `Impact: the issue stays in "${failedRunStatus(input)}" with the "${input.config.reporting.failureLabel}" label, and GGJIRA does not run it again under this approval.`,
    `Next: fix the cause, then ${reRequest(input)}.`,
    "",
    "Failure Reason:",
    reason,
    "",
    "Summary:",
    summary || "(no summary)",
  ];
  if (input.result.blockingIssue) lines.push("", "Blocking Issue:", input.result.blockingIssue);
  const evidence = input.result.localEvidence;
  if (evidence) {
    // ADR 0036: the run stopped before commit; say where its changes were kept.
    lines.push("", "Uncommitted changes were kept on the worker:");
    if (evidence.patchFile) lines.push(`- patch: ${evidence.patchFile}`);
    if (evidence.worktreePath) lines.push(`- worktree: ${evidence.worktreePath}`);
    lines.push(`- cleanup: ${evidence.cleanup}`);
  }
  lines.push("", signature(input.job, input.attemptId));
  // ADR 0021: the issue stays in `inProgressStatus`; the label is what marks it failed.
  return [
    { kind: "comment", params: { body: lines.join("\n") } },
    { kind: "add-label", params: { label: input.config.reporting.failureLabel } },
  ];
}

const short = (sha: string | undefined): string => (sha ? sha.slice(0, 12) : "?");

/** The review lines of a success comment (M4-11): which queue, why, and on what evidence. */
function reviewLines(input: ResultJournalInput): string[] {
  const { review, result, workspace } = input;
  if (!review) return [];
  const lines: string[] = [];
  if (review.reviewClass === "immediate") {
    lines.push(
      "Needs your individual review before it is accepted:",
      ...review.reasons.map((reason) => `- ${reason.detail}`),
    );
  } else {
    lines.push("Ready for the ordinary review queue.");
  }
  const done = workspace.workflow.doneStatus;
  lines.push(
    result.pullRequest
      ? `Next: review and merge ${result.pullRequest.url}${done ? `; Router then moves the issue to "${done}"` : ""}.`
      : `Next: review the result below${done ? ` and move the issue to "${done}" yourself` : ""}; there is no pull request.`,
  );
  const { commit, risk } = review;
  if (commit.state === "committed") {
    lines.push("", `Reviewed commit: ${short(commit.headSha)} (base ${short(commit.baseSha)})`);
  } else if (commit.state === "no_commit") {
    lines.push(
      "",
      `No commit: ${commit.location ?? "unknown location"}. Commit-based freshness checks do not apply.`,
    );
  } else if (commit.state === "unknown") {
    lines.push("", "Commit: not reported by the worker.");
  }
  if (risk.status === "high") {
    lines.push(
      `High-risk check: ${risk.basis}${risk.policyVersion ? ` (rules ${risk.policyVersion})` : ""}`,
    );
    for (const match of risk.matches) {
      lines.push(
        `- ${match.rule}: ${match.from ? `${match.from} -> ` : ""}${match.path} (${match.change})`,
      );
    }
    for (const entry of risk.agentRisks)
      lines.push(`- agent: ${entry.area} — ${entry.description}`);
  } else if (risk.status === "not_matched") {
    lines.push(`High-risk check: no rule matched (rules ${risk.policyVersion}).`);
  } else if (risk.status === "unknown") {
    lines.push(`High-risk check: unknown — ${risk.basis}.`);
  }
  return lines;
}

/**
 * Change → impact → what the human does → evidence (M4-09): the first lines say what happened and
 * what to do; the evidence follows, referenced rather than copied where it is long.
 */
function successComment(input: ResultJournalInput): string {
  const { result, job } = input;
  const lines = ["Implementation completed.", ...reviewLines(input)];
  const verification = result.implementation?.verification ?? [];
  if (verification.length > 0) {
    lines.push(
      "",
      "Acceptance checks:",
      ...verification.map((entry) => `- ${entry.status}: ${entry.acceptance} — ${entry.evidence}`),
    );
  }
  lines.push("", "Summary:", result.summary || "(no summary)");
  if (result.changes?.length) lines.push("", "Changes:", ...result.changes.map((c) => `- ${c}`));
  if (result.validation?.length) {
    lines.push("", "Validation:", ...result.validation.map((v) => `- ${v}`));
  }
  if (result.scopeCheck && !result.scopeCheck.checked) {
    lines.push("", `Path scope: not checked (${result.scopeCheck.reason ?? "no reason given"}).`);
  }
  if (result.artifacts?.length) {
    lines.push("", "Artifacts:", ...result.artifacts.map((a) => `- ${a}`));
  }
  lines.push(
    "",
    signature(job, input.attemptId),
    `approval: ${job.approvalId}`,
    ...(job.inputHash ? [`input: ${job.inputHash.slice(0, 19)}`] : []),
  );
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
  // ADR 0044: any issue can be delegated, a subtask too, but Jira cannot nest subtasks. (An epic's
  // child also has a parent; only the subtask issue type tells the two apart in the snapshot.)
  const isSubtask =
    input.snapshot.issue.issueTypeName?.normalize("NFC") === input.config.planning.subtaskIssueType;
  if (isSubtask && plan.tasks.length > 0) {
    throw new PlanApplyError(
      `${input.job.issueKey} is a subtask; its plan has to do the work in the issue itself, without tasks`,
    );
  }
  // ADR 0047: the plan is the contract its runs are held to, so every executable unit has to say
  // what done means and how to check it before anyone can approve it.
  if (!plan.needsDecision) {
    const missing = missingContracts(plan);
    if (missing.length > 0) {
      throw new PlanApplyError(`Plan has no definition of done: ${missing.join("; ")}`);
    }
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
      params: {
        summary: plan.summary,
        signature: signature(job, input.attemptId),
        next: planReviewNext(workspace, plan.tasks.length > 0),
      },
    },
    { kind: "remove-label", params: { label: config.reporting.failureLabel } },
    finishTransition(input, workspace.workflow.planReviewStatus),
  );
  return steps;
}

/** ADR 0044: a plan is only a proposal until a human approves it. */
function planReviewNext(workspace: WorkspaceConfig, hasTasks: boolean): string[] {
  const { requestStatus, planReviewStatus, inProgressStatus } = workspace.workflow;
  return [
    `Nothing runs yet${hasTasks ? "; the subtasks wait for the approval too" : ""}.`,
    `To approve this plan: move the issue from "${planReviewStatus}" to "${inProgressStatus}".`,
    `To change it: edit the request and move the issue to "${requestStatus}" to plan it again.`,
  ];
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

  if (result.status === "needs_decision" && job.kind === "implementation") {
    // ADR 0036: the implement agent asked for a decision or left the contract, and the worker
    // stopped before commit/push. Not a failure, and not a planning decision.
    const report = result.implementation;
    const deviated =
      Boolean(report?.decision) ||
      (report?.scopeDeviations.length ?? 0) > 0 ||
      (result.scopeCheck?.outsideAllowed.length ?? 0) > 0;
    if (!deviated) {
      return toNewSteps(
        failureSteps(
          input,
          result.summary,
          "The implementation result asked for a decision but carried no decision or deviation.",
        ),
      );
    }
    return toNewSteps([
      {
        kind: "comment",
        params: {
          body: renderImplementationDecisionRequest(result, {
            requestStatus: decisionReplyStatus(input),
            signature: signature(job, input.attemptId),
          }),
        },
      },
      ...decisionTransition(input),
    ]);
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
            replyStatus: decisionReplyStatus(input),
            signature: signature(job, input.attemptId),
          }),
        },
      },
      // ADR 0021: without a dedicated status the question waits in review (legacy mode).
      ...decisionTransition(input),
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

/** Batch id of the journal for recording one plan approval (ADR 0044), one per deployment. */
export function planDeploymentBatchId(deploymentId: number): string {
  return `deploy:${deploymentId}`;
}

/** Batch id of the journal for the parent of a deployed plan once all its tasks are done. */
export function planCompletedBatchId(deploymentId: number): string {
  return `deploy-done:${deploymentId}`;
}

/** Batch id of the one notice that a move to in progress was not taken as a plan approval. */
export function planApprovalRefusedBatchId(issueKey: string, approvalId: string): string {
  return `approval-refused:${issueKey}:${approvalId}`;
}

/**
 * A human approved a plan (ADR 0044): say so on the parent, and move each task of the plan to
 * the shared in-progress status, where it runs once its dependencies are done. Every move is
 * re-checked against the plan's approval when it is applied, so a plan withdrawn in the meantime
 * moves nothing.
 */
export function buildPlanDeploymentSteps(input: {
  workspace: WorkspaceConfig;
  parentKey: string;
  planVersion: string;
  approvalId: string;
  /** Tasks found in Jira under this plan, with where each is now. */
  tasks: ReadonlyArray<{ issueKey: string; statusName: string }>;
}): NewReportStep[] {
  const { workspace, parentKey } = input;
  const { inProgressStatus, requestStatus } = workspace.workflow;
  const rule = planApprovalRule(workspace, parentKey);
  const body = [
    `Plan ${input.planVersion} approved: GGJIRA recorded the move to "${inProgressStatus}" as its approval.`,
    input.tasks.length > 0
      ? `Its ${input.tasks.length} subtask(s) move to "${inProgressStatus}" and run under this approval: ${input.tasks.map((task) => task.issueKey).join(", ")}. This issue only coordinates them.`
      : "The work is done in this issue itself.",
    "",
    `To withdraw it: move the issue out of "${inProgressStatus}". To change the plan: move it to "${requestStatus}".`,
    "",
    `approval: ${input.approvalId}`,
  ];
  return toNewSteps([
    { kind: "comment", params: { body: body.join("\n") } },
    ...input.tasks
      .filter((task) => task.statusName !== inProgressStatus)
      .map(
        (task): ReportStepSpec => ({
          kind: "transition",
          params: {
            to: inProgressStatus,
            from: [task.statusName],
            approvalStatus: inProgressStatus,
            approvalId: input.approvalId,
            approvalRule: rule,
            issueKey: task.issueKey,
          },
        }),
      ),
  ]);
}

/** Every task of a deployed plan is done: the parent goes to review, still under the plan's
 *  approval (ADR 0044). */
export function buildPlanCompletedSteps(input: {
  workspace: WorkspaceConfig;
  parentKey: string;
  approvalId: string;
  taskKeys: readonly string[];
}): NewReportStep[] {
  const { workspace, parentKey } = input;
  const { inProgressStatus, reviewStatus } = workspace.workflow;
  return toNewSteps([
    {
      kind: "comment",
      params: {
        body: [
          `All subtasks of the approved plan are done: ${input.taskKeys.join(", ")}.`,
          `Next: review the whole result here; the issue moves to "${reviewStatus}".`,
          "",
          `approval: ${input.approvalId}`,
        ].join("\n"),
      },
    },
    {
      kind: "transition",
      params: {
        to: reviewStatus,
        from: [inProgressStatus],
        approvalStatus: inProgressStatus,
        approvalId: input.approvalId,
        approvalRule: planApprovalRule(workspace, parentKey),
      },
    },
  ]);
}

/** A move to in progress that approves nothing, and why — said once per move (ADR 0044). */
export function buildPlanApprovalRefusedSteps(input: {
  workspace: WorkspaceConfig;
  reason: string;
}): NewReportStep[] {
  const { requestStatus, inProgressStatus } = input.workspace.workflow;
  return toNewSteps([
    {
      kind: "comment",
      params: {
        body: [
          `GGJIRA did not take the move to "${inProgressStatus}" as approval of a plan: ${input.reason}.`,
          "Impact: nothing runs; the issue is treated as human work.",
          `Next: ${input.reason.includes("decision") ? "answer the decision request, then " : ""}move the issue to "${requestStatus}" to get a current plan.`,
        ].join("\n"),
      },
    },
  ]);
}
