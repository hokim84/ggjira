import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { JiraApiError, StatusNotReachableError, TransitionNotFoundError } from "../jira/client.js";
import type { JiraGateway } from "../jira/gateway.js";
import type { JiraIssue } from "../jira/types.js";
import {
  PLAN_PROPERTY_KEY,
  PLAN_TASK_PROPERTY_KEY,
  PlanMetadataError,
  readPlanTaskMetadata,
} from "../pm/metadata.js";
import { PlanApplyError, renderParentPlan, renderTaskDescription } from "../pm/plan-render.js";
import { computeApprovalId, computeDelegationApprovalIds } from "./approval.js";
import { COMMENT_TEXT } from "./comment-text.js";
import {
  listAttentionItems,
  normalizeCause,
  recordAttention,
  resolveAttentionItem,
} from "./db/attention.js";
import {
  type ReportStepRow,
  type ReportStepStatus,
  getReportStep,
  isReportStepBlocked,
  isReportStepSettled,
  listBlockedReportSteps,
  listJobIdsWithReportWork,
  listJobReportSteps,
  updateReportStep,
} from "./db/report-steps.js";
import type {
  CommentParams,
  CreateSubtaskParams,
  FailureLogParams,
  LabelParams,
  ParentPlanParams,
  PlanCommentParams,
  PlanPropertyParams,
  RestampKeptParams,
  StampTaskParams,
  SupersedeParams,
  TransitionParams,
} from "./report-journal.js";
import { parseTaskApprovalId } from "./report-journal.js";

/**
 * Executes the report journal (src/router/report-journal.ts) against Jira
 * (docs/router-service-implementation-plan.md §3 "실행 결과와 Jira 반영 분리"). Every step re-reads
 * Jira before writing, so running a step twice never writes twice:
 *
 * - comments and created subtasks carry a marker unique to the step, looked up before writing;
 * - transitions re-check the current status and the job's approval, and never override a status
 *   a human set (§3 "성공 보고가 늦게 도착하더라도 사람이 바꾼 상태를 덮어쓰지 않는다");
 * - labels, descriptions and issue properties are set-to-value writes.
 *
 * A write whose outcome is unknown (network error, 5xx) leaves the step `uncertain`; the next pass
 * re-reads to settle it. Only a subtask creation cannot always be settled that way — Jira search
 * is eventually consistent — so an unconfirmed create goes to `recovery_required` and waits for an
 * admin retry rather than being re-sent blindly (§3 "확인할 수 없는 생성·전이 요청은 무작정
 * 재전송하지 않고 recovery_required로 보류한다"). A request Jira definitively rejected (4xx, an
 * unreachable status) goes to `failed`. Either one blocks the rest of its batch.
 */

export interface ReportProcessorDeps {
  db: Database.Database;
  jira: JiraGateway;
  now: () => string;
}

export interface ReportPassReport {
  applied: string[];
  skipped: Array<{ stepId: string; reason: string }>;
  /** Went to `failed` or `recovery_required` this pass. */
  blocked: Array<{ stepId: string; status: ReportStepStatus; reason: string }>;
  /** Left `pending`/`uncertain` for the next pass (Jira unreachable, rate limited, ...). */
  deferred: Array<{ stepId: string; reason: string }>;
}

type StepOutcome =
  | { status: "applied"; outcome?: Record<string, unknown> }
  | { status: "skipped"; reason: string }
  | { status: "recovery_required"; reason: string };

/** A write threw. `definitive` means Jira rejected it, so it certainly did not happen. */
class WriteError extends Error {
  constructor(
    readonly definitive: boolean,
    readonly retryLater: boolean,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "WriteError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDefinitiveRejection(error: unknown): boolean {
  if (error instanceof StatusNotReachableError || error instanceof TransitionNotFoundError) {
    return true;
  }
  return (
    error instanceof JiraApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  );
}

async function write<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    // 429 is a rejection too, but a temporary one: nothing was written, try again later.
    const rateLimited = error instanceof JiraApiError && error.status === 429;
    throw new WriteError(isDefinitiveRejection(error), rateLimited, error);
  }
}

