import type { JobKind } from "../contracts/protocol.js";
import { checkImplementationReadiness } from "../issue/readiness.js";
import type { IssueRequirements } from "../issue/requirements.js";
import type { JiraIssue } from "../jira/types.js";
import type { PlanTaskMetadata } from "../pm/metadata.js";
import { normalizeLabel, type WorkspaceConfig } from "./config.js";

/**
 * Everything that differs between a workspace's `legacy` (AI-only statuses), `label` (opt-in
 * label on the ordinary To Do / In Progress / Review / Done workflow, ADR 0037) and `delegation`
 * (delegated by status, always planned first, ADR 0044) modes, in one place. Pure: no Jira or DB
 * access.
 */

export type WorkflowMode = "legacy" | "label" | "delegation";

export function workflowModeOf(workspace: WorkspaceConfig): WorkflowMode {
  return workspace.workflow.mode ?? "legacy";
}

export function isLabelMode(workspace: WorkspaceConfig): boolean {
  return workflowModeOf(workspace) === "label";
}

export function isDelegationMode(workspace: WorkspaceConfig): boolean {
  return workflowModeOf(workspace) === "delegation";
}

/** The opt-in label in `label` mode; `undefined` otherwise, where labels opt nothing in. */
export function optInLabelOf(workspace: WorkspaceConfig): string | undefined {
  return isLabelMode(workspace) ? workspace.workflow.optInLabel : undefined;
}

/** Whether `labels` contains `label`, compared the way Jira compares labels. */
export function labelsInclude(labels: readonly string[], label: string): boolean {
  const wanted = normalizeLabel(label);
  return labels.some((candidate) => normalizeLabel(candidate) === wanted);
}

/** Whether the issue takes part in AI work at all. Always true outside `label` mode. */
export function hasOptIn(issue: Pick<JiraIssue, "labels">, workspace: WorkspaceConfig): boolean {
  const optIn = optInLabelOf(workspace);
  return optIn === undefined || labelsInclude(issue.labels, optIn);
}

/** The status whose entry approves a job of `kind`. In `legacy` mode a planning request is
 *  approved by entering `planningStatus`, an implementation request by entering `requestStatus` —
 *  so moving an issue between the two is itself a new approval. In `label` mode both kinds are
 *  requested from the same "To Do". In `delegation` mode a plan is requested from `requestStatus`;
 *  an implementation runs in `inProgressStatus`, approved by the move there from
 *  `planReviewStatus` (src/router/delegation.ts). */
export function approvalStatusFor(kind: JobKind, workspace: WorkspaceConfig): string {
  const { planningStatus, requestStatus, inProgressStatus } = workspace.workflow;
  switch (workflowModeOf(workspace)) {
    case "delegation":
      return kind === "planning" ? requestStatus : inProgressStatus;
    case "label":
      return requestStatus;
    case "legacy":
      return kind === "planning" && planningStatus ? planningStatus : requestStatus;
  }
}

/** The statuses that make an issue in this workspace a candidate by status alone. In `delegation`
 *  mode approved plans and their tasks are found from Router's own records instead, never by the
 *  shared in-progress status. */
export function candidateStatuses(workspace: WorkspaceConfig): string[] {
  const { requestStatus, planningStatus } = workspace.workflow;
  return planningStatus &&
    planningStatus !== requestStatus &&
    workflowModeOf(workspace) === "legacy"
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
 * - `delegation`: a request is always planned first; only an approved plan is implemented.
 */
export function resolveJobKind(input: JobKindInput): JobKind {
  const { workspace, issue } = input;
  switch (workflowModeOf(workspace)) {
    case "legacy":
      return issue.statusName === workspace.workflow.planningStatus ? "planning" : "implementation";
    case "delegation":
      return issue.statusName === workspace.workflow.requestStatus ? "planning" : "implementation";
    case "label":
      break;
  }
  if (input.planTask || issue.isSubtask) return "implementation";
  if (input.parentPlanHasTasks) return "planning";
  return checkImplementationReadiness(input.requirements).ready ? "implementation" : "planning";
}

/** Where a result asking for a human decision moves the issue: `null` keeps it where it is (in
 *  `label` mode it stays In Progress and the comment says what to do). In `delegation` mode a
 *  planning question waits with the plans for review; an implementation stop stays In Progress. */
export function decisionTransitionTarget(workspace: WorkspaceConfig, kind: JobKind): string | null {
  switch (workflowModeOf(workspace)) {
    case "label":
      return null;
    case "delegation":
      return kind === "planning" ? (workspace.workflow.planReviewStatus ?? null) : null;
    case "legacy":
      return workspace.workflow.needsDecisionStatus ?? workspace.workflow.reviewStatus;
  }
}

/** How a human approves a request of `kind` again (a new approval id), for held-request reasons
 *  and rework notes. */
export function reRequestHint(
  workspace: WorkspaceConfig,
  kind: JobKind = "implementation",
): string {
  const { requestStatus, optInLabel, planReviewStatus, inProgressStatus } = workspace.workflow;
  switch (workflowModeOf(workspace)) {
    case "label":
      return `move the issue back to "${requestStatus}", or remove and re-add the "${optInLabel}" label`;
    case "delegation":
      return kind === "planning"
        ? `move the issue to "${requestStatus}" again`
        : `move the issue to "${planReviewStatus}" and then to "${inProgressStatus}" to run the approved plan again, or to "${requestStatus}" to plan it again`;
    case "legacy":
      return `move the issue to "${requestStatus}" again`;
  }
}

/**
 * Whether a dependency no longer blocks the issue that names it. `legacy`/`label`: it has left the
 * request and in-progress statuses — reaching `reviewStatus` counts as done. `delegation`: only
 * `doneStatus`, or a result a human confirmed on the review screen (F01); reaching review alone is
 * not completion (ADR 0044).
 */
export function isDependencyResolved(
  workspace: WorkspaceConfig,
  statusName: string,
  reviewConfirmed: boolean,
): boolean {
  const { requestStatus, planningStatus, inProgressStatus, doneStatus } = workspace.workflow;
  if (isDelegationMode(workspace)) {
    return (doneStatus !== undefined && statusName === doneStatus) || reviewConfirmed;
  }
  return (
    statusName !== requestStatus && statusName !== planningStatus && statusName !== inProgressStatus
  );
}
