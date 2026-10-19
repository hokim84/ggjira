import type Database from "better-sqlite3";
import type { JiraGateway } from "../jira/gateway.js";
import type { JiraIssue } from "../jira/types.js";
import { computeDelegationApprovalIds } from "./approval.js";
import type { WorkspaceConfig } from "./config.js";
import { getOpenJobForIssue, getOpenJobs } from "./db/jobs.js";
import { getApprovalHoldActor, recordAdminHold } from "./db/holds.js";
import { hasOptIn, isDelegationMode, optInLabelOf } from "./workflow-mode.js";

/**
 * Moving a `legacy` or `label` workspace onto status delegation (ADR 0044, runbook §34). Like the
 * label migration (src/router/label-migration.ts) it runs while the workspace is still on its old
 * mode, in two steps:
 *
 * 1. `planDelegationMigration` (read-only) lists the workspace's issues with what the switch means
 *    for each. Nothing in Jira moves: a label never turns into a delegation, and an issue a human
 *    should hand to AI is moved to the request status by that human after the switch.
 * 2. `applyDelegationMigration` writes the baseline: for every listed issue, the request and
 *    plan-approval events Jira already shows are held (`admin_holds`, actor
 *    `DELEGATION_BASELINE_ACTOR`), so the switch itself — or any status history from before it —
 *    never counts as a new request or approval. Refused while a job may still run.
 *
 * Switching the workspace's `workflow` to `mode: "delegation"` with the same request and
 * plan-review statuses is a separate config change afterwards.
 */

/** The actor `admin_holds` records for an event that predates the switch to delegation. */
export const DELEGATION_BASELINE_ACTOR = "migration:delegation";

export type DelegationMigrationAction =
  /** Nothing to do: after the switch it is plain human work (or a result waiting as it is). */
  | "keep"
  /** It waited for AI under the old rules; a human decides whether to delegate it. */
  | "manual"
  /** A job may still run for it; wait for it to finish or cancel it. */
  | "blocked";

export interface DelegationMigrationTarget {
  /** The "AI plan request" status; must be a status of its own, not one the old rules used. */
  requestStatus: string;
  planReviewStatus: string;
}

export interface DelegationMigrationEntry {
  issueKey: string;
  summary: string;
  status: string;
  labels: string[];
  action: DelegationMigrationAction;
  reason: string;
}

export interface DelegationMigrationPlan {
  workspaceId: string;
  target: DelegationMigrationTarget;
  createdAt: string;
  entries: DelegationMigrationEntry[];
}

export interface DelegationMigrationResult {
  issueKey: string;
  outcome: "applied" | "skipped" | "failed";
  detail: string;
}

export class DelegationMigrationError extends Error {}

function jqlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Throws unless `workspace` is not delegating yet and `target` uses statuses of its own. */
export function assertDelegationMigratable(
  workspace: WorkspaceConfig,
  target: DelegationMigrationTarget,
): void {
  if (isDelegationMode(workspace)) {
    throw new DelegationMigrationError(
      `workspace "${workspace.id}" already delegates by status; migrate while it is still on its old mode`,
    );
  }
  const { requestStatus, planningStatus, inProgressStatus, reviewStatus, doneStatus } =
    workspace.workflow;
  const used = [requestStatus, planningStatus, inProgressStatus, reviewStatus, doneStatus];
  for (const [name, status] of Object.entries(target)) {
    if (used.includes(status)) {
      throw new DelegationMigrationError(
        `${name} "${status}" is already a status of workspace "${workspace.id}"; delegation needs its own request and plan-review statuses, or the issues sitting there would be read as requests`,
      );
    }
  }
  if (target.requestStatus === target.planReviewStatus) {
    throw new DelegationMigrationError("requestStatus and planReviewStatus must differ");
  }
}

function classify(
  db: Database.Database,
  workspace: WorkspaceConfig,
  issue: JiraIssue,
): Pick<DelegationMigrationEntry, "action" | "reason"> {
  const { requestStatus, planningStatus, inProgressStatus } = workspace.workflow;
  const job = getOpenJobForIssue(db, issue.key);
  if (job && job.state !== "failed" && job.state !== "timed_out") {
    return { action: "blocked", reason: `job ${job.id} is ${job.state}` };
  }
  const waitingForAi =
    (issue.statusName === requestStatus || issue.statusName === planningStatus) &&
    hasOptIn(issue, workspace);
  if (waitingForAi) {
    const label = optInLabelOf(workspace);
    return {
      action: "manual",
      reason: `requested under the old rules${label ? ` (label "${label}")` : ""}; after the switch nothing picks it up — move it to the request status to delegate it`,
    };
  }
  if (issue.statusName === inProgressStatus && job) {
    return {
      action: "manual",
      reason: `its last run ${job.state}; after the switch it is human work unless it is delegated again`,
    };
  }
  return {
    action: "keep",
    reason:
      issue.statusName === inProgressStatus
        ? "in progress without an approved plan: human work after the switch"
        : "nothing changes for it",
  };
}

