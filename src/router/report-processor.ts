import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RouterDatabase } from "./db/connection.js";
import { JiraApiError, StatusNotReachableError, TransitionNotFoundError } from "../jira/client.js";
import type { JiraGateway } from "../jira/gateway.js";
import type { JiraIssue } from "../jira/types.js";
import {
  PLAN_PROPERTY_KEY,
  PLAN_TASK_PROPERTY_KEY,
  PlanMetadataError,
  PlanMetadataSchema,
  readPlanTaskMetadata,
} from "../pm/metadata.js";
import {
  PLAN_END,
  PLAN_START,
  PlanApplyError,
  renderParentPlan,
  renderTaskDescription,
} from "../pm/plan-render.js";
import { computeApprovalId, computeDelegationApprovalIds, computeInputHash } from "./approval.js";
import { COMMENT_TEXT } from "./comment-text.js";
import { getApproval } from "./db/approvals.js";
import {
  listAttentionItems,
  normalizeCause,
  recordAttention,
  resolveAttentionItem,
} from "./db/attention.js";
import { getJob } from "./db/jobs.js";
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
import type { ApprovalSnapshot } from "./issue-check.js";
import { integrationEvidence } from "./lifecycle.js";
import { assemblyContext } from "./assembly.js";
import {
  latestPlanningRequest,
  markReadyPlans,
  planningFingerprint,
  syncPlanningRequest,
} from "./planning-requests.js";
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
import { checkContext, checkSource } from "./workflow-checks.js";

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
  db: RouterDatabase;
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
  keptKeys: Map<string, string>;
}

function batchContext(steps: readonly ReportStepRow[], batchId: string): BatchContext {
  const createdKeys = new Map<string, string>();
  const keptTaskIds: string[] = [];
  const keptKeys = new Map<string, string>();
  for (const step of steps) {
    if (step.batchId !== batchId || step.status !== "applied" || !step.outcome) continue;
    if (step.kind === "create-subtask") {
      createdKeys.set(step.outcome.taskId as string, step.outcome.key as string);
    }
    if (step.kind === "restamp-kept" && typeof step.outcome.taskId === "string") {
      keptTaskIds.push(step.outcome.taskId);
      keptKeys.set(step.outcome.taskId, step.params.issueKey as string);
    }
  }
  return { createdKeys, keptTaskIds, keptKeys };
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
  db: RouterDatabase,
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
  if (issue.statusName === params.to) {
    if (params.parentProgress && (await approvalStillStands(jira, db, issue, params)))
      db.prepare("INSERT OR REPLACE INTO parent_progress_entries VALUES (?,?)").run(
        issue.key,
        await computeApprovalId(jira, issue, params.to),
      );
    return { status: "applied" };
  }
  if (!params.from.includes(issue.statusName)) {
    return {
      status: "skipped",
      reason: `${issue.key} is in "${issue.statusName}", not ${params.from.map((s) => `"${s}"`).join(" or ")}; a human moved it`,
    };
  }
  if (!(await approvalStillStands(jira, db, issue, params))) {
    return { status: "skipped", reason: `${issue.key} was re-approved since this job was created` };
  }
  await write(() => jira.transitionIssueToStatus(issue.key, params.to));
  if (params.parentProgress)
    db.prepare("INSERT OR REPLACE INTO parent_progress_entries VALUES (?,?)").run(
      issue.key,
      await computeApprovalId(jira, issue, params.to),
    );
  return { status: "applied" };
}

/** Re-derives the approval a transition was journaled under, by the rule it was journaled with
 *  (ADR 0044's rules for implementations; the status entry for a plan). */
