import type Database from "better-sqlite3";
import type { JobState } from "../contracts/job-state.js";
import type { JobKind } from "../contracts/protocol.js";
import { JiraApiError } from "../jira/client.js";
import type { JiraGateway } from "../jira/gateway.js";
import type { JiraIssue } from "../jira/types.js";
import type { RouterConfig, WorkspaceConfig } from "./config.js";
import { getOpenJobForIssue } from "./db/jobs.js";
import { type IssueDelegationView, readIssueDelegation } from "./issue-delegation.js";

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

export interface IssueView {
  issueKey: string;
  /** The issue in Jira's own UI, for people to open next to Router's view. */
  issueUrl: string;
  summary: string;
  statusName: string;
  labels: string[];
  assigned: boolean;
  workspaceId: string;
  requestStatus: string;
  openJob: { jobId: string; kind: JobKind; state: JobState } | null;
  /** Where the issue stands in the delegate → plan → approve flow (ADR 0044). */
  delegation: IssueDelegationView;
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
  const job = getOpenJobForIssue(deps.db, issue.key);
  return {
    issueKey: issue.key,
    issueUrl: `${deps.config.jira.baseUrl.replace(/\/+$/, "")}/browse/${encodeURIComponent(issue.key)}`,
    summary: issue.summary,
    statusName: issue.statusName,
    labels: issue.labels,
    assigned: issue.assigneeAccountId !== null,
    workspaceId: workspace.id,
    requestStatus: workspace.workflow.requestStatus,
    openJob: job ? { jobId: job.id, kind: job.kind, state: job.state } : null,
    delegation: await readIssueDelegation(
      {
        ...deps,
        baseBranch:
          deps.config.repositories.find((repo) => repo.id === workspace.repositoryId)?.baseBranch ??
          "main",
      },
      workspace,
      issue,
    ),
  };
}