function markerFor(step: ReportStepRow): string {
  return `[GGJIRA:REPORT:${step.id}]`;
}

/** Outcomes of earlier steps in the same batch, keyed by `taskId` for created subtasks. */
interface BatchContext {
  createdKeys: Map<string, string>;
  keptTaskIds: string[];
}

function batchContext(steps: readonly ReportStepRow[], batchId: string): BatchContext {
  const createdKeys = new Map<string, string>();
  const keptTaskIds: string[] = [];
  for (const step of steps) {
    if (step.batchId !== batchId || step.status !== "applied" || !step.outcome) continue;
    if (step.kind === "create-subtask") {
      createdKeys.set(step.outcome.taskId as string, step.outcome.key as string);
    }
    if (step.kind === "restamp-kept" && typeof step.outcome.taskId === "string") {
      keptTaskIds.push(step.outcome.taskId);
    }
  }
  return { createdKeys, keptTaskIds };
}

async function addCommentOnce(
  jira: JiraGateway,
  issueKey: string,
  marker: string,
  body: string,
): Promise<StepOutcome> {
  const comments = await jira.getComments(issueKey);
  if (comments.some((comment) => comment.body.includes(marker))) return { status: "applied" };
  await write(() => jira.addComment(issueKey, `${marker}\n${body}`));
  return { status: "applied" };
}

/** A local file, not Jira: rewriting it is harmless, so a replay just writes it again. A log that
 *  cannot be written does not hold up the comment; the step says why it was skipped. */
function writeFailureLog(params: FailureLogParams): StepOutcome {
  try {
    mkdirSync(path.dirname(params.path), { recursive: true });
    writeFileSync(params.path, params.body, "utf-8");
    return { status: "applied" };
  } catch (error) {
    return { status: "skipped", reason: `cannot write ${params.path}: ${errorMessage(error)}` };
  }
}

async function runTransition(
  jira: JiraGateway,
  step: ReportStepRow,
  params: TransitionParams,
): Promise<StepOutcome> {
  if (Object.hasOwn(params, "optInLabel")) {
    return {
      status: "skipped",
      reason: "obsolete label authorization; reconcile manually before retrying",
    };
  }
  const issue = await jira.getIssue(params.issueKey ?? step.issueKey);
  if (issue.statusName === params.to) return { status: "applied" };
  if (!params.from.includes(issue.statusName)) {
    return {
      status: "skipped",
      reason: `${issue.key} is in "${issue.statusName}", not ${params.from.map((s) => `"${s}"`).join(" or ")}; a human moved it`,
    };
  }
  if (!(await approvalStillStands(jira, issue, params))) {
    return { status: "skipped", reason: `${issue.key} was re-approved since this job was created` };
  }
  await write(() => jira.transitionIssueToStatus(issue.key, params.to));
  return { status: "applied" };
}

/** Re-derives the approval a transition was journaled under, by the rule it was journaled with
 *  (ADR 0044's rules for implementations; the status entry for a plan). */
async function approvalStillStands(
  jira: JiraGateway,
  issue: JiraIssue,
  params: TransitionParams,
): Promise<boolean> {
  const rule = params.approvalRule;
  if (rule?.kind === "plan-approval") {
    const parent = rule.issueKey === issue.key ? issue : await jira.getIssue(rule.issueKey);
    const { planApprovalId } = await computeDelegationApprovalIds(jira, parent, rule);
    return planApprovalId !== null && planApprovalOf(params.approvalId) === planApprovalId;
  }
  if (rule?.kind === "plan-task") {
    const run = parseTaskApprovalId(params.approvalId);
    if (!run) return false;
    return (await computeApprovalId(jira, issue, rule.inProgressStatus)) === run.entryId;
  }
  const approvalId = await computeApprovalId(jira, issue, params.approvalStatus);
  return approvalId === params.approvalId;
}

/** The plan approval inside a task run's approval id, or the id itself for the plan's own. */
function planApprovalOf(approvalId: string): string {
  return parseTaskApprovalId(approvalId)?.planApprovalId ?? approvalId;
}

