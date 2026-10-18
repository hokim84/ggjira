import type { JobKind } from "../contracts/protocol.js";
import { checkImplementationReadiness } from "../issue/readiness.js";
import type { IssueRequirements } from "../issue/requirements.js";
import type { JiraIssue } from "../jira/types.js";
import type { PlanTaskMetadata } from "../pm/metadata.js";
import { normalizeLabel, type WorkspaceConfig } from "./config.js";

/**
 * Everything that differs between a workspace's `legacy` (AI-only statuses) and `label` (opt-in
 * label on the ordinary To Do / In Progress / Review / Done workflow) modes, in one place
 * (ADR 0037). Pure: no Jira or DB access.
 */

export function isLabelMode(workspace: WorkspaceConfig): boolean {
  return workspace.workflow.mode === "label";
}

/** The opt-in label in `label` mode; `undefined` in `legacy` mode, where labels opt nothing in. */
export function optInLabelOf(workspace: WorkspaceConfig): string | undefined {
  return isLabelMode(workspace) ? workspace.workflow.optInLabel : undefined;
}

/** Whether `labels` contains `label`, compared the way Jira compares labels. */
export function labelsInclude(labels: readonly string[], label: string): boolean {
  const wanted = normalizeLabel(label);
  return labels.some((candidate) => normalizeLabel(candidate) === wanted);
}

/** Whether the issue takes part in AI work at all. Always true in `legacy` mode. */
export function hasOptIn(issue: Pick<JiraIssue, "labels">, workspace: WorkspaceConfig): boolean {
  const optIn = optInLabelOf(workspace);
  return optIn === undefined || labelsInclude(issue.labels, optIn);
}

/** The status whose entry approves a job of `kind`. In `legacy` mode a planning request is
 *  approved by entering `planningStatus`, an implementation request by entering `requestStatus` —
 *  so moving an issue between the two is itself a new approval. In `label` mode both kinds are
 *  requested from the same "To Do". */
export function approvalStatusFor(kind: JobKind, workspace: WorkspaceConfig): string {
  const { planningStatus, requestStatus } = workspace.workflow;
  return kind === "planning" && planningStatus && !isLabelMode(workspace)
    ? planningStatus
    : requestStatus;
}

/** The statuses that make an issue in this workspace a candidate. */
export function candidateStatuses(workspace: WorkspaceConfig): string[] {
  const { requestStatus, planningStatus } = workspace.workflow;
  return planningStatus && planningStatus !== requestStatus && !isLabelMode(workspace)
    ? [requestStatus, planningStatus]
    : [requestStatus];
}

export interface JobKindInput {
  workspace: WorkspaceConfig;
  issue: Pick<JiraIssue, "statusName" | "isSubtask">;
  requirements: IssueRequirements;
  planTask: PlanTaskMetadata | null;
  /** The issue is the parent of a GGJIRA plan that split it into tasks (its `ggjira.plan` property
   *  lists task ids). Only read in `label` mode. */
  parentPlanHasTasks: boolean;
}

/**
 * Which job an approved request becomes.
 *
 * - `legacy`: the status it was requested from.
 * - `label`: the request itself. A plan task or a Jira subtask is always implemented (it cannot be
 *   split further; one with no contract is held for one, ADR 0034). Any other issue without
 *   acceptance criteria and verification goes to the PM first, which fills its contract in or
 *   splits it; so does a parent already split into tasks (moving it back to To Do re-plans it).
 */
export function resolveJobKind(input: JobKindInput): JobKind {
  const { workspace, issue } = input;
  if (!isLabelMode(workspace)) {
    return issue.statusName === workspace.workflow.planningStatus ? "planning" : "implementation";
  }
  if (input.planTask || issue.isSubtask) return "implementation";
  if (input.parentPlanHasTasks) return "planning";
  return checkImplementationReadiness(input.requirements).ready ? "implementation" : "planning";
}

/** Where a result asking for a human decision moves the issue: `null` keeps it where it is (in
 *  `label` mode it stays In Progress and the comment says what to do). */
export function decisionTransitionTarget(workspace: WorkspaceConfig): string | null {
  if (isLabelMode(workspace)) return null;
  return workspace.workflow.needsDecisionStatus ?? workspace.workflow.reviewStatus;
}

/** How a human approves a request again (a new approval id), for held-request reasons. */
export function reRequestHint(workspace: WorkspaceConfig): string {
  const { requestStatus, optInLabel } = workspace.workflow;
  return isLabelMode(workspace)
    ? `move the issue back to "${requestStatus}", or remove and re-add the "${optInLabel}" label`
    : `move the issue to "${requestStatus}" again`;
}
