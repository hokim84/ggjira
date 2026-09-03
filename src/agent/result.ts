/**
 * The standardized outcome of one job execution (CLAUDE.md / phase 2 §4.4),
 * produced by a role's JobHandler and turned into a Jira comment + transition
 * by the reporter. Every role reports through this one shape so a human or
 * PM Agent reading Jira never needs to know which role or provider ran.
 */
export type ExecutionStatus = "succeeded" | "failed" | "needs_decision" | "planned";

export interface ExecutionResult {
  status: ExecutionStatus;
  summary: string;
  /** The git branch the work landed on, when applicable (implement role). */
  branch?: string;
  changes?: string[];
  validation?: string[];
  artifacts?: string[];
  failureReason?: string;
  /** An issue key blocking completion, referenced in the failure comment. */
  blockingIssue?: string;
  /** True when a "failed" result specifically means the worker hit its timeout. */
  timedOut?: boolean;
  /**
   * Full markdown for a "needs_decision" result's comment (options, pros/cons,
   * recommendation) — built by the pm role, since its shape is structurally
   * different from the standard success/failure template.
   */
  decisionRequest?: string;
}
