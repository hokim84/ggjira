import path from "node:path";
import type { JobResult } from "../contracts/envelope.js";
import { missingContracts } from "../pm/contract.js";
import {
  renderDecisionRequest,
  renderImplementationDecisionRequest,
} from "../pm/decision-render.js";
import {
  PlanApplyError,
  type PlanTask,
  SUPERSEDED_LABEL,
  planTaskIds,
  renderTaskDescription,
  validateTaskGraph,
} from "../pm/plan-render.js";
import type { Plan } from "../pm/plan.js";
import {
  COMMENT_TEXT,
  type MergeWhy,
  type MessageLanguage,
  type PlanRefusal,
} from "./comment-text.js";
import type { RouterConfig, WorkspaceConfig } from "./config.js";
import type { JobRow } from "./db/jobs.js";
import type { NewReportStep } from "./db/report-steps.js";
import { type FailureMatch, failureMessage, matchFailure } from "./failure-codes.js";
import type { ApprovalSnapshot } from "./issue-check.js";
import type { ReviewAssessment } from "./review-gate.js";
import { awaitingHumanCheck, verifiedNoChange, verifiedImplementation } from "./workflow-checks.js";
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
  parentProgress?: boolean;
}

/**
 * How an implementation's transition re-derives the approval it was journaled under:
 *
 * - `plan-approval`: the plan's approval — the latest move of `issueKey` (the plan's parent) from
 *   `requestStatus` to `inProgressStatus` after its latest request.
 * - `plan-task`: a task run — the latest entry of the task into `inProgressStatus`, which is the
 *   part of the run's approval id after `@` (`taskApprovalId`).
 */
export type ApprovalRule =
  | { kind: "workflow-job"; jobId: string; inputHash: string | null; workspace?: WorkspaceConfig }
  | { kind: "parent-stage"; requestId: string; inputHash: string };

export interface CommentParams {
  body: string;
  /** Another issue than the step's own (e.g. a superseded subtask). */
  issueKey?: string;
}

/** The full text behind a short failure comment, written on the Router machine (ADR 0048). */
export interface FailureLogParams {
  path: string;
  body: string;
}

export interface LabelParams {
  label: string;
}

export interface ParentPlanParams {
  plan: Plan;
}

export interface CreateSubtaskParams {
  standalone?: boolean;
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
  /** The comment on the superseded subtask, in the configured language (ADR 0048). */
  comment: string;
}

export interface PlanCommentParams {
  summary: string;
  signature: string;
  /** What the human does next: review, then approve or re-plan. */
  next?: string[];
  /** The language of the comment's own lines, applied when the comment is built (ADR 0048). */
  language: MessageLanguage;
}

export type ReportStepSpec =
  | { kind: "children-ready"; params: { version: string; inProgressStatus: string } }
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
  | { kind: "plan-comment"; params: PlanCommentParams }
  | { kind: "failure-log"; params: FailureLogParams };

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

/** Where the failure log of one attempt goes: next to Router's database, like the worker's own
 *  `data/worker-logs`. A relative path resolves against Router's working directory, as the
 *  database path does. */
export function failureLogPath(config: RouterConfig, issueKey: string, attemptId: string): string {
  return path.join(path.dirname(config.db.path), "failure-logs", `${issueKey}-${attemptId}.log`);
}

/**
 * Writes the full text to the failure log first, then posts the short comment that points to it:
 * `<headline>`, the lines after it, and where the details are. The log stays in English with the
 * code and the comment's message, so it reads the same whatever the comment language.
 */
