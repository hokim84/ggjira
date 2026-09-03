import type { AppConfig } from "../config.js";
import type { JiraGateway } from "../jira/gateway.js";
import type { JiraIssue } from "../jira/types.js";
import type { JobStore } from "../job/store.js";

/** Builds the JQL for "issues assigned to me that are ready to claim", unless config overrides it. */
export function buildAssignedJql(config: AppConfig): string {
  if (config.jira.jql) return config.jira.jql;
  return `assignee = currentUser() AND status = "${config.workflow.readyStatus}" ORDER BY created ASC`;
}

/**
 * Fetches issues assigned to this agent's Jira identity that are ready to
 * claim, then filters out anything already claimed locally (defense against
 * a stale/overlapping poll within the same GGJIRA process; Jira's own
 * assignee + status filter in the JQL is the primary guard against
 * re-selecting issues another run already moved on).
 */
export async function findAssignedJobs(
  jira: JiraGateway,
  config: AppConfig,
  store: JobStore,
): Promise<JiraIssue[]> {
  const issues = await jira.searchIssues(buildAssignedJql(config), { maxResults: 50 });
  const claims = store.listClaims();
  return issues.filter((issue) => !(issue.key in claims));
}