async function approvalStillStands(
  jira: JiraGateway,
  db: RouterDatabase,
  issue: JiraIssue,
  params: TransitionParams,
): Promise<boolean> {
  const rule = params.approvalRule;
  if (rule?.kind === "parent-stage") {
    const request = latestPlanningRequest(db, issue.key);
    return (
      !!issue.assigneeAccountId &&
      request?.id === rule.requestId &&
      request.input_hash === rule.inputHash &&
      planningFingerprint(issue) === rule.inputHash
    );
  }
  if (rule?.kind === "workflow-job") {
    const job = getJob(db, rule.jobId);
    const approval = getApproval(db, issue.key);
    if (
      !job ||
      !approval ||
      !issue.assigneeAccountId ||
      approval.approvalId !== job.approvalId ||
      approval.inputHash !== rule.inputHash
    )
      return false;
    const snapshot = approval.inputSnapshot as ApprovalSnapshot;
    if (job.kind === "assemble_pr") {
      if (!rule.workspace || !snapshot.assembly) return false;
      const current = await assemblyContext(
        db,
        jira,
        rule.workspace,
        issue,
        snapshot.assembly.baseBranch,
      );
      return current?.cycleId === snapshot.assembly.cycleId;
    }
    if (
      computeInputHash({
        kind: job.kind,
        issue,
        requirements: snapshot.requirements,
        planTask: snapshot.planTask,
      }) !== rule.inputHash
    )
      return false;
    if (
      (job.kind === "integration_check" || job.kind === "quality_review") &&
      rule.workspace &&
      snapshot.quality
    ) {
      const context = await checkContext(
        db,
        jira,
        {
          repositories: [
            {
              id: rule.workspace.repositoryId,
              baseBranch: snapshot.quality.integration.baseBranch,
            },
          ],
        },
        rule.workspace,
        issue,
        job.kind === "quality_review",
      );
      if (!context || checkSource(context) !== checkSource(snapshot.quality)) return false;
    }
    if (job.kind === "planning") {
      const request = latestPlanningRequest(db, issue.key);
      return request?.id === job.approvalId && request.input_hash === planningFingerprint(issue);
    }
    const entry = await computeApprovalId(jira, issue, params.approvalStatus);
    const expected =
      parseTaskApprovalId(job.approvalId)?.entryId ??
      job.approvalId.replace(/^(implementation|integration_check|quality_review):/, "");
    return expected.split(":retry:")[0]?.split(":source:")[0] === entry;
  }
  if (rule) return false;
  const approvalId = await computeApprovalId(jira, issue, params.approvalStatus);
  return approvalId === params.approvalId;
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
 *  section (src/profile/description.ts), turning the marker into a contract item. */
function withMarker(description: string, marker: string): string {
  return `{noformat}${marker}{noformat}\n\n${description}`;
}

async function runCreateSubtask(
  jira: JiraGateway,
  step: ReportStepRow,
  params: CreateSubtaskParams,
): Promise<StepOutcome> {
  const marker = markerFor(step);
  const existing = params.standalone
    ? (await jira.searchIssues(`project = "${params.projectKey}"`, { all: true })).find((issue) =>
        issue.description?.includes(marker),
      )
    : await findCreatedSubtask(jira, params.parentKey, marker);
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
      ...(params.standalone ? {} : { parentKey: params.parentKey }),
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
  db: RouterDatabase,
  step: ReportStepRow,
  ctx: BatchContext,
): Promise<StepOutcome> {
  switch (step.kind) {
    case "children-ready": {
      const { version, inProgressStatus } = step.params as {
        version: string;
        inProgressStatus: string;
      };
      const plan = PlanMetadataSchema.parse(
        await jira.getIssueProperty(step.issueKey, PLAN_PROPERTY_KEY),
      );
      if (plan.version !== version) throw new PlanApplyError("child publication plan changed");
      const keys = new Map([...ctx.createdKeys, ...ctx.keptKeys]);
      const baselines: Array<{ taskId: string; entry: string }> = [];
      for (const taskId of plan.taskIds) {
        if (
          db
            .prepare(
              "SELECT 1 FROM child_approval_baselines WHERE parent_key=? AND plan_version=? AND task_id=?",
            )
            .get(step.issueKey, version, taskId)
        )
          continue;
        const key = keys.get(taskId);
        if (!key) throw new PlanApplyError(`no published child recorded for taskId ${taskId}`);
        // Jira search is eventually consistent. A successful creation's durable key is authoritative.
        const child = await jira.getIssue(key);
        const metadata = await readPlanTaskMetadata(jira, key);
        if (
          !metadata ||
          metadata.planVersion !== version ||
          metadata.taskId !== taskId ||
          metadata.parentKey !== step.issueKey
        )
          throw new PlanApplyError(`child contract is not published for ${key}`);
        const entry = await computeApprovalId(jira, child, inProgressStatus);
        baselines.push({ taskId, entry });
      }
      db.transaction(() => {
        for (const { taskId, entry } of baselines)
          db.prepare("INSERT OR IGNORE INTO child_approval_baselines VALUES (?,?,?,?)").run(
            step.issueKey,
            version,
            taskId,
            entry,
          );
      })();
      return { status: "applied" };
    }
    case "lifecycle-summary": {
      const issue = await jira.getIssue(step.issueKey);
      const description = issue.description ?? "";
      const start = description.indexOf(PLAN_START);
      const end = description.indexOf(PLAN_END);
      if (start < 0 || end < start) return { status: "skipped", reason: "no managed plan block" };
      const block = description
        .slice(start, end)
        .replace(/\n진행 상황: [^\n]*/g, "")
        .trimEnd();
      const updated = `${description.slice(0, start)}${block}\n진행 상황: ${step.params.summary}\n${description.slice(end)}`;
      if (updated !== description)
        await write(() => jira.updateIssueDescription(issue.key, updated));
      return { status: "applied" };
    }
    case "transition":
      return runTransition(jira, db, step, step.params as unknown as TransitionParams);
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
    case "extend-plan": {
      const params = step.params as { taskId: string; version: string; deploymentId: number };
      const property = PlanMetadataSchema.parse(
        await jira.getIssueProperty(step.issueKey, PLAN_PROPERTY_KEY),
      );
      if (property.version !== params.version)
        return { status: "skipped", reason: "plan version changed" };
      const taskIds = [...new Set([...property.taskIds, params.taskId])];
      await write(() =>
        jira.setIssueProperty(step.issueKey, PLAN_PROPERTY_KEY, { ...property, taskIds }),
      );
      db.prepare("UPDATE plan_deployments SET task_ids=? WHERE id=? AND state='active'").run(
        JSON.stringify(taskIds),
        params.deploymentId,
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
    await markReadyPlans(deps.db, deps.jira);
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
        const job = getJob(deps.db, jobId);
        if (
          job &&
          job.kind !== "planning" &&
          step.resultId !== null &&
          step.batchId === step.resultId
        ) {
          const input = deps.db
            .prepare("SELECT snapshot FROM job_inputs WHERE job_id=?")
            .get(job.id) as { snapshot: string } | undefined;
          if (input) {
            const snapshot = JSON.parse(input.snapshot) as ApprovalSnapshot;
            const issue = await deps.jira.getIssue(job.issueKey);
            const transition =
              step.kind === "transition" ? (step.params as unknown as TransitionParams) : undefined;
            const batchTransition = steps.find(
              (s) => s.batchId === step.batchId && s.kind === "transition",
            )?.params as unknown as TransitionParams | undefined;
            const rule = transition?.approvalRule ?? batchTransition?.approvalRule;
            const fresh =
              issue.statusName === snapshot.issue.statusName &&
              (await approvalStillStands(deps.jira, deps.db, issue, {
                to: issue.statusName,
                from: [issue.statusName],
                approvalStatus: snapshot.issue.statusName,
                approvalId: job.approvalId,
                approvalRule: {
                  kind: "workflow-job",
                  jobId: job.id,
                  inputHash: job.inputHash,
                  ...(rule?.kind === "workflow-job" && rule.workspace
                    ? { workspace: rule.workspace }
                    : {}),
                },
              }));
            if (!fresh && issue.statusName !== transition?.to) {
              updateReportStep(deps.db, step.id, {
                status: "skipped",
                error: "superseded result or a human moved it",
                now: deps.now(),
              });
              report.skipped.push({
                stepId: step.id,
                reason: "superseded result or a human moved it",
              });
              continue;
            }
          }
        }
        if (
          job?.kind === "planning" &&
          job.approvalId.startsWith("planning:") &&
          (step.resultId !== null || step.batchId.startsWith("start:"))
        ) {
          const issue = await deps.jira.getIssue(job.issueKey);
          const previous = latestPlanningRequest(deps.db, job.issueKey);
          const snapshot = previous
            ? (JSON.parse(previous.input_snapshot) as {
                statusName?: string;
                planningInProgressStatus?: string;
              })
            : null;
          const requestStatus = snapshot?.statusName;
          const request =
            requestStatus &&
            [requestStatus, snapshot?.planningInProgressStatus].includes(issue.statusName)
              ? await syncPlanningRequest(
                  deps.db,
                  deps.jira,
                  issue,
                  requestStatus,
                  deps.now(),
                  snapshot?.planningInProgressStatus,
                )
              : undefined;
          if (
            !request ||
            request.id !== job.approvalId ||
            request.input_hash !== planningFingerprint(issue)
          ) {
            updateReportStep(deps.db, step.id, {
              status: "skipped",
              error: "superseded or withdrawn planning request",
              now: deps.now(),
            });
            report.skipped.push({
              stepId: step.id,
              reason: "superseded or withdrawn planning request",
            });
            continue;
          }
        }
        outcome = await runStep(deps.jira, deps.db, step, ctx);
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
