import type Database from "better-sqlite3";
import type { JobKind } from "../contracts/protocol.js";
import type { JobState } from "../contracts/job-state.js";
import type { ReadinessGap } from "../issue/readiness.js";
import { JiraApiError } from "../jira/client.js";
import type { JiraGateway } from "../jira/gateway.js";
import type { JiraIssue } from "../jira/types.js";
import { computeApprovalId } from "./approval.js";
import type { RouterConfig, WorkspaceConfig } from "./config.js";
import { getApprovalHoldActor, INPUTS_CHANGED_HOLD_ACTOR } from "./db/holds.js";
import { getOpenJobForIssue } from "./db/jobs.js";
import { listOpenReadinessHolds } from "./db/readiness-holds.js";
import { type IssueDelegationView, readIssueDelegation } from "./issue-delegation.js";
import { isDelegationMode, isLabelMode, labelsInclude, workflowModeOf } from "./workflow-mode.js";

/**
 * Turning one issue's AI participation on or off from the Router (M4-03, ADR 0039): only the
 * workspace's opt-in label is added or removed, through Jira's partial `update.labels` edit, so
 * every other label stays as it is. A write is never taken as done until a re-read shows it.
 * Removing the label revokes an open job through the existing path (scheduler `verifyJob`); this
 * module does not cancel anything itself.
 */

export type IssueOptInErrorCode =
  | "invalid_issue_key"
  | "unknown_project"
  | "not_label_mode"
  | "unknown_issue"
  | "jira_forbidden"
  | "jira_rate_limited"
  | "jira_error"
  | "unconfirmed";

export class IssueOptInError extends Error {
  constructor(
    readonly code: IssueOptInErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "IssueOptInError";
  }
}

/**
 * Why Router would not start the issue on its next pass, as far as it can tell without running
 * that pass (dependencies, capability routing and worker availability are decided there).
 */
export type OptInBlockerCode =
  | "not_label_mode"
  | "opt_in_missing"
  | "not_requested"
  | "no_assignee"
  | "approval_held"
  | "inputs_changed"
  | "readiness_hold";

export interface OptInBlocker {
  code: OptInBlockerCode;
  message: string;
  /** Contract sections still missing, for `readiness_hold`. */
  missing?: ReadinessGap[];
}

export interface IssueOptInView {
  issueKey: string;
  /** The issue in Jira's own UI, for people to open next to Router's view. */
  issueUrl: string;
  summary: string;
  statusName: string;
  labels: string[];
  assigned: boolean;
  workspaceId: string;
  mode: "legacy" | "label" | "delegation";
  /** `null` in legacy mode, where labels opt nothing in. */
  optInLabel: string | null;
  optedIn: boolean;
  requestStatus: string;
  openJob: { jobId: string; kind: JobKind; state: JobState } | null;
  /** Empty with no open job: the next reconcile may start it. */
  blockers: OptInBlocker[];
  /** `delegation` mode (ADR 0044): where the issue stands in the delegate → plan → approve flow. */
  delegation?: IssueDelegationView;
}

export interface SetOptInResult {
  /** `unchanged`: the label was already as asked, so nothing was written. */
  outcome: "changed" | "unchanged";
  /** The write itself failed in a way that could have been applied, and the re-read showed it was. */
  confirmedAfterError: boolean;
  view: IssueOptInView;
}

interface OptInDeps {
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
    throw new IssueOptInError("invalid_issue_key", `"${issueKey}" is not a Jira issue key`);
  }
  const projectKey = match[1];
  const workspace = config.workspaces.find((entry) =>
    entry.projectKeys.some((key) => key.toUpperCase() === projectKey),
  );
  if (!workspace) {
    throw new IssueOptInError(
      "unknown_project",
      `project ${projectKey} is not in any configured workspace`,
    );
  }
  return workspace;
}

/** Maps a failed Jira read/write to the error the admin API returns. */
function jiraFailure(issueKey: string, error: unknown): IssueOptInError {
  if (error instanceof JiraApiError) {
    if (error.status === 404) {
      return new IssueOptInError("unknown_issue", `Jira has no issue ${issueKey} (or hides it)`);
    }
    if (error.status === 401 || error.status === 403) {
      return new IssueOptInError(
        "jira_forbidden",
        `Router's Jira account may not edit ${issueKey} (HTTP ${error.status})`,
      );
    }
    if (error.status === 429) {
      return new IssueOptInError("jira_rate_limited", "Jira is rate limiting Router; try again");
    }
  }
  return new IssueOptInError(
    "jira_error",
    `Jira call for ${issueKey} failed: ${error instanceof Error ? error.message : String(error)}`,
  );
}

/** A refused request (any 4xx, a rate limit included) changed nothing; anything else — a 5xx, a
 *  timeout, a dropped connection — might have, and is settled by re-reading the issue. */
function writeCertainlyFailed(error: unknown): boolean {
  return error instanceof JiraApiError && error.status < 500;
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
    throw new IssueOptInError(
      "unknown_project",
      `${asked} is now ${issue.key} in project ${issue.projectKey}, which workspace "${workspace.id}" does not cover`,
    );
  }
}

