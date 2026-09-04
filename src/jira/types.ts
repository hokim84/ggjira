export interface JiraIssue {
  key: string;
  id: string;
  summary: string;
  description: string | null;
  statusName: string;
  labels: string[];
  assigneeAccountId: string | null;
  issueTypeName: string | null;
  parentKey: string | null;
  projectKey: string | null;
}

export interface JiraTransition {
  id: string;
  name: string;
  toStatusName: string;
}

export interface SearchIssuesOptions {
  maxResults?: number;
  fields?: string[];
}

export interface JiraUser {
  accountId: string;
  displayName: string;
  emailAddress: string | null;
}

export interface JiraComment {
  id: string;
  authorAccountId: string | null;
  authorDisplayName: string | null;
  body: string;
  created: string;
}

export interface CreateIssueInput {
  projectKey: string;
  issueTypeName: string;
  summary: string;
  description?: string;
  parentKey?: string;
  assigneeAccountId?: string;
  labels?: string[];
}

export interface JiraProjectSummary {
  key: string;
  name: string;
}

export interface JiraProjectIssueType {
  name: string;
  subtask: boolean;
}

export interface JiraProject {
  key: string;
  name: string;
  issueTypes: JiraProjectIssueType[];
}
