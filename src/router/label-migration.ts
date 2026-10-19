import type Database from "better-sqlite3";
import { checkImplementationReadiness } from "../issue/readiness.js";
import { readIssueRequirements } from "../issue/requirements.js";
import type { JiraGateway } from "../jira/gateway.js";
import type { JiraIssue } from "../jira/types.js";
import type { WorkspaceConfig } from "./config.js";
import { getOpenJobForIssue } from "./db/jobs.js";
import { isLabelMode, labelsInclude } from "./workflow-mode.js";

/**
 * Moving a `legacy` workspace's issues onto the label workflow (ADR 0037, runbook §27). Two
 * steps, both run while the workspace is still `legacy`:
 *
 * 1. `planLabelMigration` (read-only) lists every issue in a legacy AI status with a proposed
 *    action. Nothing is approved; a human reviews the file and sets `approved: true`.
 * 2. `applyLabelMigration` carries out only the approved, actionable entries, one issue at a time,
 *    re-reading each issue afterwards. A failure is recorded for that issue and the rest go on.
 *
 * Legacy mode ignores labels and does not request work from the label workflow's To Do, so
 * neither step can start a job. Switching the workspace to `label` afterwards is a separate,
 * explicit config change.
 */

export type LabelMigrationAction =
  /** A legacy request: add the opt-in label and move to To Do, where label mode picks it up. */
  | "add-label-and-request"
  /** A legacy result awaiting review: move to the label workflow's Review. */
  | "move-to-review"
  /** A human has to decide (decision pending, stuck run, a meaning that would change). */
  | "manual"
  /** A job may still run for it; wait for it to finish or cancel it. */
  | "blocked";

export interface LabelMigrationTarget {
  optInLabel: string;
  toDoStatus: string;
  reviewStatus: string;
}

export interface LabelMigrationEntry {
  issueKey: string;
  summary: string;
  status: string;
  labels: string[];
  action: LabelMigrationAction;
  reason: string;
  /** Set by the human who reviewed the plan; only approved entries are applied. */
  approved: boolean;
}

export interface LabelMigrationPlan {
  workspaceId: string;
  target: LabelMigrationTarget;
  createdAt: string;
  entries: LabelMigrationEntry[];
}

export interface LabelMigrationResult {
  issueKey: string;
  action: LabelMigrationAction;
  outcome: "applied" | "skipped" | "failed";
  detail: string;
}

export class LabelMigrationError extends Error {}

function jqlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Throws `LabelMigrationError` unless `workspace` is still legacy and `target` cannot collide
 *  with its legacy request statuses. */
export function assertMigratable(workspace: WorkspaceConfig, target: LabelMigrationTarget): void {
  if (isLabelMode(workspace)) {
    throw new LabelMigrationError(
      `workspace "${workspace.id}" is already in label mode; migrate while it is still legacy`,
    );
  }
  const { requestStatus, planningStatus } = workspace.workflow;
  if ([requestStatus, planningStatus].includes(target.toDoStatus)) {
    throw new LabelMigrationError(
      `"${target.toDoStatus}" is a legacy request status of workspace "${workspace.id}"; moving issues there would start them under the legacy rules`,
    );
  }
}

function classify(
  db: Database.Database,
  workspace: WorkspaceConfig,
  issue: JiraIssue,
): Pick<LabelMigrationEntry, "action" | "reason"> {
  const { requestStatus, planningStatus, inProgressStatus, reviewStatus, needsDecisionStatus } =
    workspace.workflow;
  const job = getOpenJobForIssue(db, issue.key);
  if (job && job.state !== "failed" && job.state !== "timed_out") {
    return { action: "blocked", reason: `job ${job.id} is ${job.state}` };
  }
  const ready = checkImplementationReadiness(readIssueRequirements(issue)).ready;
  switch (issue.statusName) {
    case requestStatus:
      return {
        action: "add-label-and-request",
        reason: ready
          ? "implementation request; label mode will implement it"
          : "implementation request without a contract; label mode will send it to the PM first",
      };
    case planningStatus:
      return ready
        ? {
            action: "manual",
            reason:
              "planning request that already has acceptance criteria and verification; label mode would implement it instead of planning",
          }
        : { action: "add-label-and-request", reason: "planning request; label mode will plan it" };
    case reviewStatus:
      return { action: "move-to-review", reason: "result awaiting human review" };
    case needsDecisionStatus:
      return {
        action: "manual",
        reason: "waiting for a human decision; answer it, then request it in the label workflow",
      };
    case inProgressStatus:
      return {
        action: "manual",
        reason: job
          ? `its last run ${job.state}; decide whether to request it again`
          : "in progress with no running job; decide where it belongs",
      };
    default:
      return { action: "manual", reason: `unexpected status "${issue.statusName}"` };
  }
}

