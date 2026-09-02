import type { JiraGateway } from "./gateway.js";
import type { JiraIssue, JiraTransition, SearchIssuesOptions } from "./types.js";

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

/** Test-only in-memory Jira substitute. Never used by production code. */
export class FakeJiraGateway implements JiraGateway {
  readonly comments: RecordedComment[] = [];
  readonly transitions: RecordedTransition[] = [];
  readonly labelChanges: RecordedLabel[] = [];

  private readonly issues = new Map<string, JiraIssue>();
  private readonly transitionsByKey = new Map<string, JiraTransition[]>();
  private readonly failingTransitions = new Set<string>();
  private readonly commentFailurePredicates = new Map<string, (body: string) => boolean>();

  seedIssue(issue: JiraIssue, availableTransitions: JiraTransition[] = []): void {
    this.issues.set(issue.key, issue);
    this.transitionsByKey.set(issue.key, availableTransitions);
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

  async searchIssues(_jql: string, opts: SearchIssuesOptions = {}): Promise<JiraIssue[]> {
    const all = [...this.issues.values()];
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
}