function failureLogSteps(
  config: RouterConfig,
  job: JobRow,
  attemptId: string,
  coded: { headline: string; failure?: FailureMatch },
  full: string[],
  brief: string[],
): ReportStepSpec[] {
  const logPath = failureLogPath(config, job.issueKey, attemptId);
  const text = COMMENT_TEXT[config.reporting.language].failure;
  return [
    {
      kind: "failure-log",
      params: {
        path: logPath,
        body: [
          ...(coded.failure ? [`code: ${coded.failure.code}`] : []),
          `issue: ${job.issueKey}`,
          `approval: ${job.approvalId}`,
          `comment: ${coded.headline}`,
          "",
          ...full,
          "",
          signature(job, attemptId),
          "",
        ].join("\n"),
      },
    },
    {
      kind: "comment",
      params: {
        body: [coded.headline, ...brief, text.details(logPath), "", signature(job, attemptId)].join(
          "\n",
        ),
      },
    },
  ];
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
  return { kind: "workflow-job", jobId: job.id, inputHash: job.inputHash, workspace };
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
  language: MessageLanguage,
): NewReportStep[] {
  if (job.kind !== "planning") return [];
  return toNewSteps([
    transition(job, workspace, workspace.workflow.planningInProgressStatus, [
      workspace.workflow.requestStatus,
    ]),
    {
      kind: "comment",
      params: {
        body: [
          COMMENT_TEXT[language].planningStarted(workspace.workflow.planningInProgressStatus),
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
  doneWithheld?: MergeWhy;
  /** The merge moves the issue, but its head could not be compared with the reviewed commit. */
  headNotCompared?: MergeWhy;
  /** The reviewed result was high risk; only GitHub's branch protection enforces its review. */
  highRisk?: boolean;
  language: MessageLanguage;
}): NewReportStep[] {
  const { job, workspace } = input;
  const text = COMMENT_TEXT[input.language].pullRequest;
  const done = undefined;
  const body = input.merged
    ? [
        text.merged(input.number, input.by),
        input.url,
        ...(input.doneWithheld
          ? ["", text.withheld(text.why(input.doneWithheld)), text.moveYourself]
          : []),
        ...(input.headNotCompared
          ? ["", text.headNotCompared(text.why(input.headNotCompared))]
          : []),
        ...(input.highRisk ? ["", text.highRisk] : []),
        ...(done ? ["", text.movingToDone(done)] : []),
      ]
    : [text.closed(input.number, input.by), input.url, "", text.closedNext];
  return toNewSteps([
    { kind: "comment", params: { body: [...body, "", `ggjira job: ${job.id}`].join("\n") } },
    ...(input.merged && done
      ? [transition(job, workspace, done, [workspace.workflow.implementationCompleteStatus])]
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
  language: MessageLanguage;
}): NewReportStep[] {
  const { job, workspace, language } = input;
  const text = COMMENT_TEXT[language].reviewJudgment;
  const subject = text.subject(input.attemptId, input.headSha);
  const hold = input.action === "hold";
  const body = [
    hold ? text.hold(subject) : text.rework(subject),
    text.by(input.actor),
    "",
    text.reason(input.note),
    "",
    hold ? text.holdNothing : text.reworkNext(reRequestHint(workspace, job.kind, language)),
  ];
  return toNewSteps([
    {
      kind: "comment",
      params: { body: [...body, "", signature(job, input.attemptId)].join("\n") },
    },
  ]);
}

/**
 * ADR 0061: a person confirmed the acceptance criteria a child's agent could not verify. The
 * confirm is the child's missing evidence, so it completes like a verified child does.
 */
export function buildHumanConfirmedChildSteps(input: {
  job: JobRow;
  workspace: WorkspaceConfig;
  attemptId: string;
  headSha: string | null;
  actor: string;
  language: MessageLanguage;
}): NewReportStep[] {
  const { job, workspace } = input;
  const text = COMMENT_TEXT[input.language].reviewJudgment;
  const complete = workspace.workflow.implementationCompleteStatus;
  const body = [
    text.childConfirmed(text.subject(input.attemptId, input.headSha), complete),
    text.by(input.actor),
  ];
  return toNewSteps([
    transition(job, workspace, complete, [approvalStatusFor(job.kind, workspace)]),
    {
      kind: "comment",
      params: { body: [...body, "", signature(job, input.attemptId)].join("\n") },
    },
  ]);
}

export function uncertainRunBatchId(attemptId: string): string {
  return `uncertain:${attemptId}`;
}

/** ADR 0062: tells the assignee in Jira that a run is `recovery_required` and how to rerun it. */
export function buildUncertainRunSteps(
  config: RouterConfig,
  job: JobRow,
  attemptId: string,
): NewReportStep[] {
  const text = COMMENT_TEXT[config.reporting.language].failure;
  return toNewSteps([
    {
      kind: "comment",
      params: {
        body: [text.lostContact, text.uncertainRun, "", signature(job, attemptId)].join("\n"),
      },
    },
  ]);
}

export function recoveredBatchId(attemptId: string): string {
  return `recovered:${attemptId}`;
}

/** Tells Jira that a run which lost its lease has been confirmed stopped — by the worker's late
 *  result or by an admin — and that nothing from it was applied. */
export function buildRecoveredSteps(
  config: RouterConfig,
  job: JobRow,
  attemptId: string,
  confirmation: { status: string; summary: string } | { admin: string },
): NewReportStep[] {
  const language = config.reporting.language;
  const text = COMMENT_TEXT[language].failure;
  if ("admin" in confirmation) {
    return toNewSteps([
      {
        kind: "comment",
        params: {
          body: [
            text.lostContact,
            text.adminStopped(confirmation.admin),
            text.nothingApplied,
            "",
            signature(job, attemptId),
          ].join("\n"),
        },
      },
    ]);
  }
  const failure: FailureMatch = { code: "GGJ-501", params: { status: confirmation.status } };
  return toNewSteps(
    failureLogSteps(
      config,
      job,
      attemptId,
      { headline: text.lostContact, failure },
      [
        "Its result arrived too late to apply.",
        `Worker-reported outcome: ${confirmation.status}`,
        "",
        "Summary:",
        confirmation.summary || "(no summary)",
      ],
      [`[${failure.code}] ${failureMessage(failure, language)}`, text.nothingApplied],
    ),
  );
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

/**
 * What failed and what the human does, with the full text in the failure log (M4-09, ADR 0048).
 * `failure` is the code Router gives a failure it found itself; a worker-reported reason is coded
 * by `matchFailure`. A retry that fails the same way is counted on its attention item instead of
 * posting this again (src/router/worker-service.ts).
 */
function failureSteps(
  input: ResultJournalInput,
  summary: string,
  reason: string,
  failure?: FailureMatch,
): ReportStepSpec[] {
  const timedOut = input.finalState === "timed_out";
  const language = input.config.reporting.language;
  const text = COMMENT_TEXT[language].failure;
  const coded =
    failure ?? (timedOut ? { code: "GGJ-105" as const, params: {} } : matchFailure(reason));
  const full = [
    `Impact: the issue stays in "${failedRunStatus(input)}" with the "${input.config.reporting.failureLabel}" label, and GGJIRA does not run it again under this approval.`,
    `Next: fix the cause, then ${reRequestHint(input.workspace, input.job.kind)}.`,
    "",
    "Failure Reason:",
    reason,
    "",
    "Summary:",
    summary || "(no summary)",
  ];
  if (input.result.blockingIssue) full.push("", "Blocking Issue:", input.result.blockingIssue);
  // The agent's own checks and the worker's trusted command, so the log shows which one failed.
  const checks = input.result.implementation?.verification ?? [];
  if (checks.length > 0) {
    full.push(
      "",
      "Acceptance Checks:",
      ...checks.map(
        (check) =>
          `- ${check.status}${check.method ? ` (${check.method})` : ""}: ${check.acceptance} — ${check.evidence}`,
      ),
    );
  }
  if (input.result.validation?.length) {
    full.push("", "Validation:", ...input.result.validation.map((line) => `- ${line}`));
  }
  const evidence = input.result.localEvidence;
  if (evidence) {
    // ADR 0036: the run stopped before commit; say where its changes were kept.
    full.push("", "Uncommitted changes were kept on the worker:");
    if (evidence.patchFile) full.push(`- patch: ${evidence.patchFile}`);
    if (evidence.worktreePath) full.push(`- worktree: ${evidence.worktreePath}`);
    full.push(`- cleanup: ${evidence.cleanup}`);
  }
  const headline = `${timedOut ? text.timedOut : text.failed} [${coded.code}]: ${failureMessage(coded, language)}`;
  const brief = [
    text.next(reRequestHint(input.workspace, input.job.kind, language)),
    ...(evidence ? [text.keptChanges] : []),
  ];
  // ADR 0021: the issue stays in `inProgressStatus`; the label is what marks it failed.
  return [
    ...failureLogSteps(
      input.config,
      input.job,
      input.attemptId,
      { headline, failure: coded },
      full,
      brief,
    ),
    { kind: "add-label", params: { label: input.config.reporting.failureLabel } },
  ];
}

const short = (sha: string | undefined): string => (sha ? sha.slice(0, 12) : "?");

/** The review lines of a success comment (M4-11): which queue, why, and on what evidence. */
function reviewLines(input: ResultJournalInput): string[] {
  const { review, result, workspace } = input;
  if (!review) return [];
  const text = COMMENT_TEXT[input.config.reporting.language].result;
  const lines: string[] = [];
  if (review.reviewClass === "immediate") {
    lines.push(
      text.needsReview,
      ...review.reasons.map((reason) => `- ${text.reason(reason, review)}`),
    );
  } else {
    lines.push(text.ordinaryQueue);
  }
  const done = workspace.workflow.implementationCompleteStatus;
  lines.push(
    input.snapshot?.planTask || input.snapshot?.integration?.parentKey
      ? "자식 결과는 원격 커밋으로 보존합니다. 모든 자식 완료 후 부모 PR 하나를 만들며, 병합 후 평가는 부모에서 진행합니다."
      : result.pullRequest
        ? text.nextWithPullRequest(result.pullRequest.url, done)
        : text.nextWithoutPullRequest(done),
  );
  const { commit, risk } = review;
  if (commit.state === "committed") {
    lines.push("", text.reviewedCommit(short(commit.headSha), short(commit.baseSha)));
  } else if (commit.state === "no_commit") {
    lines.push("", text.noCommit(commit.location));
  } else if (commit.state === "unknown") {
    lines.push("", text.commitUnknown);
  }
  if (risk.status === "high") {
    lines.push(text.riskHigh(review));
    for (const match of risk.matches) {
      lines.push(
        `- ${match.rule}: ${match.from ? `${match.from} -> ` : ""}${match.path} (${match.change})`,
      );
    }
    for (const entry of risk.agentRisks) lines.push(text.agentRisk(entry.area, entry.description));
  } else if (risk.status === "not_matched") {
    lines.push(text.riskNotMatched(risk.policyVersion));
  } else if (risk.status === "unknown") {
    lines.push(text.riskUnknown(review));
  }
  return lines;
}

/**
 * Change → impact → what the human does → evidence (M4-09): the first lines say what happened and
 * what to do; the evidence follows, referenced rather than copied where it is long.
 */
function successComment(input: ResultJournalInput): string {
  const { result, job } = input;
  const text = COMMENT_TEXT[input.config.reporting.language].result;
  const lines = [text.completed, ...reviewLines(input)];
  const verification = result.implementation?.verification ?? [];
  if (verification.length > 0) {
    lines.push(
      "",
      text.acceptanceChecks,
      ...verification.map(
        (entry) =>
          `- ${text.verificationStatus(entry.status)}${entry.method ? `(${text.verificationMethod(entry.method)})` : ""}: ${entry.acceptance} — ${entry.evidence}`,
      ),
    );
  }
  lines.push("", text.summary, result.summary || text.noSummary);
  if (result.changes?.length) lines.push("", text.changes, ...result.changes.map((c) => `- ${c}`));
  if (result.validation?.length) {
    lines.push("", text.validation, ...result.validation.map((v) => `- ${v}`));
  }
  if (result.scopeCheck && !result.scopeCheck.checked) {
    lines.push("", text.pathScopeNotChecked(result.scopeCheck.reason));
  }
  if (result.artifacts?.length) {
    lines.push("", text.artifacts, ...result.artifacts.map((a) => `- ${a}`));
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
  if (input.snapshot?.planning && !plan.needsDecision) {
    if (!plan.acceptanceCriteria?.length || !plan.verification.length)
      throw new PlanApplyError(
        "Parent acceptanceCriteria and integration verification are required",
      );
    const existing = input.snapshot.planning.existingSubtasks;
    const tracked = input.snapshot.planning.existingTaskContracts ?? [];
    const keptIds = plan.keepTaskKeys.map(
      (key) => tracked.find((task) => task.issueKey === key)?.taskId,
    );
    if (keptIds.some((id) => !id))
      throw new PlanApplyError("Only Router-tracked children may be kept");
    const allIds = [...planTaskIds(plan), ...keptIds];
    if (new Set(allIds).size !== allIds.length)
      throw new PlanApplyError("New and kept task IDs must be unique together");
    const started = [
      input.workspace.workflow.inProgressStatus,
      input.workspace.workflow.integrationPendingStatus,
      input.workspace.workflow.implementationCompleteStatus,
      input.workspace.workflow.implementationCompleteStatus,
      input.workspace.workflow.doneStatus,
    ];
    if (
      existing.some(
        (task) =>
          tracked.some((identity) => identity.issueKey === task.key) &&
          started.includes(task.statusName) &&
          !plan.keepTaskKeys.includes(task.key),
      )
    )
      throw new PlanApplyError("A replan must preserve started and completed tasks explicitly");
    if (plan.keepTaskKeys.some((key) => !existing.some((task) => task.key === key)))
      throw new PlanApplyError("keepTaskKeys must name existing children");
  }
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
  const started = [
    workspace.workflow.inProgressStatus,
    workspace.workflow.integrationPendingStatus,
    workspace.workflow.implementationCompleteStatus,
    workspace.workflow.implementationCompleteStatus,
    workspace.workflow.doneStatus,
  ];

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
    if (
      snapshot?.planning &&
      !snapshot.planning.existingTaskContracts?.some((task) => task.issueKey === subtask.key)
    )
      continue;
    if (keep.has(subtask.key)) continue;
    steps.push({
      kind: "supersede",
      params: {
        issueKey: subtask.key,
        label: SUPERSEDED_LABEL,
        startedStatuses: started,
        comment: COMMENT_TEXT[config.reporting.language].plan.superseded,
      },
    });
  }
  steps.push(
    {
      kind: "plan-comment",
      params: {
        summary: plan.summary,
        signature: signature(job, input.attemptId),
        next: [
          `계획은 "${workspace.workflow.planningInProgressStatus}"에 유지합니다. 실행할 자식(자식이 없으면 이 이슈)을 "${workspace.workflow.inProgressStatus}"으로 옮기세요.`,
          `구현과 통합 검증 후 "${workspace.workflow.implementationCompleteStatus}"으로 자동 이동합니다. AI 리뷰는 선택 사항입니다.`,
        ],
        language: config.reporting.language,
      },
    },
    { kind: "remove-label", params: { label: config.reporting.failureLabel } },
  );
  if (snapshot?.planning)
    steps.push({
      kind: "children-ready",
      params: { version: planVersion, inProgressStatus: workspace.workflow.inProgressStatus },
    });
  return steps;
}

/** ADR 0044: a plan is only a proposal until a human approves it. */
function planReviewNext(
  workspace: WorkspaceConfig,
  hasTasks: boolean,
  language: MessageLanguage,
): string[] {
  const { requestStatus, inProgressStatus } = workspace.workflow;
  const text = COMMENT_TEXT[language].plan;
  return [
    text.nothingRunsYet(hasTasks),
    text.toApprove(requestStatus, inProgressStatus),
    text.toChange(requestStatus),
  ];
}

/**
 * The Jira journal for one applied result. A planning result that cannot be applied (no plan,
 * too many tasks, a dependency cycle) is reported as a failure instead — never half-applied.
 */
export function buildResultSteps(input: ResultJournalInput): NewReportStep[] {
  const steps = resultSteps(input);
  if (input.finalState === "cancelled") return steps;
  return [
    {
      kind: input.result.status === "needs_decision" ? "add-label" : "remove-label",
      params: { label: "ggjira-needs-answer" },
    },
    ...steps,
  ];
}

function resultSteps(input: ResultJournalInput): NewReportStep[] {
  const { job, result, workspace } = input;
  const text = COMMENT_TEXT[input.config.reporting.language];

  if (input.finalState === "cancelled") {
    return toNewSteps([
      {
        kind: "comment",
        params: {
          body: [text.stopped, "", result.summary, "", signature(job, input.attemptId)].join("\n"),
        },
      },
    ]);
  }
  if (input.finalState === "failed" || input.finalState === "timed_out") {
    return toNewSteps(
      failureSteps(input, result.summary, result.failureReason ?? result.summary ?? "(unknown)"),
    );
  }

  if (job.kind === "assemble_pr") {
    return toNewSteps([
      {
        kind: "comment",
        params: {
          body: [
            result.summary,
            result.pullRequest?.url ?? "추가 변경이 없어 PR을 만들지 않았습니다.",
            "사람의 병합 후 부모 통합 검증을 진행합니다. FCI는 활성화된 경우 병합 후 별도로 분석합니다.",
          ].join("\n"),
        },
      },
      { kind: "remove-label", params: { label: input.config.reporting.failureLabel } },
      finishTransition(input, workspace.workflow.integrationPendingStatus),
    ]);
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
          { code: "GGJ-403", params: {} },
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
            text: text.implementationDecision,
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
          { code: "GGJ-403", params: {} },
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
            text: text.decision,
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
        failureSteps(input, result.summary, "The planning result carried no plan.", {
          code: "GGJ-402",
          params: {},
        }),
      );
    }
    try {
      validatePlan(input, result.plan);
    } catch (error) {
      if (!(error instanceof PlanApplyError)) throw error;
      return toNewSteps(
        failureSteps(input, result.summary, `The plan could not be applied: ${error.message}`, {
          code: "GGJ-401",
          params: { detail: error.message },
        }),
      );
    }
    return toNewSteps(planSteps(input, result.plan));
  }

  const child = Boolean(input.snapshot?.planTask || input.snapshot?.integration?.parentKey);
  return toNewSteps([
    { kind: "comment", params: { body: successComment(input) } },
    { kind: "remove-label", params: { label: input.config.reporting.failureLabel } },
    ...(child && awaitingHumanCheck(input.result)
      ? // ADR 0061: kept in progress, without the failure label, until a person confirms.
        [
          {
            kind: "comment" as const,
            params: {
              body: COMMENT_TEXT[input.config.reporting.language].humanCheck.waiting(
                (input.result.implementation?.verification ?? [])
                  .filter((check) => check.status === "not_verified")
                  .map((check) => check.acceptance),
                workspace.workflow.implementationCompleteStatus,
              ),
            },
          },
        ]
      : child &&
          verifiedImplementation(input.result) &&
          input.result.artifacts?.some((a) => a.startsWith("pushed:"))
        ? [
            finishTransition(input, workspace.workflow.implementationCompleteStatus),
            {
              kind: "comment" as const,
              params: {
                body: "자식 구현과 자체 테스트가 완료되어 결과 커밋을 보존했습니다. 나머지 자식이 완료되면 부모 통합 PR을 생성합니다. 병합 후 평가는 부모에서 수행합니다.",
              },
            },
          ]
        : input.result.pullRequest || verifiedNoChange(input.result)
          ? [
              finishTransition(
                input,
                input.result.pullRequest
                  ? workspace.workflow.integrationPendingStatus
                  : workspace.workflow.implementationCompleteStatus,
              ),
            ]
          : [
              {
                kind: "add-label" as const,
                params: { label: input.config.reporting.failureLabel },
              },
              {
                kind: "comment" as const,
                params: {
                  body: "완료 보류: 변경된 코드의 PR 또는 변경이 필요 없는 작업의 검증 근거가 없습니다. 결과를 확인하고 다시 AI 구현으로 옮기세요.",
                },
              },
            ]),
  ]);
}