/** Finds a subtask created by `step` (its marker is in the description). */
async function findCreatedSubtask(
  jira: JiraGateway,
  parentKey: string,
  marker: string,
): Promise<JiraIssue | undefined> {
  const subtasks = await jira.searchIssues(`parent = "${parentKey}"`, { all: true });
  return subtasks.find((issue) => issue.description?.includes(marker));
}

/** Puts the marker first: anything after the last heading would be parsed as an item of that
 *  section (src/profile/description.ts), turning the marker into a "required capability". */
function withMarker(description: string, marker: string): string {
  return `{noformat}${marker}{noformat}\n\n${description}`;
}

async function runCreateSubtask(
  jira: JiraGateway,
  step: ReportStepRow,
  params: CreateSubtaskParams,
): Promise<StepOutcome> {
  const marker = markerFor(step);
  const existing = await findCreatedSubtask(jira, params.parentKey, marker);
  if (existing) return { status: "applied", outcome: { taskId: params.taskId, key: existing.key } };
  if (step.status === "uncertain") {
    // The create may have happened and just not be searchable yet. Re-sending could duplicate it.
    return {
      status: "recovery_required",
      reason: `could not confirm whether subtask "${params.summary}" was created; check ${params.parentKey}'s subtasks, then retry the report`,
    };
  }
  const { key } = await write(() =>
    jira.createIssue({
      projectKey: params.projectKey,
      issueTypeName: params.issueTypeName,
      summary: params.summary,
      description: withMarker(params.description, marker),
      parentKey: params.parentKey,
      ...(params.assigneeAccountId ? { assigneeAccountId: params.assigneeAccountId } : {}),
    }),
  );
  return { status: "applied", outcome: { taskId: params.taskId, key } };
}

async function runStampTask(
  jira: JiraGateway,
  ctx: BatchContext,
  params: StampTaskParams,
): Promise<StepOutcome> {
  const key = ctx.createdKeys.get(params.taskId);
  if (!key) throw new PlanApplyError(`no created subtask recorded for taskId ${params.taskId}`);
  const originalDependencies = params.task.dependencies ?? [];
  const dependencies = originalDependencies.map(
    (dependency) => ctx.createdKeys.get(dependency) ?? dependency,
  );
  if (dependencies.join("\n") !== originalDependencies.join("\n")) {
    const issue = await jira.getIssue(key);
    const marker = issue.description?.match(
      /\{noformat\}(\[GGJIRA:REPORT:[^\]]+\])\{noformat\}/,
    )?.[1];
    const description = renderTaskDescription({ ...params.task, dependencies });
    await write(() =>
      jira.updateIssueDescription(key, marker ? withMarker(description, marker) : description),
    );
  }
  await write(() =>
    jira.setIssueProperty(key, PLAN_TASK_PROPERTY_KEY, {
      planVersion: params.planVersion,
      taskId: params.taskId,
      parentKey: params.parentKey,
      workspaceId: params.workspaceId,
      dependencies,
    }),
  );
  return { status: "applied", outcome: { key } };
}

async function runRestampKept(jira: JiraGateway, params: RestampKeptParams): Promise<StepOutcome> {
  let existing: Awaited<ReturnType<typeof readPlanTaskMetadata>>;
  try {
    existing = await readPlanTaskMetadata(jira, params.issueKey);
  } catch (error) {
    if (error instanceof PlanMetadataError) return { status: "skipped", reason: error.message };
    throw error;
  }
  if (!existing) {
    return { status: "skipped", reason: `${params.issueKey} is not a plan-tracked task` };
  }
  // A kept task's metadata still names the old plan version; without this it would fail the
  // plan-version check once the parent's plan property moves on (src/router/issue-check.ts).
  await write(() =>
    jira.setIssueProperty(params.issueKey, PLAN_TASK_PROPERTY_KEY, {
      ...existing,
      planVersion: params.planVersion,
      parentKey: params.parentKey,
    }),
  );
  return { status: "applied", outcome: { taskId: existing.taskId } };
}

