import type { JobKind } from "../contracts/protocol.js";
import type { JiraIssue } from "../jira/types.js";
import type { WorkspaceConfig } from "./config.js";

/**
 * Everything that differs between a workspace's `legacy` (AI-only request and planning statuses)
 * and `delegation` (delegated by status, always planned first, ADR 0044) modes, in one place.
 * Both are status-based: labels never request, approve or revoke work (ADR 0046). Pure: no Jira or
 * DB access.
 */

export type WorkflowMode = "legacy" | "delegation";

export function workflowModeOf(workspace: WorkspaceConfig): WorkflowMode {
  return workspace.workflow.mode ?? "legacy";
}

export function isDelegationMode(workspace: WorkspaceConfig): boolean {
  return workflowModeOf(workspace) === "delegation";
}

/** The status whose entry approves a job of `kind`. In `legacy` mode a planning request is
 *  approved by entering `planningStatus`, an implementation request by entering `requestStatus` —
 *  so moving an issue between the two is itself a new approval. In `delegation` mode a plan is
 *  requested from `requestStatus`; an implementation runs in `inProgressStatus`, approved by the
 *  move there from `planReviewStatus` (src/router/delegation.ts). */
export function approvalStatusFor(kind: JobKind, workspace: WorkspaceConfig): string {
  const { planningStatus, requestStatus, inProgressStatus } = workspace.workflow;
  switch (workflowModeOf(workspace)) {
    case "delegation":
      return kind === "planning" ? requestStatus : inProgressStatus;
    case "legacy":
      return kind === "planning" && planningStatus ? planningStatus : requestStatus;
  }
}

/** The statuses that make an issue in this workspace a candidate by status alone. In `delegation`
 *  mode approved plans and their tasks are found from Router's own records instead, never by the
 *  shared in-progress status. */
export function candidateStatuses(workspace: WorkspaceConfig): string[] {
  const { requestStatus, planningStatus } = workspace.workflow;
  return !isDelegationMode(workspace) && planningStatus && planningStatus !== requestStatus
    ? [requestStatus, planningStatus]
    : [requestStatus];
}

export interface JobKindInput {
  workspace: WorkspaceConfig;
  issue: Pick<JiraIssue, "statusName">;
}

/** Which job an approved request becomes, by the status it is in: `legacy` plans only what was
 *  requested from `planningStatus`; `delegation` plans every request and implements only an
 *  approved plan. */
export function resolveJobKind({ workspace, issue }: JobKindInput): JobKind {
  const { requestStatus, planningStatus } = workspace.workflow;
  switch (workflowModeOf(workspace)) {
    case "delegation":
      return issue.statusName === requestStatus ? "planning" : "implementation";
    case "legacy":
      return issue.statusName === planningStatus ? "planning" : "implementation";
  }
}

/** Where a result asking for a human decision moves the issue: `null` keeps it where it is. In
 *  `delegation` mode a planning question waits with the plans for review; an implementation stop
 *  stays in progress. */
export function decisionTransitionTarget(workspace: WorkspaceConfig, kind: JobKind): string | null {
  const { planReviewStatus, needsDecisionStatus, reviewStatus } = workspace.workflow;
  switch (workflowModeOf(workspace)) {
    case "delegation":
      return kind === "planning" ? (planReviewStatus ?? null) : null;
    case "legacy":
      return needsDecisionStatus ?? reviewStatus;
  }
}

/** How a human approves a request of `kind` again (a new approval id), for held-request reasons
 *  and rework notes. */
export function reRequestHint(
  workspace: WorkspaceConfig,
  kind: JobKind = "implementation",
): string {
  const { requestStatus, planReviewStatus, inProgressStatus } = workspace.workflow;
  if (isDelegationMode(workspace) && kind === "implementation") {
    return `move the issue to "${planReviewStatus}" and then to "${inProgressStatus}" to run the approved plan again, or to "${requestStatus}" to plan it again`;
  }
  return `move the issue to "${requestStatus}" again`;
}

/**
 * Whether a dependency no longer blocks the issue that names it. `legacy`: it has left the request
 * and in-progress statuses — reaching `reviewStatus` counts as done. `delegation`: only
 * `doneStatus`, or a result a human confirmed on the review screen (F01); reaching review alone is
 * not completion (ADR 0044).
 */
export function isDependencyResolved(
  workspace: WorkspaceConfig,
  statusName: string,
  reviewConfirmed: boolean,
): boolean {
  const { requestStatus, planningStatus, inProgressStatus, doneStatus } = workspace.workflow;
  switch (workflowModeOf(workspace)) {
    case "delegation":
      return (doneStatus !== undefined && statusName === doneStatus) || reviewConfirmed;
    case "legacy":
      return (
        statusName !== requestStatus &&
        statusName !== planningStatus &&
        statusName !== inProgressStatus
      );
  }
}
