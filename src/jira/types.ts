export interface JiraIssue {
  key: string;
  id: string;
  summary: string;
  description: string | null;
  statusName: string;
  labels: string[];
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
