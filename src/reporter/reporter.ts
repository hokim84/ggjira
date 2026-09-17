import type { ExecutionResult } from "../agent/result.js";
import type { AppConfig } from "../config.js";
import type { JiraGateway } from "../jira/gateway.js";
import type { JiraIssue } from "../jira/types.js";
import type { Job } from "../job/job.js";

const PLANNED_LABEL = "ggjira-planned";

async function addCommentOnce(
  jira: JiraGateway,
  issueKey: string,
  runId: string,
  body: string,
): Promise<void> {
  const marker = `[GGJIRA:REPORT:${runId}]`;
  const comments = await jira.getComments(issueKey);
  if (comments.some((comment) => comment.body.includes(marker))) return;
  await jira.addComment(issueKey, `${marker}\n${body}`);
}

function agentTag(config: AppConfig): string {
  return `${config.agent.identity}@${config.agent.machine}`;
}

export function buildStartComment(runId: string, config: AppConfig): string {
  return ["GGJIRA agent claimed this issue.", `agent: ${agentTag(config)}`, `runId: ${runId}`].join(
    "\n",
  );
}

export function buildSuccessComment(job: Job, config: AppConfig, result: ExecutionResult): string {
  const lines = ["Implementation completed.", "", "Summary:", result.summary || "(no summary)"];
  if (result.changes?.length) {
    lines.push("", "Changes:", ...result.changes.map((c) => `- ${c}`));
  }
  if (result.validation?.length) {
    lines.push("", "Validation:", ...result.validation.map((v) => `- ${v}`));
  }
  if (result.artifacts?.length) {
    lines.push("", "Artifacts:", ...result.artifacts.map((a) => `- ${a}`));
  }
  lines.push("", `agent: ${agentTag(config)}`, `runId: ${job.runId}`);
  return lines.join("\n");
}

export function buildFailureComment(job: Job, config: AppConfig, result: ExecutionResult): string {
  const lines = [
    "Execution failed.",
    "",
    "Summary:",
    result.summary || "Implementation could not be completed.",
    "",
    "Failure Reason:",
    result.failureReason ?? job.error ?? "(unknown)",
  ];
  if (result.blockingIssue) {
    lines.push("", "Blocking Issue:", result.blockingIssue);
  }
  lines.push("", `agent: ${agentTag(config)}`, `runId: ${job.runId}`);
  return lines.join("\n");
}

function buildFallbackDecisionComment(
  job: Job,
  config: AppConfig,
  result: ExecutionResult,
): string {
  return [
    "GGJIRA needs a human decision before it can continue.",
    "",
    result.summary || "(no details provided)",
    "",
    `agent: ${agentTag(config)}`,
    `runId: ${job.runId}`,
  ].join("\n");
}

/**
 * Renders one ExecutionResult into the standard Jira comment + follow-up
 * transition/label (CLAUDE.md / phase 2 §4.4). This is the single point
 * where any role's outcome reaches Jira, so a human reading an issue never
 * needs to know which role or provider produced it.
 */
export async function reportForResult(
  jira: JiraGateway,
  config: AppConfig,
  issue: JiraIssue,
  job: Job,
  result: ExecutionResult,
): Promise<void> {
  if (result.status === "cancelled") {
    await addCommentOnce(
      jira,
      issue.key,
      job.runId,
      [
        "AI execution stopped.",
        "",
        result.summary,
        "",
        `agent: ${agentTag(config)}`,
        `runId: ${job.runId}`,
      ].join("\n"),
    );
    return;
  }
  if (result.status === "needs_decision") {
    await addCommentOnce(
      jira,
      issue.key,
      job.runId,
      result.decisionRequest ?? buildFallbackDecisionComment(job, config, result),
    );
    if (config.workflow.needsDecisionStatus) {
      await jira.transitionIssueToStatus(issue.key, config.workflow.needsDecisionStatus);
    } else if (config.workflow.needsDecisionTransitionName) {
      await jira.transitionIssue(issue.key, config.workflow.needsDecisionTransitionName);
    }
    return;
  }

  if (job.status === "succeeded") {
    await addCommentOnce(jira, issue.key, job.runId, buildSuccessComment(job, config, result));
    if (config.workflow.reviewStatus) {
      // A finished plan and a finished implementation land in the same review status --
      // human review is human review either way, and the issue's own hierarchy/type already
      // tells a plan apart from an implementation on the board (ADR 0017). GGJIRA never
      // transitions an issue to a completion status -- closing is the human's call (ADR 0015).
      await jira.transitionIssueToStatus(issue.key, config.workflow.reviewStatus);
    } else if (result.status === "planned") {
      if (config.workflow.plannedTransitionName) {
        await jira.transitionIssue(issue.key, config.workflow.plannedTransitionName);
      } else {
        await jira.addLabel(issue.key, PLANNED_LABEL);
      }
    } else {
      await jira.transitionIssue(issue.key, config.workflow.doneTransitionName);
    }
    return;
  }

  await addCommentOnce(jira, issue.key, job.runId, buildFailureComment(job, config, result));
  await jira.addLabel(issue.key, config.workflow.failureLabel);
}
