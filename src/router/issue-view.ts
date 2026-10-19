import type Database from "better-sqlite3";
import type { JobState } from "../contracts/job-state.js";
import type { JobKind } from "../contracts/protocol.js";
import type { ReadinessGap } from "../issue/readiness.js";
import { JiraApiError } from "../jira/client.js";
import type { JiraGateway } from "../jira/gateway.js";
import type { JiraIssue } from "../jira/types.js";
import { computeApprovalId } from "./approval.js";
import type { RouterConfig, WorkspaceConfig } from "./config.js";
import { INPUTS_CHANGED_HOLD_ACTOR, getApprovalHoldActor } from "./db/holds.js";
import { getOpenJobForIssue } from "./db/jobs.js";
import { listOpenReadinessHolds } from "./db/readiness-holds.js";
import { type IssueDelegationView, readIssueDelegation } from "./issue-delegation.js";
import {
  approvalStatusFor,
  candidateStatuses,
  isDelegationMode,
  resolveJobKind,
  workflowModeOf,
} from "./workflow-mode.js";

export type IssueViewErrorCode =
  | "invalid_issue_key"
  | "unknown_project"
  | "unknown_issue"
  | "jira_forbidden"
  | "jira_rate_limited"
  | "jira_error";

export class IssueViewError extends Error {
  constructor(
    readonly code: IssueViewErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "IssueViewError";
  }
}

/**
 * Why Router would not start the issue on its next pass, as far as it can tell without running
 * that pass (dependencies, capability routing and worker availability are decided there).
 */
export type IssueBlockerCode =
  | "not_requested"
  | "no_assignee"
  | "approval_held"
  | "inputs_changed"
  | "readiness_hold";

export interface IssueBlocker {
  code: IssueBlockerCode;
  message: string;
  /** Contract sections still missing, for `readiness_hold`. */
  missing?: ReadinessGap[];
}

export interface IssueView {
  issueKey: string;
  /** The issue in Jira's own UI, for people to open next to Router's view. */
  issueUrl: string;
  summary: string;
  statusName: string;
  labels: string[];
  assigned: boolean;
  workspaceId: string;
  mode: "legacy" | "delegation";
  requestStatus: string;
  openJob: { jobId: string; kind: JobKind; state: JobState } | null;
  /** Empty with no open job: the next reconcile may start it. */
  blockers: IssueBlocker[];
  /** `delegation` mode (ADR 0044): where the issue stands in the delegate → plan → approve flow. */
  delegation?: IssueDelegationView;
}

interface IssueViewDeps {
  db: Database.Database;
  jira: JiraGateway;
  config: RouterConfig;
}

const ISSUE_KEY = /^([A-Z][A-Z0-9_]*)-[1-9][0-9]*$/;

/** The workspace that owns `issueKey`'s project. Checked before any Jira call, so this API can
 *  never touch an issue outside the configured projects. */
export function workspaceForIssueKey(config: RouterConfig, issueKey: string): WorkspaceConfig {
  const match = ISSUE_KEY.exec(issueKey);
  if (!match) {
    throw new IssueViewError("invalid_issue_key", `"${issueKey}" is not a Jira issue key`);
  }
  const projectKey = match[1];
  const workspace = config.workspaces.find((entry) =>
    entry.projectKeys.some((key) => key.toUpperCase() === projectKey),
  );
  if (!workspace) {
    throw new IssueViewError(
      "unknown_project",
      `project ${projectKey} is not in any configured workspace`,
    );
  }
  return workspace;
}

/** Maps a failed Jira read to the error the admin API returns. */
function jiraFailure(issueKey: string, error: unknown): IssueViewError {
  if (error instanceof JiraApiError) {
    if (error.status === 404) {
      return new IssueViewError("unknown_issue", `Jira has no issue ${issueKey} (or hides it)`);
    }
    if (error.status === 401 || error.status === 403) {
      return new IssueViewError(
        "jira_forbidden",
        `Router's Jira account may not read ${issueKey} (HTTP ${error.status})`,
      );
    }
    if (error.status === 429) {
      return new IssueViewError("jira_rate_limited", "Jira is rate limiting Router; try again");
    }
  }
  return new IssueViewError(
    "jira_error",
    `Jira call for ${issueKey} failed: ${error instanceof Error ? error.message : String(error)}`,
  );
}