/** Read-only: every issue in one of the workspace's legacy AI statuses, with a proposed action. */
export async function planLabelMigration(input: {
  db: Database.Database;
  jira: JiraGateway;
  workspace: WorkspaceConfig;
  target: LabelMigrationTarget;
  now: string;
}): Promise<LabelMigrationPlan> {
  const { workspace, target } = input;
  assertMigratable(workspace, target);
  const { requestStatus, planningStatus, inProgressStatus, reviewStatus, needsDecisionStatus } =
    workspace.workflow;
  const statuses = [
    ...new Set(
      [requestStatus, planningStatus, inProgressStatus, reviewStatus, needsDecisionStatus].filter(
        (status): status is string => Boolean(status),
      ),
    ),
  ];
  for (const projectKey of workspace.projectKeys) {
    // An empty list means Jira did not tell; apply would then fail per issue instead.
    const known = (await input.jira.listProjectStatuses(projectKey)).map((s) => s.normalize("NFC"));
    const missing = [target.toDoStatus, target.reviewStatus].filter(
      (status) => known.length > 0 && !known.includes(status.normalize("NFC")),
    );
    if (missing.length > 0) {
      throw new LabelMigrationError(
        `project ${projectKey} has no status ${missing.map((s) => `"${s}"`).join(", ")} (it has: ${known.join(", ")})`,
      );
    }
  }
  const projects = workspace.projectKeys.map(jqlString).join(", ");
  const issues = await input.jira.searchIssues(
    `project in (${projects}) AND status in (${statuses.map(jqlString).join(", ")}) ORDER BY created ASC`,
    { all: true },
  );
  return {
    workspaceId: workspace.id,
    target,
    createdAt: input.now,
    entries: issues.map((issue) => ({
      issueKey: issue.key,
      summary: issue.summary,
      status: issue.statusName,
      labels: issue.labels,
      ...classify(input.db, workspace, issue),
      approved: false,
    })),
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Applies the approved entries of a reviewed plan. Each issue is re-classified against its current
 * Jira state first: an issue that has moved on since the plan was made is skipped, not forced.
 * The outcome is confirmed by re-reading the issue, never assumed from a write that returned.
 */
export async function applyLabelMigration(input: {
  db: Database.Database;
  jira: JiraGateway;
  workspace: WorkspaceConfig;
  plan: LabelMigrationPlan;
  onResult?: (result: LabelMigrationResult) => void;
}): Promise<LabelMigrationResult[]> {
  const { workspace, plan } = input;
  if (plan.workspaceId !== workspace.id) {
    throw new LabelMigrationError(
      `the plan is for workspace "${plan.workspaceId}", not "${workspace.id}"`,
    );
  }
  assertMigratable(workspace, plan.target);
  const results: LabelMigrationResult[] = [];
  const record = (result: LabelMigrationResult) => {
    results.push(result);
    input.onResult?.(result);
  };

  for (const entry of plan.entries) {
    const base = { issueKey: entry.issueKey, action: entry.action };
    if (!entry.approved) {
      record({ ...base, outcome: "skipped", detail: "not approved" });
      continue;
    }
    if (entry.action !== "add-label-and-request" && entry.action !== "move-to-review") {
      record({ ...base, outcome: "skipped", detail: `${entry.action} entries are not applied` });
      continue;
    }
    try {
      const issue = await input.jira.getIssue(entry.issueKey);
      const now = classify(input.db, workspace, issue);
      if (now.action !== entry.action) {
        record({
          ...base,
          outcome: "skipped",
          detail: `the issue changed since the plan (now ${now.action}: ${now.reason})`,
        });
        continue;
      }
      const target =
        entry.action === "add-label-and-request"
          ? plan.target.toDoStatus
          : plan.target.reviewStatus;
      if (
        entry.action === "add-label-and-request" &&
        !labelsInclude(issue.labels, plan.target.optInLabel)
      ) {
        await input.jira.addLabel(issue.key, plan.target.optInLabel);
      }
      await input.jira.transitionIssueToStatus(issue.key, target);
      const after = await input.jira.getIssue(issue.key);
      const labelled =
        entry.action !== "add-label-and-request" ||
        labelsInclude(after.labels, plan.target.optInLabel);
      if (after.statusName.normalize("NFC") !== target.normalize("NFC") || !labelled) {
        record({
          ...base,
          outcome: "failed",
          detail: `Jira now shows "${after.statusName}" with labels [${after.labels.join(", ")}]`,
        });
        continue;
      }
      record({ ...base, outcome: "applied", detail: `now in "${target}"` });
    } catch (error) {
      record({ ...base, outcome: "failed", detail: errorText(error) });
    }
  }
  return results;
}
