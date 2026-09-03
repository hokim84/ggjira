import { randomUUID } from "node:crypto";
import type { JobHandler } from "../agent/handler.js";
import { ClaimLostError, claimJob } from "../agent/claim.js";
import type { ExecutionResult } from "../agent/result.js";
import type { AppConfig } from "../config.js";
import type { JiraGateway } from "../jira/gateway.js";
import type { JiraIssue } from "../jira/types.js";
import type { Logger } from "../logger.js";
import { reportForResult } from "../reporter/reporter.js";
import { type Job, type JobStatus, createJob, markReportingFailed, transitionJob } from "./job.js";
import type { JobStore } from "./store.js";

export interface RunnerDeps {
  jira: JiraGateway;
  store: JobStore;
  handler: JobHandler;
  logger?: Logger;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function generateRunId(now: Date = new Date()): string {
  return `run-${now.getTime()}-${randomUUID().slice(0, 8)}`;
}

function buildSummaryMarkdown(job: Job, result: ExecutionResult | undefined): string {
  const lines = [
    `# ${job.issueKey} — ${job.runId}`,
    "",
    `status: ${job.status}`,
    `updatedAt: ${job.updatedAt}`,
  ];
  if (job.branch) lines.push(`branch: ${job.branch}`);
  if (result?.changes?.length)
    lines.push("", "## Changes", "", ...result.changes.map((c) => `- ${c}`));
  if (result?.validation?.length) {
    lines.push("", "## Validation", "", ...result.validation.map((v) => `- ${v}`));
  }
  if (result?.artifacts?.length)
    lines.push("", "## Artifacts", "", ...result.artifacts.map((a) => `- ${a}`));
  if (job.summary) lines.push("", "## Summary", "", job.summary);
  if (job.error) lines.push("", "## Error", "", `(${job.failureStage ?? "unknown"}) ${job.error}`);
  return lines.join("\n");
}

function resultToJobStatus(result: ExecutionResult): JobStatus {
  if (result.status === "failed") return result.timedOut ? "timed_out" : "failed";
  return "succeeded"; // succeeded | planned | needs_decision all reach a "reported" terminal state
}

/**
 * Runs one claimed issue end to end: claim (`agent/claim.ts`) -> the role's
 * JobHandler -> standardized report back to Jira (`reporter.ts`) -> release.
 * This function is role-agnostic; `deps.handler` is what makes it implement
 * or pm. Returns undefined if the issue was already claimed locally (e.g. a
 * race within the same poll cycle) — nothing was created, so there is no Job
 * to return.
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
    await claimJob(deps.jira, config, issue, runId, logger);
  } catch (error) {
    if (error instanceof ClaimLostError) {
      logger?.info(
        { actualStatus: error.actualStatus },
        "claim lost to another agent; releasing local claim",
      );
      job = transitionJob(job, "cancelled");
      deps.store.saveJob(job);
      deps.store.releaseClaim(issue.key);
      return job;
    }
    logger?.warn({ err: error }, "claim failed unexpectedly; releasing local claim");
    deps.store.releaseClaim(issue.key);
    job = transitionJob(job, "failed", { failureStage: "jira", error: errorMessage(error) });
    deps.store.saveJob(job);
    return job;
  }

  job = transitionJob(job, "claimed");
  deps.store.saveJob(job);
  job = transitionJob(job, "running");
  deps.store.saveJob(job);

  let result: ExecutionResult;
  try {
    result = await deps.handler.run({ issue, job });
  } catch (error) {
    logger?.error({ err: error }, "job handler threw unexpectedly");
    result = {
      status: "failed",
      summary: "Execution failed unexpectedly.",
      failureReason: errorMessage(error),
    };
  }

  const branchPatch = result.branch ? { branch: result.branch } : {};
  const nextStatus = resultToJobStatus(result);
  job =
    nextStatus === "succeeded"
      ? transitionJob(job, "succeeded", { ...branchPatch, summary: result.summary })
      : transitionJob(job, nextStatus, {
          ...branchPatch,
          failureStage: "worker",
          error: result.failureReason ?? result.summary,
        });
  deps.store.saveJob(job);
  deps.store.writeSummary(issue.key, runId, buildSummaryMarkdown(job, result));

  job = await safeReport(
    job,
    deps.store,
    () => reportForResult(deps.jira, config, issue, job, result),
    logger,
  );
  deps.store.releaseClaim(issue.key);
  return job;
}

/**
 * Runs a Jira-reporting call and swallows any failure: the job already
 * reached a terminal status and job.json/summary.md are already saved, so a
 * failed comment/transition must not be treated as the job itself failing.
 * Instead it's recorded on the job as reportingFailed for later follow-up.
 */
async function safeReport(
  job: Job,
  store: JobStore,
  fn: () => Promise<void>,
  logger: Logger | undefined,
): Promise<Job> {
  try {
    await fn();
    return job;
  } catch (error) {
    logger
      ?.child({ layer: "reporter" })
      .error({ err: error }, "failed to report job outcome to Jira");
    const updated = markReportingFailed(job, error);
    store.saveJob(updated);
    return updated;
  }
}
