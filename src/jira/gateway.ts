import type {
  CreateIssueInput,
  JiraComment,
  JiraIssue,
  JiraTransition,
  JiraUser,
  SearchIssuesOptions,
} from "./types.js";

/**
 * The subset of Jira operations the agent runtime/poller/pm/reporter depend
 * on. `JiraClient` implements this; tests substitute `FakeJiraGateway` instead.
 */
export interface JiraGateway {
  searchIssues(jql: string, opts?: SearchIssuesOptions): Promise<JiraIssue[]>;
  getIssue(key: string, fields?: string[]): Promise<JiraIssue>;
  addComment(key: string, body: string): Promise<void>;
  getComments(key: string): Promise<JiraComment[]>;
  getTransitions(key: string): Promise<JiraTransition[]>;
  transitionIssue(key: string, transitionName: string): Promise<void>;
  addLabel(key: string, label: string): Promise<void>;
  removeLabel(key: string, label: string): Promise<void>;
  /** The Jira user this client authenticates as (its own agent identity). */
  getMyself(): Promise<JiraUser>;
  searchUsers(query: string): Promise<JiraUser[]>;
  createIssue(input: CreateIssueInput): Promise<{ key: string }>;
  /** Pass `null` to unassign. */
  assignIssue(key: string, accountId: string | null): Promise<void>;
}
