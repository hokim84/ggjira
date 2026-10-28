import type { RouterDatabase } from "./connection.js";
import type { ExecutionRecord } from "../../contracts/execution.js";

/**
 * - `none`: the run did what it was asked (succeeded or planned).
 * - `not_applicable`: it stopped for a human (decision, scope) or was cancelled for no reason
 *   Router can name — not a failure to explain.
 * - `requirements_change`: cancelled because the approved request was edited (ADR 0035).
 * - `environment`: the provider timed out, crashed or could not start, or the workspace could not
 *   be prepared.
 * - `unknown`: anything else. Router never calls a failure a code-structure problem on its own;
 *   that judgement needs a human (or a later agent-reported cause, kept with its source).
 */
export type CauseCategory =
  | "none"
  | "not_applicable"
  | "requirements_change"
  | "environment"
  | "unknown";

export type RunType = "initial" | "retry" | "rework";

export interface ExecutionRecordRow {
  resultId: string;
  jobId: string;
  attemptId: string;
  issueKey: string;
  parentIssueKey: string | null;
  kind: string;
  approvalId: string;
  runType: RunType;
  applied: boolean;
  resultStatus: string;
  providerId: string | null;
  providerType: string | null;
  model: string | null;
  modelSource: string | null;
  callId: string | null;
  exitReason: string | null;
  durationMs: number | null;
  numTurns: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  cacheReadIncluded: boolean | null;
  costUsd: number | null;
  usageReported: boolean;
  causeCategory: CauseCategory;
  causeSource: "router" | null;
  recordedAt: string;
}

const nullableNumber = (value: unknown): number | null =>
  typeof value === "number" ? value : null;
const nullableString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

function toRow(row: Record<string, unknown>): ExecutionRecordRow {
  return {
    resultId: row.result_id as string,
    jobId: row.job_id as string,
    attemptId: row.attempt_id as string,
    issueKey: row.issue_key as string,
    parentIssueKey: nullableString(row.parent_issue_key),
    kind: row.kind as string,
    approvalId: row.approval_id as string,
    runType: row.run_type as RunType,
    applied: row.applied === 1,
    resultStatus: row.result_status as string,
    providerId: nullableString(row.provider_id),
    providerType: nullableString(row.provider_type),
    model: nullableString(row.model),
    modelSource: nullableString(row.model_source),
    callId: nullableString(row.call_id),
    exitReason: nullableString(row.exit_reason),
    durationMs: nullableNumber(row.duration_ms),
    numTurns: nullableNumber(row.num_turns),
    inputTokens: nullableNumber(row.input_tokens),
    outputTokens: nullableNumber(row.output_tokens),
    cacheReadTokens: nullableNumber(row.cache_read_tokens),
    cacheCreationTokens: nullableNumber(row.cache_creation_tokens),
    cacheReadIncluded:
      row.cache_read_included === null || row.cache_read_included === undefined
        ? null
        : row.cache_read_included === 1,
    costUsd: nullableNumber(row.cost_usd),
    usageReported: row.usage_reported === 1,
    causeCategory: row.cause_category as CauseCategory,
    causeSource: (nullableString(row.cause_source) as "router" | null) ?? null,
    recordedAt: row.recorded_at as string,
  };
}