async function listIssues(
  jira: JiraGateway,
  workspace: WorkspaceConfig,
  target: DelegationMigrationTarget,
): Promise<JiraIssue[]> {
  const { requestStatus, planningStatus, inProgressStatus, reviewStatus, needsDecisionStatus } =
    workspace.workflow;
  const statuses = [
    ...new Set(
      [
        requestStatus,
        planningStatus,
        inProgressStatus,
        reviewStatus,
        needsDecisionStatus,
        target.requestStatus,
        target.planReviewStatus,
      ].filter((status): status is string => Boolean(status)),
    ),
  ];
  const projects = workspace.projectKeys.map(jqlString).join(", ");
  return jira.searchIssues(
    `project in (${projects}) AND status in (${statuses.map(jqlString).join(", ")}) ORDER BY created ASC`,
    { all: true },
  );
}

/** Read-only: the workspace's issues and what the switch to delegation means for each. */
export async function planDelegationMigration(input: {
  db: Database.Database;
  jira: JiraGateway;
  workspace: WorkspaceConfig;
  target: DelegationMigrationTarget;
  now: string;
}): Promise<DelegationMigrationPlan> {
  const { workspace, target } = input;
  assertDelegationMigratable(workspace, target);
  for (const projectKey of workspace.projectKeys) {
    // An empty list means Jira did not tell; `router check` catches a missing status later.
    const known = (await input.jira.listProjectStatuses(projectKey)).map((s) => s.normalize("NFC"));
    const missing = [target.requestStatus, target.planReviewStatus].filter(
      (status) => known.length > 0 && !known.includes(status.normalize("NFC")),
    );
    if (missing.length > 0) {
      throw new DelegationMigrationError(
        `project ${projectKey} has no status ${missing.map((s) => `"${s}"`).join(", ")} (it has: ${known.join(", ")})`,
      );
    }
  }
  const issues = await listIssues(input.jira, workspace, target);
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
    })),
  };
}

/**
 * Records the baseline for every issue the workspace has now (not only the plan's: issues may
 * have moved since). Writes nothing to Jira. Refused while any job of the workspace may still
 * run — stop assignment and let them finish, or cancel them, first.
 */
export async function applyDelegationMigration(input: {
  db: Database.Database;
  jira: JiraGateway;
  workspace: WorkspaceConfig;
  plan: DelegationMigrationPlan;
  now: () => string;
  onResult?: (result: DelegationMigrationResult) => void;
}): Promise<DelegationMigrationResult[]> {
  const { db, workspace, plan } = input;
  if (plan.workspaceId !== workspace.id) {
    throw new DelegationMigrationError(
      `the plan is for workspace "${plan.workspaceId}", not "${workspace.id}"`,
    );
  }
  assertDelegationMigratable(workspace, plan.target);
  const live = getOpenJobs(db).filter(
    (job) =>
      job.workspaceId === workspace.id && job.state !== "failed" && job.state !== "timed_out",
  );
  if (live.length > 0) {
    throw new DelegationMigrationError(
      `${live.length} job(s) may still run in workspace "${workspace.id}" (${live.map((job) => `${job.issueKey} ${job.state}`).join(", ")}); let them finish or cancel them first`,
    );
  }

  const results: DelegationMigrationResult[] = [];
  const record = (result: DelegationMigrationResult) => {
    results.push(result);
    input.onResult?.(result);
  };
  const statuses = {
    requestStatus: plan.target.requestStatus,
    planReviewStatus: plan.target.planReviewStatus,
    inProgressStatus: workspace.workflow.inProgressStatus,
  };
  for (const issue of await listIssues(input.jira, workspace, plan.target)) {
    try {
      const ids = await computeDelegationApprovalIds(input.jira, issue, statuses);
      const held: string[] = [];
      // An issue already sitting in the request status would otherwise be planned on the switch.
      const events = [
        ...(issue.statusName === statuses.requestStatus ? [ids.requestApprovalId] : []),
        ...(ids.planApprovalId ? [ids.planApprovalId] : []),
      ];
      for (const approvalId of events) {
        if (getApprovalHoldActor(db, issue.key, approvalId)) continue;
        recordAdminHold(db, {
          issueKey: issue.key,
          approvalId,
          jobId: "",
          actor: DELEGATION_BASELINE_ACTOR,
          now: input.now(),
        });
        held.push(approvalId);
      }
      record(
        held.length > 0
          ? { issueKey: issue.key, outcome: "applied", detail: `baseline: ${held.join(", ")}` }
          : { issueKey: issue.key, outcome: "skipped", detail: "no request or approval to hold" },
      );
    } catch (error) {
      record({
        issueKey: issue.key,
        outcome: "failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
