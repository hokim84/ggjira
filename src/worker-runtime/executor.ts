import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { JobEnvelope, JobResult } from "../contracts/envelope.js";
import type { WorkerProviderConfig } from "../contracts/provider.js";
import { runValidateCommand } from "../worker/validate.js";
import { type CreatePullRequest, createPullRequest } from "../worker/github.js";
import type { UsageReading, WorkerProvider, WorkerResult } from "../worker/provider.js";
import { buildImplementPrompt } from "../worker/prompt.js";
import {
  changedFilesSince,
  commitAll,
  createWorktree,
  githubCompareUrl,
  githubRepoSlug,
  hasUncommittedChanges,
  isGitRepository,
  pushBranch,
  remoteUrl,
} from "../worker/worktree.js";
import type { WorkerConfig } from "./config.js";
import { executePlanningEnvelope } from "./planning.js";

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
  authorize: (stage: "commit" | "validate" | "push") => Promise<boolean>;
  /** Opens the pull request after a push; tests pass a fake. */
  createPullRequest?: CreatePullRequest;
  /** Plan usage the provider reported while running this job (ADR 0028). */
  onUsage?: (provider: WorkerProviderConfig, usage: UsageReading) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cancelled(summary: string, extra: Partial<ExecutionOutcome> = {}): ExecutionOutcome {
  return { status: "cancelled", summary, ...extra };
}

/**
 * Runs one envelope. Planning goes to `executePlanningEnvelope`; implementation is
 * worktree → provider → commit → validate. The v5 counterpart
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

  const onUsage = deps.onUsage
    ? (usage: UsageReading) => deps.onUsage?.(providerConfig, usage)
    : undefined;

  if (envelope.kind === "planning") {
    return executePlanningEnvelope(envelope, {
      repository,
      provider: deps.createProvider(providerConfig),
      worktreesRoot: deps.worktreesRoot,
      logPath: deps.config.logPath,
      signal: deps.signal,
      ...(onUsage ? { onUsage } : {}),
    });
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
      {
        signal: deps.signal,
        onEvent: (line) => appendFileSync(logFile, `${line}\n`),
        ...(onUsage ? { onUsage } : {}),
      },
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

  const artifacts = branch
    ? changes.length > 0
      ? [`branch: ${branch}`]
      : []
    : [`workspace: ${cwd} (direct edits; no Git branch or commit)`];
  let pullRequest: ExecutionOutcome["pullRequest"];
  if (branch && changes.length > 0 && repository.pushRemote) {
    if (!(await deps.authorize("push"))) {
      return cancelled("Stopped before push: Router withdrew execution authority.", {
        ...withBranch,
        changes,
        validation,
      });
    }
    const pushed = await pushJobBranch(repository, cwd, branch, {
      issueKey: issue.key,
      issueSummary: issue.summary,
      jobId: envelope.jobId,
      attemptId: envelope.attemptId,
      summary: workerResult.summary,
      changes,
      createPullRequest: deps.createPullRequest ?? createPullRequest,
    });
    artifacts.push(...pushed.artifacts);
    pullRequest = pushed.pullRequest;
  }

  return {
    status: "succeeded",
    summary: workerResult.summary,
    changes,
    validation,
    artifacts,
    ...withBranch,
    ...(pullRequest ? { pullRequest } : {}),
  };
}

/**
 * Pushes the job branch and, for GitHub remotes with `createPullRequest`, opens a PR. Failures are
 * reported in the artifacts, never fatal: the commit is still on the worker.
 */
async function pushJobBranch(
  repository: WorkerConfig["repositories"][number],
  cwd: string,
  branch: string,
  job: {
    issueKey: string;
    issueSummary: string;
    jobId: string;
    attemptId: string;
    summary: string;
    changes: string[];
    createPullRequest: CreatePullRequest;
  },
): Promise<{ artifacts: string[]; pullRequest?: ExecutionOutcome["pullRequest"] }> {
  const remote = repository.pushRemote as string;
  try {
    await pushBranch(cwd, remote, branch);
  } catch (error) {
    return {
      artifacts: [
        `push failed (${remote}): ${errorMessage(error)}`,
        `the branch is only on the worker: run "git push ${remote} ${branch}" in ${repository.path}`,
      ],
    };
  }
  const artifacts = [`pushed: ${remote}/${branch}`];
  const url = await remoteUrl(repository.path, remote);
  const slug = url ? githubRepoSlug(url) : undefined;
  const compare = url ? githubCompareUrl(url, repository.baseBranch, branch) : undefined;
  if (!slug || !repository.createPullRequest) {
    return { artifacts: [...artifacts, ...(compare ? [`open a pull request: ${compare}`] : [])] };
  }
  try {
    const pullRequest = await job.createPullRequest({
      cwd,
      repo: slug,
      base: repository.baseBranch,
      head: branch,
      title: `[${job.issueKey}] ${job.issueSummary}`.slice(0, 200),
      body: [
        job.summary,
        ...(job.changes.length ? ["", "Changes:", ...job.changes.map((c) => `- ${c}`)] : []),
        "",
        `Opened by GGJIRA for ${job.issueKey}. Merging it moves the Jira issue to done.`,
        `<!-- ggjira issue=${job.issueKey} job=${job.jobId} attempt=${job.attemptId} -->`,
      ].join("\n"),
    });
    return { artifacts: [...artifacts, `pull request: ${pullRequest.url}`], pullRequest };
  } catch (error) {
    return {
      artifacts: [
        ...artifacts,
        `pull request failed: ${errorMessage(error)}`,
        ...(compare ? [`open a pull request: ${compare}`] : []),
      ],
    };
  }
}
