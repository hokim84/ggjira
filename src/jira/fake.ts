import { StatusNotReachableError } from "./client.js";
import type { JiraGateway } from "./gateway.js";
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

export interface RecordedComment {
  key: string;
  body: string;
}

export interface RecordedTransition {
  key: string;
  transitionName: string;
}

export interface RecordedLabel {
  key: string;
  label: string;
  action: "add" | "remove";
}

export interface RecordedAssignment {
  key: string;
  accountId: string | null;
}

/** Strips a trailing "ORDER BY ..." clause and splits the rest on AND. */
function splitJqlClauses(jql: string): string[] {
  const withoutOrderBy = jql.replace(/\border\s+by\s+.+$/i, "").trim();
  return withoutOrderBy
    .split(/\s+and\s+/i)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

function unquote(value: string): string {
  return value.trim().replace(/^"(.*)"$/, "$1");
}

/**
 * Test-only in-memory Jira substitute. Never used by production code.
 *
 * `searchIssues` understands a small, literal subset of JQL — clauses joined
 * by AND, comparing assignee/status/parent/project/labels — enough to
 * exercise `findAssignedJobs` and PM subtask lookups without a real Jira.
 */
export class FakeJiraGateway implements JiraGateway {
  readonly comments: RecordedComment[] = [];
  readonly transitions: RecordedTransition[] = [];
  readonly labelChanges: RecordedLabel[] = [];
  readonly assignments: RecordedAssignment[] = [];
  readonly createdIssues: CreateIssueInput[] = [];

  private readonly issues = new Map<string, JiraIssue>();
  private readonly transitionsByKey = new Map<string, JiraTransition[]>();
  private readonly commentsByKey = new Map<string, JiraComment[]>();
  private readonly usersByAccountId = new Map<string, JiraUser>();
  private readonly failingTransitions = new Set<string>();
  private readonly commentFailurePredicates = new Map<string, (body: string) => boolean>();
  private readonly projects = new Map<string, JiraProject>();
  private readonly projectStatuses = new Map<string, string[]>();
  private readonly properties = new Map<string, Map<string, unknown>>();
  private self: JiraUser = {
    accountId: "self-account-id",
    displayName: "GGJIRA Test Agent",
    emailAddress: null,
  };
  private issueCounter = 0;

  seedIssue(
    issue: Partial<JiraIssue> & Pick<JiraIssue, "key">,
    availableTransitions: JiraTransition[] = [],
  ): void {
    const full: JiraIssue = {
      id: issue.id ?? issue.key,
      key: issue.key,
      summary: issue.summary ?? "",
      description: issue.description ?? null,
      statusName: issue.statusName ?? "",
      labels: issue.labels ?? [],
      assigneeAccountId: issue.assigneeAccountId ?? null,
      issueTypeName: issue.issueTypeName ?? null,
      parentKey: issue.parentKey ?? null,
      projectKey: issue.projectKey ?? issue.key.split("-")[0] ?? null,
      updatedAt: issue.updatedAt ?? new Date().toISOString(),
    };
    this.issues.set(full.key, full);
    this.transitionsByKey.set(full.key, availableTransitions);
  }

  seedUser(user: JiraUser): void {
    this.usersByAccountId.set(user.accountId, user);
  }

  seedProject(project: JiraProject): void {
    this.projects.set(project.key, project);
  }

  seedProjectStatuses(projectKey: string, statuses: string[]): void {
    this.projectStatuses.set(projectKey, statuses);
  }

  async listProjectStatuses(projectKey: string): Promise<string[]> {
    return this.projectStatuses.get(projectKey) ?? [];
  }

  /** Reads back what setIssueProperty stored, for assertions in tests. */
  getStoredProperty(key: string, propertyKey: string): unknown | undefined {
    return this.properties.get(key)?.get(propertyKey);
  }

  /** Sets the identity `getMyself()`/`currentUser()` resolve to for this gateway. */
  setSelf(user: JiraUser): void {
    this.self = user;
    this.seedUser(user);
  }

  seedComment(key: string, comment: Partial<JiraComment> & Pick<JiraComment, "body">): void {
    const existing = this.commentsByKey.get(key) ?? [];
    existing.push({
      id: comment.id ?? `${key}-c${existing.length + 1}`,
      authorAccountId: comment.authorAccountId ?? null,
      authorDisplayName: comment.authorDisplayName ?? null,
      body: comment.body,
      created: comment.created ?? new Date().toISOString(),
    });
    this.commentsByKey.set(key, existing);
  }

  /** Makes the next transitionIssue call for this key throw, simulating a claim race. */
  failNextTransition(key: string): void {
    this.failingTransitions.add(key);
  }

  /**
   * Makes the next addComment call for this key whose body matches `predicate`
   * throw, simulating a Jira write outage. Defaults to matching any body.
   */
  failNextComment(key: string, predicate: (body: string) => boolean = () => true): void {
    this.commentFailurePredicates.set(key, predicate);
  }

  private matchesClause(issue: JiraIssue, clause: string): boolean {
    if (/^assignee\s*=\s*currentUser\(\)$/i.test(clause)) {
      return issue.assigneeAccountId === this.self.accountId;
    }

    const statusInMatch = clause.match(/^status\s+in\s*\((.+)\)$/i);
    if (statusInMatch?.[1]) {
      return statusInMatch[1].split(",").map(unquote).includes(issue.statusName);
    }

    const statusMatch = clause.match(/^status\s*=\s*(.+)$/i);
    if (statusMatch) {
      return issue.statusName === unquote(statusMatch[1] ?? "");
    }

    const parentMatch = clause.match(/^parent\s*=\s*(.+)$/i);
    if (parentMatch) {
      return issue.parentKey === unquote(parentMatch[1] ?? "");
    }

    const projectMatch = clause.match(/^project\s*=\s*(.+)$/i);
    if (projectMatch) {
      return issue.projectKey === unquote(projectMatch[1] ?? "");
    }

    const labelsMatch = clause.match(/^labels\s*=\s*(.+)$/i);
    if (labelsMatch) {
      return issue.labels.includes(unquote(labelsMatch[1] ?? ""));
    }

    // Unknown clause shape: fail closed rather than silently matching everything.
    throw new Error(`FakeJiraGateway: unsupported JQL clause "${clause}"`);
  }

  async searchIssues(jql: string, opts: SearchIssuesOptions = {}): Promise<JiraIssue[]> {
    const clauses = splitJqlClauses(jql);
    const all = [...this.issues.values()].filter((issue) =>
      clauses.every((clause) => this.matchesClause(issue, clause)),
    );
    return opts.maxResults ? all.slice(0, opts.maxResults) : all;
  }

  async getIssue(key: string): Promise<JiraIssue> {
    const issue = this.issues.get(key);
    if (!issue) throw new Error(`FakeJiraGateway: unknown issue ${key}`);
    return issue;
  }

  async addComment(key: string, body: string): Promise<void> {
    const predicate = this.commentFailurePredicates.get(key);
    if (predicate?.(body)) {
      this.commentFailurePredicates.delete(key);
      throw new Error(`FakeJiraGateway: addComment rejected for ${key}`);
    }
    this.comments.push({ key, body });
    this.seedComment(key, {
      body,
      authorAccountId: this.self.accountId,
      authorDisplayName: this.self.displayName,
    });
  }

  async getComments(key: string): Promise<JiraComment[]> {
    return this.commentsByKey.get(key) ?? [];
  }

  async getTransitions(key: string): Promise<JiraTransition[]> {
    return this.transitionsByKey.get(key) ?? [];
  }

  async transitionIssue(key: string, transitionName: string): Promise<void> {
    if (this.failingTransitions.has(key)) {
      this.failingTransitions.delete(key);
      throw new Error(`FakeJiraGateway: transition "${transitionName}" rejected for ${key}`);
    }
    this.transitions.push({ key, transitionName });
    const issue = this.issues.get(key);
    if (issue) {
      const transitions = this.transitionsByKey.get(key) ?? [];
      const match = transitions.find((t) => t.name === transitionName);
      this.issues.set(key, { ...issue, statusName: match?.toStatusName ?? issue.statusName });
    }
  }

  async transitionIssueToStatus(key: string, targetStatusName: string): Promise<void> {
    if (this.failingTransitions.has(key)) {
      this.failingTransitions.delete(key);
      throw new Error(`FakeJiraGateway: transition to "${targetStatusName}" rejected for ${key}`);
    }
    const target = targetStatusName.normalize("NFC");
    const issue = this.issues.get(key);
    if (issue?.statusName.normalize("NFC") === target) return;
    const transitions = this.transitionsByKey.get(key) ?? [];
    const match = transitions.find((t) => t.toStatusName.normalize("NFC") === target);
    if (!match) {
      throw new StatusNotReachableError(
        key,
        targetStatusName,
        issue?.statusName ?? "(unknown)",
        transitions.map((t) => t.toStatusName),
      );
    }
    this.transitions.push({ key, transitionName: match.name });
    if (issue) this.issues.set(key, { ...issue, statusName: match.toStatusName });
  }

  async addLabel(key: string, label: string): Promise<void> {
    this.labelChanges.push({ key, label, action: "add" });
    const issue = this.issues.get(key);
    if (issue && !issue.labels.includes(label)) {
      this.issues.set(key, { ...issue, labels: [...issue.labels, label] });
    }
  }

  async removeLabel(key: string, label: string): Promise<void> {
    this.labelChanges.push({ key, label, action: "remove" });
    const issue = this.issues.get(key);
    if (issue) {
      this.issues.set(key, { ...issue, labels: issue.labels.filter((l) => l !== label) });
    }
  }

  async updateIssueDescription(key: string, description: string): Promise<void> {
    const issue = this.issues.get(key);
    if (!issue) throw new Error(`FakeJiraGateway: unknown issue ${key}`);
    this.issues.set(key, { ...issue, description, updatedAt: new Date().toISOString() });
  }

  async getMyself(): Promise<JiraUser> {
    return this.self;
  }

  async searchUsers(query: string): Promise<JiraUser[]> {
    const needle = query.toLowerCase();
    return [...this.usersByAccountId.values()].filter(
      (user) =>
        user.displayName.toLowerCase().includes(needle) ||
        user.emailAddress?.toLowerCase().includes(needle),
    );
  }

  async createIssue(input: CreateIssueInput): Promise<{ key: string }> {
    this.createdIssues.push(input);
    this.issueCounter += 1;
    const key = `${input.projectKey}-${1000 + this.issueCounter}`;
    this.seedIssue({
      key,
      summary: input.summary,
      description: input.description ?? null,
      statusName: "To Do",
      labels: input.labels ?? [],
      issueTypeName: input.issueTypeName,
      parentKey: input.parentKey ?? null,
      projectKey: input.projectKey,
      assigneeAccountId: input.assigneeAccountId ?? null,
    });
    if (input.assigneeAccountId) {
      this.assignments.push({ key, accountId: input.assigneeAccountId });
    }
    return { key };
  }

  async assignIssue(key: string, accountId: string | null): Promise<void> {
    this.assignments.push({ key, accountId });
    const issue = this.issues.get(key);
    if (issue) {
      this.issues.set(key, { ...issue, assigneeAccountId: accountId });
    }
  }

  async listProjects(): Promise<JiraProjectSummary[]> {
    return [...this.projects.values()].map((p) => ({ key: p.key, name: p.name }));
  }

  async getProject(key: string): Promise<JiraProject> {
    const project = this.projects.get(key);
    if (!project) throw new Error(`FakeJiraGateway: unknown project ${key}`);
    return project;
  }

  async getIssueProperty(key: string, propertyKey: string): Promise<unknown | null> {
    return this.properties.get(key)?.get(propertyKey) ?? null;
  }

  async setIssueProperty(key: string, propertyKey: string, value: unknown): Promise<void> {
    const forIssue = this.properties.get(key) ?? new Map<string, unknown>();
    forIssue.set(propertyKey, value);
    this.properties.set(key, forIssue);
  }
}
