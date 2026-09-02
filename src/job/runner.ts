import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import type { AppConfig } from "../config.js";
import type { JiraGateway } from "../jira/gateway.js";
import type { JiraIssue } from "../jira/types.js";
import type { Logger } from "../logger.js";
import { claimIssueInJira, reportFailure, reportSuccess } from "../reporter/reporter.js";
import { buildTaskSystemPrompt, buildWorkerPrompt } from "../worker/prompt.js";
import type { WorkerProvider, WorkerRequest } from "../worker/provider.js";
import {
  changedFilesSince,
  commitAll,
  createWorktree,
  hasUncommittedChanges,
} from "../worker/worktree.js";
import { type Job, type JobStatus, createJob, transitionJob } from "./job.js";
import type { JobStore } from "./store.js";

export interface RunnerDeps {
  jira: JiraGateway;
  store: JobStore;
  worker: WorkerProvider;
  worktreesRoot: string;
  logger?: Logger;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function generateRunId(now: Date = new Date()): string {
  return `run-${now.getTime()}-${randomUUID().slice(0, 8)}`;
}

function buildSummaryMarkdown(job: Job, changedFiles: string[], workerLogPath: string): string {
  const lines = [
    `# ${job.issueKey} — ${job.runId}`,
    "",
    `status: ${job.status}`,
    `updatedAt: ${job.updatedAt}`,
  ];
  if (job.branch) lines.push(`branch: ${job.branch}`);
  if (job.summary) lines.push("", "## Summary", "", job.summary);
  if (job.error) lines.push("", "## Error", "", `(${job.failureStage ?? "unknown"}) ${job.error}`);
  if (changedFiles.length > 0) {
    lines.push("", "## Changed files", "", ...changedFiles.map((f) => `- ${f}`));
  }
  lines.push("", `worker log: ${workerLogPath}`);
  return lines.join("\n");
}

/**
 * Runs one issue end to end: claim (Jira + local) -> worktree -> worker ->
 * commit -> report back to Jira. Returns undefined if the issue was already
 * claimed locally (e.g. a race within the same poll cycle) — nothing was
 * created, so there is no Job to return.
 */
export async function runJobForIssue(
  issue: JiraIssue,
  config: AppConfig,
  deps: RunnerDeps,
): Promise<Job | undefined> {
  const runId = generateRunId();
  const logger = deps.logger?.child({ layer: "job", issueKey: issue.key, runId });

  if (!deps.store.claimIssue(issue.key, runId)) {
    logger?.info("issue already claimed locally; skipping");
    return undefined;
  }

  let job = createJob(issue.key, runId);
  deps.store.saveJob(job);

  try {
    await claimIssueInJira(deps.jira, config, issue, runId);
  } catch (error) {
    logger?.warn({ err: error }, "claim rejected by Jira; releasing local claim");
    deps.store.releaseClaim(issue.key);
    job = transitionJob(job, "failed", {
      failureStage: "jira",
      error: errorMessage(error),
    });
    deps.store.saveJob(job);
    return job;
  }

  job = transitionJob(job, "claimed");
  deps.store.saveJob(job);

  const branch = `ggjira/${issue.key}-${runId}`;
  let worktreePath: string;
  try {
    const worktree = await createWorktree(
      config.targetRepo.path,
      config.targetRepo.baseBranch,
      branch,
      deps.worktreesRoot,
    );
    worktreePath = worktree.path;
  } catch (error) {
    logger?.error({ err: error }, "failed to create worktree");
    job = transitionJob(job, "failed", { failureStage: "job", error: errorMessage(error) });
    deps.store.saveJob(job);
    await safeReport(() => reportFailure(deps.jira, config, issue, job), logger);
    deps.store.releaseClaim(issue.key);
    return job;
  }

  job = transitionJob(job, "running", { branch });
  deps.store.saveJob(job);

  const request: WorkerRequest = {
    prompt: buildWorkerPrompt({ title: issue.summary, description: issue.description }),
    cwd: worktreePath,
    timeoutMs: config.worker.timeoutMs,
    command: config.worker.command,
    model: config.worker.model,
    effort: config.worker.effort,
    permissionMode: config.worker.permissionMode,
    allowedTools: config.worker.allowedTools,
    appendSystemPrompt: buildTaskSystemPrompt(),
  };

  const workerLogPath = deps.store.workerLogPath(issue.key, runId);
  const result = await deps.worker.run(request, {
    onEvent: (line) => appendFileSync(workerLogPath, `${line}\n`),
  });

  let changedFiles: string[] = [];
  if (result.exitReason === "completed" && !result.isError) {
    if (await hasUncommittedChanges(worktreePath)) {
      await commitAll(worktreePath, `GGJIRA worker: ${issue.key} ${issue.summary}`.slice(0, 200));
      changedFiles = await changedFilesSince(worktreePath, config.targetRepo.baseBranch);
    }

    job = transitionJob(job, "succeeded", { summary: result.summary });
    deps.store.saveJob(job);
    deps.store.writeSummary(
      issue.key,
      runId,
      buildSummaryMarkdown(job, changedFiles, workerLogPath),
    );

    await safeReport(
      () => reportSuccess(deps.jira, config, issue, job, changedFiles, workerLogPath),
      logger,
    );
    deps.store.releaseClaim(issue.key);
    return job;
  }

  const nextStatus: JobStatus = result.exitReason === "timeout" ? "timed_out" : "failed";
  job = transitionJob(job, nextStatus, { failureStage: "worker", error: result.summary });
  deps.store.saveJob(job);
  deps.store.writeSummary(issue.key, runId, buildSummaryMarkdown(job, changedFiles, workerLogPath));

  await safeReport(() => reportFailure(deps.jira, config, issue, job), logger);
  deps.store.releaseClaim(issue.key);
  return job;
}

async function safeReport(fn: () => Promise<void>, logger: Logger | undefined): Promise<void> {
  try {
    await fn();
  } catch (error) {
    logger?.error(
      { err: error },
      "failed to report job outcome to Jira (job.json/summary.md already saved)",
    );
  }
}
