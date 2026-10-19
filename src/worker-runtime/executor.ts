import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { JobEnvelope, JobResult } from "../contracts/envelope.js";
import type { ExecutionRecord } from "../contracts/execution.js";
import {
  IMPLEMENTATION_REPORT_JSON_SCHEMA,
  type ImplementationReport,
  ImplementationReportSchema,
  type LocalEvidence,
  type ResultGit,
  type ScopeCheck,
} from "../contracts/implementation.js";
import { matchesAnyGlob } from "../issue/paths.js";
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
  listCommittedChanges,
  listWorkingTreeChanges,
  pushBranch,
  remoteUrl,
  revParse,
  type WorktreeChange,
  writeStagedPatch,
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

type ProviderCall = { result: WorkerResult } | { error: unknown; durationMs: number };

/** Remembers every call the job makes, so its result can say what ran and what it used. Only
 *  `run` is passed through: a job never reads plan usage outside its own call. */
function recordingProvider(provider: WorkerProvider, calls: ProviderCall[]): WorkerProvider {
  return {
    run: async (request, hooks) => {
      const started = Date.now();
      try {
        const result = await provider.run(request, hooks);
        calls.push({ result });
        return result;
      } catch (error) {
        calls.push({ error, durationMs: Date.now() - started });
        throw error;
      }
    },
  };
}

/** M4-12: the call as the result reports it. Usage the CLI did not report stays absent. */
export function executionRecord(
  provider: WorkerProviderConfig,
  call: ProviderCall,
): ExecutionRecord {
  const base = { providerId: provider.id, providerType: provider.type };
  if ("error" in call) {
    return {
      ...base,
      ...(provider.model ? { model: provider.model, modelSource: "configured" as const } : {}),
      exitReason: "error",
      durationMs: call.durationMs,
    };
  }
  const { result } = call;
  return {
    ...base,
    ...(result.model
      ? { model: result.model, modelSource: "reported" as const }
      : provider.model
        ? { model: provider.model, modelSource: "configured" as const }
        : {}),
    ...(result.sessionId ? { callId: result.sessionId } : {}),
    exitReason: result.exitReason,
    durationMs: Math.max(0, Math.round(result.durationMs)),
    ...(result.numTurns !== undefined ? { numTurns: result.numTurns } : {}),
    ...(result.usage
      ? {
          usage: {
            ...result.usage,
            ...(result.usage.costUsd === undefined && result.totalCostUsd !== undefined
              ? { costUsd: result.totalCostUsd }
              : {}),
          },
        }
      : result.totalCostUsd !== undefined
        ? { usage: { costUsd: result.totalCostUsd } }
        : {}),
  };
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
  const calls: ProviderCall[] = [];
  const provider = recordingProvider(deps.createProvider(providerConfig), calls);
  const outcome = await executeWithProvider(envelope, deps, repository, providerConfig, provider);
  const last = calls.at(-1);
  return last ? { ...outcome, execution: executionRecord(providerConfig, last) } : outcome;
}

