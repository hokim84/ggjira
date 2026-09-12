import type {
  CreateIssueInput,
  JiraComment,
  JiraIssue,
  JiraProject,
  JiraProjectSummary,
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
  updateIssueDescription(key: string, description: string): Promise<void>;
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
  listProjects(): Promise<JiraProjectSummary[]>;
  getProject(key: string): Promise<JiraProject>;
  listProjectStatuses(projectKey: string): Promise<string[]>;
  /** Reads a Jira entity property on an issue; `null` when the property is absent (404). */
  getIssueProperty(key: string, propertyKey: string): Promise<unknown | null>;
  setIssueProperty(key: string, propertyKey: string, value: unknown): Promise<void>;
}