/** Stores the record for one result, once: a resent result (same id) inserts nothing. */
export function recordExecution(
  db: RouterDatabase,
  input: {
    resultId: string;
    jobId: string;
    attemptId: string;
    issueKey: string;
    parentIssueKey: string | null;
    kind: string;
    approvalId: string;
    runType: RunType;
    applied: boolean;
    resultStatus: string;
    execution: ExecutionRecord | undefined;
    causeCategory: CauseCategory;
    causeSource: "router" | null;
    now: string;
  },
): boolean {
  const exec = input.execution;
  const usage = exec?.usage;
  const reported =
    usage !== undefined &&
    [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheCreationTokens].some(
      (value) => value !== undefined,
    );
  return (
    db
      .prepare(
        `INSERT OR IGNORE INTO execution_records (
          result_id, job_id, attempt_id, issue_key, parent_issue_key, kind, approval_id, run_type,
          applied, result_status, provider_id, provider_type, model, model_source, call_id,
          exit_reason, duration_ms, num_turns, input_tokens, output_tokens, cache_read_tokens,
          cache_creation_tokens, cache_read_included, cost_usd, usage_reported, cause_category,
          cause_source, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.resultId,
        input.jobId,
        input.attemptId,
        input.issueKey,
        input.parentIssueKey,
        input.kind,
        input.approvalId,
        input.runType,
        input.applied ? 1 : 0,
        input.resultStatus,
        exec?.providerId ?? null,
        exec?.providerType ?? null,
        exec?.model ?? null,
        exec?.modelSource ?? null,
        exec?.callId ?? null,
        exec?.exitReason ?? null,
        exec?.durationMs ?? null,
        exec?.numTurns ?? null,
        usage?.inputTokens ?? null,
        usage?.outputTokens ?? null,
        usage?.cacheReadTokens ?? null,
        usage?.cacheCreationTokens ?? null,
        usage?.cacheReadIncludedInInput === undefined
          ? null
          : usage.cacheReadIncludedInInput
            ? 1
            : 0,
        usage?.costUsd ?? null,
        reported ? 1 : 0,
        input.causeCategory,
        input.causeSource,
        input.now,
      ).changes > 0
  );
}

/** Records for an issue and, with `includeChildren`, for every issue whose original requirement
 *  it is (plan tasks and subtasks), oldest first. */
export function listExecutionRecords(
  db: RouterDatabase,
  filter: { issueKey?: string; includeChildren?: boolean } = {},
): ExecutionRecordRow[] {
  if (!filter.issueKey) {
    return (
      db
        .prepare("SELECT * FROM execution_records ORDER BY recorded_at ASC, rowid ASC")
        .all() as Array<Record<string, unknown>>
    ).map(toRow);
  }
  const sql = filter.includeChildren
    ? "SELECT * FROM execution_records WHERE issue_key = ? OR parent_issue_key = ? ORDER BY recorded_at ASC, rowid ASC"
    : "SELECT * FROM execution_records WHERE issue_key = ? ORDER BY recorded_at ASC, rowid ASC";
  const params = filter.includeChildren ? [filter.issueKey, filter.issueKey] : [filter.issueKey];
  return (db.prepare(sql).all(...params) as Array<Record<string, unknown>>).map(toRow);
}

export interface ExecutionTotals {
  records: number;
  /** Records whose usage the provider did not report; their tokens are unknown, not zero. */
  usageUnreported: number;
  inputTokens: number;
  outputTokens: number;
  /** Cache reads Codex already counted inside `inputTokens` — never add these to it. */
  cacheReadTokensInsideInput: number;
  /** Cache reads Claude Code reported on top of `inputTokens`. */
  cacheReadTokensOnTop: number;
  cacheCreationTokens: number;
  costUsd: number;
  byRunType: Record<RunType, number>;
  byCause: Partial<Record<CauseCategory, number>>;
}

/** Sums only what was reported; `usageUnreported` says how much is missing. */
export function totalExecutions(rows: readonly ExecutionRecordRow[]): ExecutionTotals {
  const totals: ExecutionTotals = {
    records: rows.length,
    usageUnreported: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokensInsideInput: 0,
    cacheReadTokensOnTop: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    byRunType: { initial: 0, retry: 0, rework: 0 },
    byCause: {},
  };
  for (const row of rows) {
    totals.byRunType[row.runType] += 1;
    totals.byCause[row.causeCategory] = (totals.byCause[row.causeCategory] ?? 0) + 1;
    if (!row.usageReported) totals.usageUnreported += 1;
    totals.inputTokens += row.inputTokens ?? 0;
    totals.outputTokens += row.outputTokens ?? 0;
    if (row.cacheReadIncluded) totals.cacheReadTokensInsideInput += row.cacheReadTokens ?? 0;
    else totals.cacheReadTokensOnTop += row.cacheReadTokens ?? 0;
    totals.cacheCreationTokens += row.cacheCreationTokens ?? 0;
    totals.costUsd += row.costUsd ?? 0;
  }
  totals.costUsd = Math.round(totals.costUsd * 1e6) / 1e6;
  return totals;
}