export async function readIssueOptIn(deps: OptInDeps, issueKey: string): Promise<IssueOptInView> {
  const workspace = workspaceForIssueKey(deps.config, issueKey);
  const issue = await readIssue(deps.jira, issueKey);
  assertInWorkspace(issue, workspace, issueKey);
  return buildView(deps, workspace, issue);
}

/**
 * Adds (`enabled`) or removes the opt-in label. Asking for the state the issue is already in
 * writes nothing. Every outcome, failures included, is left to the caller to audit.
 */
export async function setIssueOptIn(
  deps: OptInDeps,
  issueKey: string,
  enabled: boolean,
): Promise<SetOptInResult & { before: string[] }> {
  const workspace = workspaceForIssueKey(deps.config, issueKey);
  if (!isLabelMode(workspace)) {
    throw new IssueOptInError(
      "not_label_mode",
      isDelegationMode(workspace)
        ? `workspace "${workspace.id}" delegates by status (ADR 0044); a label never starts or stops AI work there`
        : `workspace "${workspace.id}" uses the legacy AI statuses; an opt-in label means nothing there`,
    );
  }
  const label = workspace.workflow.optInLabel as string;
  const issue = await readIssue(deps.jira, issueKey);
  assertInWorkspace(issue, workspace, issueKey);
  const before = issue.labels;
  if (labelsInclude(before, label) === enabled) {
    return {
      outcome: "unchanged",
      confirmedAfterError: false,
      before,
      view: await buildView(deps, workspace, issue),
    };
  }

  let writeError: unknown;
  try {
    if (enabled) {
      await deps.jira.addLabel(issue.key, label);
    } else {
      // Jira keeps a label's case; remove every spelling that counts as the opt-in label.
      for (const existing of before.filter((candidate) => labelsInclude([candidate], label))) {
        await deps.jira.removeLabel(issue.key, existing);
      }
    }
  } catch (error) {
    if (writeCertainlyFailed(error)) throw jiraFailure(issue.key, error);
    writeError = error;
  }

  let after: JiraIssue;
  try {
    after = await deps.jira.getIssue(issue.key);
  } catch (error) {
    throw new IssueOptInError(
      "unconfirmed",
      `could not re-read ${issue.key} to confirm the label change (${error instanceof Error ? error.message : String(error)}); check the issue in Jira`,
    );
  }
  if (labelsInclude(after.labels, label) !== enabled) {
    const cause = writeError instanceof Error ? ` after: ${writeError.message}` : "";
    throw new IssueOptInError(
      "unconfirmed",
      `Jira still shows labels [${after.labels.join(", ")}] on ${issue.key}${cause}`,
    );
  }
  return {
    outcome: "changed",
    confirmedAfterError: writeError !== undefined,
    before,
    view: await buildView(deps, workspace, after),
  };
}

async function buildView(
  deps: OptInDeps,
  workspace: WorkspaceConfig,
  issue: JiraIssue,
): Promise<IssueOptInView> {
  const labelMode = isLabelMode(workspace);
  const optInLabel = labelMode ? (workspace.workflow.optInLabel as string) : null;
  const optedIn = optInLabel !== null && labelsInclude(issue.labels, optInLabel);
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
    optInLabel,
    optedIn,
    requestStatus,
    openJob: job ? { jobId: job.id, kind: job.kind, state: job.state } : null,
    blockers: job ? [] : await blockersOf(deps, workspace, issue, optedIn),
    ...(isDelegationMode(workspace)
      ? { delegation: await readIssueDelegation(deps, workspace, issue) }
      : {}),
  };
}

async function blockersOf(
  deps: OptInDeps,
  workspace: WorkspaceConfig,
  issue: JiraIssue,
  optedIn: boolean,
): Promise<OptInBlocker[]> {
  // In `delegation` mode the stage (see `delegation`) says what happens next, not a blocker list.
  if (isDelegationMode(workspace)) return [];
  if (!isLabelMode(workspace)) {
    return [
      {
        code: "not_label_mode",
        message: `workspace "${workspace.id}" is in legacy mode; AI work is requested by status`,
      },
    ];
  }
  const { requestStatus } = workspace.workflow;
  const blockers: OptInBlocker[] = [];
  if (!optedIn) {
    blockers.push({ code: "opt_in_missing", message: "the opt-in label is not on the issue" });
  }
  const requested = issue.statusName.normalize("NFC") === requestStatus.normalize("NFC");
  if (!requested) {
    blockers.push({
      code: "not_requested",
      message: `the issue is in "${issue.statusName}", not "${requestStatus}"`,
    });
  }
  if (issue.assigneeAccountId === null) {
    blockers.push({ code: "no_assignee", message: "the issue has no assignee (human owner)" });
  }
  if (!optedIn || !requested) return blockers;

  // Only a request that could run is worth one changelog read.
  let approvalId: string | undefined;
  try {
    approvalId = await computeApprovalId(
      deps.jira,
      issue,
      requestStatus,
      workspace.workflow.optInLabel,
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