async function runSupersede(
  jira: JiraGateway,
  step: ReportStepRow,
  params: SupersedeParams,
): Promise<StepOutcome> {
  const issue = await jira.getIssue(params.issueKey);
  if (params.startedStatuses.includes(issue.statusName)) {
    return { status: "skipped", reason: `${issue.key} already started ("${issue.statusName}")` };
  }
  // A step journaled before ADR 0048 carries no comment of its own.
  await addCommentOnce(
    jira,
    issue.key,
    markerFor(step),
    params.comment ?? COMMENT_TEXT.en.plan.superseded,
  );
  if (!issue.labels.includes(params.label)) {
    await write(() => jira.addLabel(issue.key, params.label));
  }
  return { status: "applied" };
}

async function runStep(
  jira: JiraGateway,
  step: ReportStepRow,
  ctx: BatchContext,
): Promise<StepOutcome> {
  switch (step.kind) {
    case "transition":
      return runTransition(jira, step, step.params as unknown as TransitionParams);
    case "comment": {
      const params = step.params as unknown as CommentParams;
      return addCommentOnce(jira, params.issueKey ?? step.issueKey, markerFor(step), params.body);
    }
    case "add-label": {
      const { label } = step.params as unknown as LabelParams;
      const issue = await jira.getIssue(step.issueKey);
      if (!issue.labels.includes(label)) await write(() => jira.addLabel(issue.key, label));
      return { status: "applied" };
    }
    case "remove-label": {
      const { label } = step.params as unknown as LabelParams;
      const issue = await jira.getIssue(step.issueKey);
      if (issue.labels.includes(label)) await write(() => jira.removeLabel(issue.key, label));
      return { status: "applied" };
    }
    case "parent-plan": {
      const { plan } = step.params as unknown as ParentPlanParams;
      const issue = await jira.getIssue(step.issueKey);
      const description = renderParentPlan(issue, plan);
      if (description !== (issue.description ?? "")) {
        await write(() => jira.updateIssueDescription(issue.key, description));
      }
      return { status: "applied" };
    }
    case "create-subtask":
      return runCreateSubtask(jira, step, step.params as unknown as CreateSubtaskParams);
    case "stamp-task":
      return runStampTask(jira, ctx, step.params as unknown as StampTaskParams);
    case "restamp-kept":
      return runRestampKept(jira, step.params as unknown as RestampKeptParams);
    case "plan-property": {
      const params = step.params as unknown as PlanPropertyParams;
      await write(() =>
        jira.setIssueProperty(step.issueKey, PLAN_PROPERTY_KEY, {
          version: params.version,
          taskIds: [...params.taskIds, ...ctx.keptTaskIds],
          ...(params.decisionId ? { decisionId: params.decisionId } : {}),
        }),
      );
      return { status: "applied" };
    }
    case "supersede":
      return runSupersede(jira, step, step.params as unknown as SupersedeParams);
    case "failure-log":
      return writeFailureLog(step.params as unknown as FailureLogParams);
    case "plan-comment": {
      const params = step.params as unknown as PlanCommentParams;
      const created = [...ctx.createdKeys.values()];
      // A step journaled before ADR 0048 carries no language: it was written in English.
      const text = (COMMENT_TEXT[params.language] ?? COMMENT_TEXT.en).plan;
      const body = [
        text.applied,
        "",
        text.summary,
        params.summary,
        ...(created.length > 0
          ? ["", text.createdSubtasks, ...created.map((key) => `- ${key}`)]
          : []),
        ...(params.next?.length ? ["", ...params.next] : []),
        "",
        params.signature,
      ].join("\n");
      return addCommentOnce(jira, step.issueKey, markerFor(step), body);
    }
    default:
      throw new PlanApplyError(`unknown report step kind "${step.kind}"`);
  }
}

/**
 * Runs every job's journal forward as far as Jira allows. Steps of one job run strictly in
 * order; a step that cannot finish now stops that job for this pass, and a blocked step
 * (`failed`/`recovery_required`) holds back the rest of its batch but not later batches — a
 * failed start move must not keep the run's result from being reported.
 */