async function executeWithProvider(
  envelope: JobEnvelope,
  deps: ExecutorDeps,
  repository: WorkerConfig["repositories"][number],
  providerConfig: WorkerProviderConfig,
  provider: WorkerProvider,
): Promise<ExecutionOutcome> {
  const onUsage = deps.onUsage
    ? (usage: UsageReading) => deps.onUsage?.(providerConfig, usage)
    : undefined;

  if (envelope.kind === "planning") {
    return executePlanningEnvelope(envelope, {
      repository,
      provider,
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
  // M4-11: the commit the branch starts from, so a review can name exactly what it looked at.
  // Unreadable → left out (the result then says "unknown", never a guessed commit).
  const baseSha = branch ? await revParse(cwd, "HEAD").catch(() => undefined) : undefined;
  const git = (headSha?: string): { git: ResultGit } => ({
    git: branch
      ? {
          repository: "git",
          baseBranch: repository.baseBranch,
          ...(baseSha ? { baseSha } : {}),
          ...(headSha ? { headSha } : {}),
          committed: headSha !== undefined,
        }
      : { repository: "none", committed: false },
  });
  const withBranch = { ...(branch ? { branch } : {}), ...git() };

  mkdirSync(deps.config.logPath, { recursive: true });
  const logFile = path.join(deps.config.logPath, `${envelope.jobId}-${envelope.attemptId}.jsonl`);

  let workerResult: WorkerResult;
  try {
    workerResult = await provider.run(
      {
        prompt: buildImplementPrompt({
          title: issue.summary,
          description: issue.description,
          ...(envelope.executionContract ? { contract: envelope.executionContract } : {}),
        }),
        cwd,
        timeoutMs: envelope.timeoutMs,
        systemPrompt: envelope.systemPrompt,
        outputSchema: IMPLEMENTATION_REPORT_JSON_SCHEMA,
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

  const keepEvidence = (): Promise<LocalEvidence> =>
    preserveLocalEvidence({
      cwd,
      repositoryPath: repository.path,
      baseBranch: repository.baseBranch,
      branch,
      patchFile: path.join(deps.config.logPath, `${envelope.jobId}-${envelope.attemptId}.patch`),
    });

  // ADR 0036: the run is judged by its structured report, never by the provider's exit alone.
  const parsedReport = readImplementationReport(workerResult);
  if (!parsedReport.ok) {
    return {
      status: "failed",
      summary: "The implement agent's final report could not be read; nothing was committed.",
      failureReason: parsedReport.reason,
      localEvidence: await keepEvidence(),
      ...withBranch,
    };
  }
  const report = parsedReport.report;
  const scopeCheck: ScopeCheck = branch
    ? checkChangedPaths(
        await listJobChanges(cwd, repository.baseBranch),
        envelope.executionContract?.allowedPaths ?? [],
      )
    : { checked: false, reason: "not a git workspace", changedPaths: [], outsideAllowed: [] };
  const reported = { implementation: report, scopeCheck };

  // A requested decision, a deviation the agent admits, or a path outside the contract: stop
  // before commit/validate/push and leave the changes where a human can look at them.
  if (
    report.outcome === "needs_decision" ||
    report.scopeDeviations.length > 0 ||
    scopeCheck.outsideAllowed.length > 0
  ) {
    return {
      status: "needs_decision",
      summary: report.summary,
      ...reported,
      localEvidence: await keepEvidence(),
      ...withBranch,
    };
  }
  if (report.verification.length === 0) {
    return {
      status: "failed",
      summary: report.summary,
      failureReason: "The agent reported completion without any verification evidence.",
      ...reported,
      localEvidence: await keepEvidence(),
      ...withBranch,
    };
  }
  const failedChecks = report.verification.filter((entry) => entry.status === "fail");
  if (failedChecks.length > 0) {
    return {
      status: "failed",
      summary: report.summary,
      failureReason: `Verification failed: ${failedChecks.map((entry) => entry.acceptance).join("; ")}`,
      ...reported,
      localEvidence: await keepEvidence(),
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
  // Read after commit, whether or not this run committed: an agent that committed on its own
  // still left a head; a run with no commit leaves HEAD at the base and reports no head.
  const head = branch ? await revParse(cwd, "HEAD").catch(() => undefined) : undefined;
  const committed = { ...withBranch, ...git(head && head !== baseSha ? head : undefined) };

  const validation: string[] = [];
  if (repository.validateCommand) {
    if (!(await deps.authorize("validate"))) {
      return cancelled("Stopped before validation: Router withdrew execution authority.", {
        ...committed,
        changes,
      });
    }
    const validated = await runValidateCommand(repository.validateCommand, cwd);
    validation.push(validated.summary);
    if (!validated.ok) {
      return {
        status: "failed",
        summary: report.summary,
        failureReason: `Validation command failed: ${validated.summary}`,
        changes,
        validation,
        ...reported,
        ...committed,
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
        ...committed,
        changes,
        validation,
      });
    }
    const pushed = await pushJobBranch(repository, cwd, branch, {
      issueKey: issue.key,
      issueSummary: issue.summary,
      jobId: envelope.jobId,
      attemptId: envelope.attemptId,
      summary: report.summary,
      changes,
      createPullRequest: deps.createPullRequest ?? createPullRequest,
    });
    artifacts.push(...pushed.artifacts);
    pullRequest = pushed.pullRequest;
  }

  return {
    status: "succeeded",
    summary: report.summary,
    changes,
    validation,
    artifacts,
    ...reported,
    ...committed,
    ...(pullRequest ? { pullRequest } : {}),
  };
}

/** Best-effort JSON out of free text, for providers that answer in prose with a fenced block. */
function extractJson(text: string): unknown {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? text.match(/(\{[\s\S]*\})/)?.[1];
  if (!candidate) return undefined;
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

/** The provider's structured answer (or, failing that, JSON in its final text) as a validated
 *  report. Anything else — no JSON, wrong shape, a `needs_decision` without a decision — fails. */
export function readImplementationReport(
  workerResult: Pick<WorkerResult, "structuredOutput" | "summary">,
): { ok: true; report: ImplementationReport } | { ok: false; reason: string } {
  const candidate = workerResult.structuredOutput ?? extractJson(workerResult.summary);
  if (candidate === undefined) {
    return { ok: false, reason: "the final answer contained no JSON report" };
  }
  const parsed = ImplementationReportSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, reason: `the report does not match the schema: ${parsed.error.message}` };
  }
  return { ok: true, report: parsed.data };
}

/** Committed (by an agent that committed anyway) and uncommitted changes, one entry per path. */
async function listJobChanges(cwd: string, baseBranch: string): Promise<WorktreeChange[]> {
  const byPath = new Map<string, WorktreeChange>();
  for (const change of [
    ...(await listCommittedChanges(cwd, baseBranch)),
    ...(await listWorkingTreeChanges(cwd)),
  ]) {
    byPath.set(change.path, change);
  }
  return [...byPath.values()];
}

/** Compares changed paths with the contract's `allowedPaths`. A rename must be allowed at both
 *  ends. With no allowed paths the check is reported as not done, never as passed. */
export function checkChangedPaths(
  changes: readonly WorktreeChange[],
  allowedPaths: readonly string[],
): ScopeCheck {
  const changedPaths = changes.map((change) => ({ ...change }));
  if (allowedPaths.length === 0) {
    return {
      checked: false,
      reason: "the contract has no allowedPaths",
      changedPaths,
      outsideAllowed: [],
    };
  }
  const outsideAllowed = changedPaths.filter(
    (change) =>
      !matchesAnyGlob(change.path, allowedPaths) ||
      (change.from !== undefined && !matchesAnyGlob(change.from, allowedPaths)),
  );
  return { checked: true, changedPaths, outsideAllowed };
}

/**
 * Keeps what a stopped run changed, for the human who decides: the worktree stays, and in git
 * mode everything is staged (not committed) and written to a patch next to the job log. A patch
 * that cannot be written is reported in `cleanup`, not fatal — the worktree still has the changes.
 */
async function preserveLocalEvidence(input: {
  cwd: string;
  repositoryPath: string;
  baseBranch: string;
  branch: string | undefined;
  patchFile: string;
}): Promise<LocalEvidence> {
  if (!input.branch) {
    return {
      worktreePath: input.cwd,
      cleanup:
        "GGJIRA edited this workspace directly (not a git repository); review the changes there and revert what should not stay.",
    };
  }
  const removal = `in ${input.repositoryPath}: git worktree remove --force "${input.cwd}" && git branch -D ${input.branch} (or "ggjira worker worktrees prune" once it is old enough)`;
  try {
    await writeStagedPatch(input.cwd, input.baseBranch, input.patchFile);
  } catch (error) {
    return {
      worktreePath: input.cwd,
      branch: input.branch,
      cleanup: `${removal}. The patch could not be written: ${errorMessage(error)}`,
    };
  }
  return {
    worktreePath: input.cwd,
    branch: input.branch,
    patchFile: input.patchFile,
    cleanup: removal,
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
