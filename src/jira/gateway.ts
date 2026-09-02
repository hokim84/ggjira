import type { JiraIssue, JiraTransition, SearchIssuesOptions } from "./types.js";

/**
 * The subset of Jira operations the poller/runner/reporter depend on.
 * `JiraClient` implements this; tests substitute `FakeJiraGateway` instead.
 */
export interface JiraGateway {
  searchIssues(jql: string, opts?: SearchIssuesOptions): Promise<JiraIssue[]>;
  getIssue(key: string, fields?: string[]): Promise<JiraIssue>;
  addComment(key: string, body: string): Promise<void>;
  getTransitions(key: string): Promise<JiraTransition[]>;
  transitionIssue(key: string, transitionName: string): Promise<void>;
  addLabel(key: string, label: string): Promise<void>;
  removeLabel(key: string, label: string): Promise<void>;
}
