import type { AppConfig } from "../config.js";
import type { JiraGateway } from "../jira/gateway.js";
import type { JiraIssue } from "../jira/types.js";
import type { JobStore } from "../job/store.js";

/**
 * Fetches candidate issues from Jira via config.jira.jql, then filters out
 * anything already claimed locally (defense against a stale/overlapping poll
 * within the same GGJIRA process; Jira's own status filter in the JQL is the
 * primary guard against re-selecting issues another run already moved on).
 */
export async function findCandidateIssues(
  jira: JiraGateway,
  config: AppConfig,
  store: JobStore,
): Promise<JiraIssue[]> {
  const issues = await jira.searchIssues(config.jira.jql, { maxResults: 50 });
  const claims = store.listClaims();
  return issues.filter((issue) => !(issue.key in claims));
}
