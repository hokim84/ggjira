import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { JobEnvelope, JobResult } from "../contracts/envelope.js";
import type { WorkerProviderConfig } from "../contracts/provider.js";
import { runValidateCommand } from "../implement/validate.js";
import type { WorkerProvider, WorkerResult } from "../worker/provider.js";
import { buildImplementPrompt } from "../worker/prompt.js";
import {
  changedFilesSince,
  commitAll,
  createWorktree,
  hasUncommittedChanges,
  isGitRepository,
} from "../worker/worktree.js";
import type { WorkerConfig } from "./config.js";

/** A result minus the identifiers the runner stamps on (`resultId`, `jobId`, ...). */
export type ExecutionOutcome = Omit<
  JobResult,
  "protocolVersion" | "jobId" | "attemptId" | "resultId"
>;

export interface ExecutorDeps {
  config: WorkerConfig;
  /** Resolves a local provider entry to a runnable provider. Tests pass a Fake here. */
  createProvider: (provider: WorkerProviderConfig) => WorkerProvider;
  worktreesRoot: string;
  /** Aborted when Router asks to cancel or the lease is lost. */
  signal: AbortSignal;
  /** Router's `jobs/{id}/authorize`; `false` means stop before this side effect. */
  authorize: (stage: "commit" | "validate") => Promise<boolean>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cancelled(summary: string, extra: Partial<ExecutionOutcome> = {}): ExecutionOutcome {
  return { status: "cancelled", summary, ...extra };
}

/**
 * Runs one implementation envelope: worktree → provider → commit → validate. The v5 counterpart
 * of `src/implement/executor.ts`, minus Jira: where that one polled Jira for approval, this asks
 * Router (`authorize`) right before each side effect and stops on `signal`.
 *
 * Everything local is resolved from the worker's own config — the envelope only names a
 * `repositoryId` and `providerId`, and an id this worker doesn't know is refused rather than
 * interpreted (§2 "작업 데이터에 담긴 경로나 명령을 그대로 실행하지 않는다").
 */
export async function executeEnvelope(
  envelope: JobEnvelope,
  deps: ExecutorDeps,
): Promise<ExecutionOutcome> {
  if (envelope.kind !== "implementation") {
    // ADR 0020: planning execution arrives with stage 4's PM context split.
    return {
      status: "failed",
      summary: "This worker does not run planning jobs yet.",
      failureReason: `unsupported job kind "${envelope.kind}"`,
    };
  }

  const repository = deps.config.repositories.find((repo) => repo.id === envelope.repositoryId);
  if (!repository) {
    return {
      status: "failed",
      summary: "Refused: repository is not configured on this worker.",
      failureReason: `unknown repositoryId "${envelope.repositoryId}"`,
    };
  }
  const providerConfig = deps.config.providers.find((entry) => entry.id === envelope.providerId);
  if (!providerConfig) {
    return {
      status: "failed",
      summary: "Refused: provider is not configured on this worker.",
      failureReason: `unknown providerId "${envelope.providerId}"`,
    };
  }

  const issue = envelope.issueSnapshot;
  const gitMode = await isGitRepository(repository.path);
  const branch = gitMode ? `ggjira/${issue.key}-${envelope.attemptId.slice(0, 8)}` : undefined;
  let cwd = repository.path;
  if (branch) {
    try {
      cwd = (
        await createWorktree(repository.path, repository.baseBranch, branch, deps.worktreesRoot)
      ).path;
    } catch (error) {
      return {
        status: "failed",
        summary: "Could not create a git worktree for this job.",
        failureReason: errorMessage(error),
      };
    }
  }
  const withBranch = branch ? { branch } : {};

  mkdirSync(deps.config.logPath, { recursive: true });
  const logFile = path.join(deps.config.logPath, `${envelope.jobId}-${envelope.attemptId}.jsonl`);

  let workerResult: WorkerResult;
  try {
    workerResult = await deps.createProvider(providerConfig).run(
      {
        prompt: buildImplementPrompt({ title: issue.summary, description: issue.description }),
        cwd,
        timeoutMs: envelope.timeoutMs,
        systemPrompt: envelope.systemPrompt,
      },
      { signal: deps.signal, onEvent: (line) => appendFileSync(logFile, `${line}\n`) },
    );
  } catch (error) {
    return {
      status: "failed",
      summary: "Provider crashed.",
      failureReason: errorMessage(error),
      ...withBranch,
    };
  }

  if (deps.signal.aborted)
    return cancelled("Stopped: Router asked to cancel or the lease was lost.", withBranch);

  if (workerResult.exitReason !== "completed" || workerResult.isError) {
    return {
      status: "failed",
      summary: workerResult.summary,
      failureReason: workerResult.summary,
      timedOut: workerResult.exitReason === "timeout",
      ...withBranch,
    };
  }

  let changes: string[] = [];
  if (branch && (await hasUncommittedChanges(cwd))) {
    if (!(await deps.authorize("commit"))) {
      return cancelled("Stopped before commit: Router withdrew execution authority.", withBranch);
    }
    await commitAll(cwd, `GGJIRA worker: ${issue.key} ${issue.summary}`.slice(0, 200));
    changes = await changedFilesSince(cwd, repository.baseBranch);
  }

  const validation: string[] = [];
  if (repository.validateCommand) {
    if (!(await deps.authorize("validate"))) {
      return cancelled("Stopped before validation: Router withdrew execution authority.", {
        ...withBranch,
        changes,
      });
    }
    const validated = await runValidateCommand(repository.validateCommand, cwd);
    validation.push(validated.summary);
    if (!validated.ok) {
      return {
        status: "failed",
        summary: workerResult.summary,
        failureReason: `Validation command failed: ${validated.summary}`,
        changes,
        validation,
        ...withBranch,
      };
    }
  }

  return {
    status: "succeeded",
    summary: workerResult.summary,
    changes,
    validation,
    artifacts: branch
      ? changes.length > 0
        ? [`branch: ${branch}`]
        : []
      : [`workspace: ${cwd} (direct edits; no Git branch or commit)`],
    ...withBranch,
  };
}