async function readIssue(jira: JiraGateway, issueKey: string): Promise<JiraIssue> {
  try {
    return await jira.getIssue(issueKey);
  } catch (error) {
    throw jiraFailure(issueKey, error);
  }
}

/** Jira answers for a moved issue's old key with the issue under its new key. */
function assertInWorkspace(issue: JiraIssue, workspace: WorkspaceConfig, asked: string): void {
  if (issue.projectKey && !workspace.projectKeys.includes(issue.projectKey)) {
    throw new IssueViewError(
      "unknown_project",
      `${asked} is now ${issue.key} in project ${issue.projectKey}, which workspace "${workspace.id}" does not cover`,
    );
  }
}

export async function readIssueView(deps: IssueViewDeps, issueKey: string): Promise<IssueView> {
  const workspace = workspaceForIssueKey(deps.config, issueKey);
  const issue = await readIssue(deps.jira, issueKey);
  assertInWorkspace(issue, workspace, issueKey);
  return buildView(deps, workspace, issue);
}

async function buildView(
  deps: IssueViewDeps,
  workspace: WorkspaceConfig,
  issue: JiraIssue,
): Promise<IssueView> {
  const { requestStatus } = workspace.workflow;
  const job = getOpenJobForIssue(deps.db, issue.key);
  return {
    issueKey: issue.key,
    issueUrl: `${deps.config.jira.baseUrl.replace(/\/+$/, "")}/browse/${encodeURIComponent(issue.key)}`,
    summary: issue.summary,
    statusName: issue.statusName,
    labels: issue.labels,
    assigned: issue.assigneeAccountId !== null,
    workspaceId: workspace.id,
    mode: workflowModeOf(workspace),
    requestStatus,
    openJob: job ? { jobId: job.id, kind: job.kind, state: job.state } : null,
    blockers: job ? [] : await blockersOf(deps, workspace, issue),
    ...(isDelegationMode(workspace)
      ? { delegation: await readIssueDelegation(deps, workspace, issue) }
      : {}),
  };
}

async function blockersOf(
  deps: IssueViewDeps,
  workspace: WorkspaceConfig,
  issue: JiraIssue,
): Promise<IssueBlocker[]> {
  // In `delegation` mode the stage (see `delegation`) says what happens next, not a blocker list.
  if (isDelegationMode(workspace)) return [];
  const { requestStatus } = workspace.workflow;
  const blockers: IssueBlocker[] = [];
  const requested = candidateStatuses(workspace).includes(issue.statusName.normalize("NFC"));
  if (!requested) {
    blockers.push({
      code: "not_requested",
      message: `the issue is in "${issue.statusName}", not "${requestStatus}"`,
    });
  }
  if (issue.assigneeAccountId === null) {
    blockers.push({ code: "no_assignee", message: "the issue has no assignee (human owner)" });
  }
  if (!requested) return blockers;

  // Only a request that could run is worth one changelog read.
  let approvalId: string | undefined;
  try {
    approvalId = await computeApprovalId(
      deps.jira,
      issue,
      approvalStatusFor(resolveJobKind({ workspace, issue }), workspace),
    );
  } catch {
    // Leave the hold checks out rather than fail the whole view over the changelog.
  }
  const holdActor = approvalId ? getApprovalHoldActor(deps.db, issue.key, approvalId) : undefined;
  if (holdActor === INPUTS_CHANGED_HOLD_ACTOR) {
    blockers.push({
      code: "inputs_changed",
      message: "the request was edited after it was approved; a new approval is needed",
    });
  } else if (holdActor) {
    blockers.push({
      code: "approval_held",
      message: `an admin (${holdActor}) cancelled the job for this approval`,
    });
  }
  const hold = listOpenReadinessHolds(deps.db).find((row) => row.issueKey === issue.key);
  if (hold) {
    blockers.push({
      code: "readiness_hold",
      message: "the implementation request lacks contract sections",
      missing: hold.missing,
    });
  }
  return blockers;
}
