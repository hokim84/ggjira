/**
 * What an approval approves, beyond the issue's title and description: the executable unit's
 * contract from the plan a human approved (ADR 0047, built in src/pm/contract.ts). A planning
 * request has none yet — completing the request is the plan's job.
 */
export interface IssueRequirements {
  objective: string;
  acceptanceCriteria: string[];
  /** Jira issue keys (or text naming them) that must be done first. */
  dependencies: string[];
  constraints: string[];
  requiredCapabilities: string[];
  suggestedExecutionStrategy: string | null;
  /** The scope contract (ADR 0034). */
  verification: string[];
  inScope: string[];
  outOfScope: string[];
  /** Where the change is expected to land — a hint for the implementer, never enforced. */
  affectedAreas: string[];
  /** Globs the implementation may touch; enforced by the worker only when non-empty. */
  allowedPaths: string[];
}
