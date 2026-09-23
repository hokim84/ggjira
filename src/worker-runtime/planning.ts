import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { JobEnvelope } from "../contracts/envelope.js";
import { PLAN_JSON_SCHEMA, parsePlan } from "../pm/plan.js";
import { buildPlanningPrompt } from "../pm/prompt.js";
import type { WorkerProvider, WorkerResult } from "../worker/provider.js";
import { createWorktree, isGitRepository } from "../worker/worktree.js";
import type { WorkerRepositoryConfig } from "./config.js";
import type { ExecutionOutcome } from "./executor.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs one planning envelope (§4 "PM 모델 호출·계획 파싱 → Worker에서 수행하고 구조화 결과 반환"):
 * the PM model reads the repository read-only and answers with a Plan, which goes back to Router
 * as structured data. The worker never writes the plan to Jira — Router's report journal does
 * (src/router/report-journal.ts). Everything the prompt needs arrives in the envelope, so this
 * path needs no Jira access either.
 */
export async function executePlanningEnvelope(
  envelope: JobEnvelope,
  deps: {
    repository: WorkerRepositoryConfig;
    provider: WorkerProvider;
    worktreesRoot: string;
    logPath: string;
    signal: AbortSignal;
  },
): Promise<ExecutionOutcome> {
  const issue = envelope.issueSnapshot;
  const context = envelope.planningContext ?? { comments: [], existingSubtasks: [] };

  // A throwaway worktree keeps the model reading the base branch rather than whatever is
  // checked out in the shared repository; planning never commits, so the branch stays empty.
  let cwd = deps.repository.path;
  if (await isGitRepository(deps.repository.path)) {
    const branch = `ggjira-pm/${issue.key}-${envelope.attemptId.slice(0, 8)}`;
    try {
      cwd = (
        await createWorktree(
          deps.repository.path,
          deps.repository.baseBranch,
          branch,
          deps.worktreesRoot,
        )
      ).path;
    } catch (error) {
      return {
        status: "failed",
        summary: "Could not create a git worktree for planning.",
        failureReason: errorMessage(error),
      };
    }
  }

  mkdirSync(deps.logPath, { recursive: true });
  const logFile = path.join(deps.logPath, `${envelope.jobId}-${envelope.attemptId}.jsonl`);

  let workerResult: WorkerResult;
  try {
    workerResult = await deps.provider.run(
      {
        prompt: buildPlanningPrompt({
          issue,
          comments: context.comments,
          existingSubtasks: context.existingSubtasks,
          ...(context.humanDecision ? { humanDecision: context.humanDecision } : {}),
        }),
        cwd,
        timeoutMs: envelope.timeoutMs,
        systemPrompt: envelope.systemPrompt,
        outputSchema: PLAN_JSON_SCHEMA,
        readOnly: true,
      },
      { signal: deps.signal, onEvent: (line) => appendFileSync(logFile, `${line}\n`) },
    );
  } catch (error) {
    return { status: "failed", summary: "Provider crashed.", failureReason: errorMessage(error) };
  }

  if (deps.signal.aborted) {
    return {
      status: "cancelled",
      summary: "Stopped: Router asked to cancel or the lease was lost.",
    };
  }
  if (workerResult.exitReason !== "completed" || workerResult.isError) {
    return {
      status: "failed",
      summary: workerResult.summary,
      failureReason: workerResult.summary,
      timedOut: workerResult.exitReason === "timeout",
    };
  }

  let plan: ReturnType<typeof parsePlan>;
  try {
    plan = parsePlan(workerResult.structuredOutput, workerResult.summary);
  } catch (error) {
    return {
      status: "failed",
      summary: "The PM model's plan output could not be parsed.",
      failureReason: errorMessage(error),
    };
  }

  return {
    status: plan.needsDecision ? "needs_decision" : "planned",
    summary: plan.summary,
    plan,
  };
}