/** M4-09: a step that went to `failed`/`recovery_required` is something an admin must act on. */
function recordBlockedStep(deps: ReportProcessorDeps, step: ReportStepRow, reason: string): void {
  recordAttention(deps.db, {
    issueKey: step.issueKey,
    approvalId: null,
    kind: "report_blocked",
    cause: `${step.batchId}:${step.kind}`,
    severity: "immediate",
    reason: "Router could not apply a Jira update; `router reports retry` after fixing the cause",
    evidence: { batchId: step.batchId, step: step.kind, error: normalizeCause(reason) },
    now: deps.now(),
  });
}

/** Settles blocked-report items whose batch has nothing blocked any more (retried and applied). */
function settleClearedReports(deps: ReportProcessorDeps): void {
  const blocked = new Set(listBlockedReportSteps(deps.db).map((step) => step.batchId));
  for (const item of listAttentionItems(deps.db, { status: "open", kind: "report_blocked" })) {
    const batchId = (item.evidence as { batchId?: string } | null)?.batchId;
    if (batchId && !blocked.has(batchId)) {
      resolveAttentionItem(
        deps.db,
        item.id,
        "the Jira update was applied after a retry",
        deps.now(),
      );
    }
  }
}

export async function processReportJournal(deps: ReportProcessorDeps): Promise<ReportPassReport> {
  const report: ReportPassReport = { applied: [], skipped: [], blocked: [], deferred: [] };
  try {
    await runReportJournal(deps, report);
  } finally {
    for (const entry of report.blocked) {
      const step = getReportStep(deps.db, entry.stepId);
      if (step) recordBlockedStep(deps, step, entry.reason);
    }
    settleClearedReports(deps);
  }
  return report;
}

async function runReportJournal(
  deps: ReportProcessorDeps,
  report: ReportPassReport,
): Promise<void> {
  for (const jobId of listJobIdsWithReportWork(deps.db)) {
    const steps = listJobReportSteps(deps.db, jobId);
    const blockedBatches = new Set<string>();
    for (const step of steps) {
      if (isReportStepSettled(step.status)) continue;
      if (isReportStepBlocked(step.status) || blockedBatches.has(step.batchId)) {
        blockedBatches.add(step.batchId);
        continue;
      }

      // Re-read so outcomes applied earlier in this same pass are visible.
      const ctx = batchContext(listJobReportSteps(deps.db, jobId), step.batchId);
      let outcome: StepOutcome;
      try {
        outcome = await runStep(deps.jira, step, ctx);
      } catch (error) {
        const message = errorMessage(error);
        if (error instanceof WriteError && error.definitive) {
          updateReportStep(deps.db, step.id, {
            status: "failed",
            error: message,
            countTry: true,
            now: deps.now(),
          });
          report.blocked.push({ stepId: step.id, status: "failed", reason: message });
          blockedBatches.add(step.batchId);
          continue;
        }
        if (error instanceof PlanApplyError || isDefinitiveRejection(error)) {
          // Nothing was written (a read was refused, or the journal itself is inconsistent).
          updateReportStep(deps.db, step.id, {
            status: "failed",
            error: message,
            countTry: true,
            now: deps.now(),
          });
          report.blocked.push({ stepId: step.id, status: "failed", reason: message });
          blockedBatches.add(step.batchId);
          continue;
        }
        const uncertain = error instanceof WriteError && !error.retryLater;
        updateReportStep(deps.db, step.id, {
          status: uncertain ? "uncertain" : step.status,
          error: message,
          countTry: true,
          now: deps.now(),
        });
        report.deferred.push({ stepId: step.id, reason: message });
        break;
      }

      if (outcome.status === "recovery_required") {
        updateReportStep(deps.db, step.id, {
          status: "recovery_required",
          error: outcome.reason,
          countTry: true,
          now: deps.now(),
        });
        report.blocked.push({
          stepId: step.id,
          status: "recovery_required",
          reason: outcome.reason,
        });
        blockedBatches.add(step.batchId);
        continue;
      }
      updateReportStep(deps.db, step.id, {
        status: outcome.status,
        outcome: outcome.status === "applied" ? (outcome.outcome ?? null) : null,
        error: outcome.status === "skipped" ? outcome.reason : null,
        countTry: true,
        now: deps.now(),
      });
      if (outcome.status === "applied") report.applied.push(step.id);
      else report.skipped.push({ stepId: step.id, reason: outcome.reason });
    }
  }
}
