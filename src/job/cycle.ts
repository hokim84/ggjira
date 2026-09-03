import type { JobHandler } from "../agent/handler.js";
import type { AppConfig } from "../config.js";
import type { JiraGateway } from "../jira/gateway.js";
import type { JiraIssue } from "../jira/types.js";
import type { Logger } from "../logger.js";
import { findAssignedJobs } from "../poller/poller.js";
import { reportForResult } from "../reporter/reporter.js";
import { isTerminalStatus, type Job, transitionJob, createJob } from "./job.js";
import { runJobForIssue } from "./runner.js";
import type { JobStore } from "./store.js";

export interface CycleDeps {
  jira: JiraGateway;
  store: JobStore;
  handler: JobHandler;
  logger?: Logger;
}

export interface PollCycleOutcome {
  issue: JiraIssue;
  /** undefined means the issue was skipped: already claimed locally. */
  job: Job | undefined;
}

/**
 * Runs one poll cycle: fetch issues assigned to this agent, then process each
 * sequentially (GGJIRA never runs more than one job at a time in the MVP).
 * A failure fetching candidates from Jira is logged and yields an empty
 * cycle rather than crashing the caller — the next cycle gets another try.
 */
export async function runPollCycle(
  config: AppConfig,
  deps: CycleDeps,
): Promise<PollCycleOutcome[]> {
  let candidates: JiraIssue[];
  try {
    candidates = await findAssignedJobs(deps.jira, config, deps.store);
  } catch (error) {
    deps.logger
      ?.child({ layer: "poller" })
      .error({ err: error }, "failed to fetch assigned issues from Jira");
    return [];
  }

  const outcomes: PollCycleOutcome[] = [];
  for (const issue of candidates) {
    const job = await runJobForIssue(issue, config, deps);
    outcomes.push({ issue, job });
  }
  return outcomes;
}

/**
 * Recovers claims left in data/state.json by a previous process. Since this
 * runs once at startup before anything is claimed in this process, every
 * claim found here belongs to a run that either finished but never released
 * its claim, or was interrupted mid-flight by a crash/kill — both are safe
 * to resolve without racing anything currently in progress.
 */
export async function recoverStaleClaims(config: AppConfig, deps: CycleDeps): Promise<void> {
  const claims = deps.store.listClaims();

  for (const [issueKey, runId] of Object.entries(claims)) {
    const logger = deps.logger?.child({ layer: "job", issueKey, runId, stage: "recovery" });
    const existing = deps.store.loadJob(issueKey, runId) ?? createJob(issueKey, runId);

    if (isTerminalStatus(existing.status)) {
      logger?.info("releasing stale claim for an already-terminal job");
      deps.store.releaseClaim(issueKey);
      continue;
    }

    logger?.warn("recovering a job left in progress by a previous process; marking as failed");
    const recovered = transitionJob(existing, "failed", {
      failureStage: "job",
      error: "GGJIRA restarted while this job was still in progress (previous process exited).",
    });
    deps.store.saveJob(recovered);
    deps.store.writeSummary(
      issueKey,
      runId,
      [
        `# ${issueKey} — ${runId}`,
        "",
        "status: failed (recovered after restart)",
        "",
        recovered.error ?? "",
      ].join("\n"),
    );

    try {
      const issue = await deps.jira.getIssue(issueKey);
      await reportForResult(deps.jira, config, issue, recovered, {
        status: "failed",
        summary: "Execution failed: GGJIRA restarted mid-run.",
        failureReason: recovered.error ?? "unknown",
      });
    } catch (error) {
      logger?.error({ err: error }, "failed to report recovered job outcome to Jira");
    }

    deps.store.releaseClaim(issueKey);
  }
}
