import type { JobKind } from "../contracts/protocol.js";
import type { JiraIssue } from "../jira/types.js";
import type { WorkspaceConfig } from "./config.js";

/** Status-based workflows. Labels never request, approve or revoke work (ADR 0046). */
export type WorkflowMode = "legacy" | "delegation";
export function workflowModeOf(workspace: WorkspaceConfig): WorkflowMode {
  return workspace.workflow.mode ?? "legacy";
}
export function isDelegationMode(workspace: WorkspaceConfig): boolean {
  return workflowModeOf(workspace) === "delegation";
}
export function approvalStatusFor(kind: JobKind, workspace: WorkspaceConfig): string {
  const { planningStatus, requestStatus, inProgressStatus } = workspace.workflow;
  return isDelegationMode(workspace)
    ? kind === "planning"
      ? requestStatus
      : inProgressStatus
    : kind === "planning" && planningStatus
      ? planningStatus
      : requestStatus;
}
export function candidateStatuses(workspace: WorkspaceConfig): string[] {
  const { requestStatus, planningStatus } = workspace.workflow;
  return !isDelegationMode(workspace) && planningStatus && planningStatus !== requestStatus
    ? [requestStatus, planningStatus]
    : [requestStatus];
}
export interface JobKindInput {
  workspace: WorkspaceConfig;
  issue: Pick<JiraIssue, "statusName" | "isSubtask">;
}
export function resolveJobKind({ workspace, issue }: JobKindInput): JobKind {
  return isDelegationMode(workspace)
    ? issue.statusName === workspace.workflow.requestStatus
      ? "planning"
      : "implementation"
    : issue.statusName === workspace.workflow.planningStatus
      ? "planning"
      : "implementation";
}
export function decisionTransitionTarget(workspace: WorkspaceConfig, kind: JobKind): string | null {
  return isDelegationMode(workspace)
    ? kind === "planning"
      ? (workspace.workflow.planReviewStatus ?? null)
      : null
    : (workspace.workflow.needsDecisionStatus ?? workspace.workflow.reviewStatus);
}
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
export function isDependencyResolved(
  workspace: WorkspaceConfig,
  statusName: string,
  reviewConfirmed: boolean,
): boolean {
  const { requestStatus, planningStatus, inProgressStatus, doneStatus } = workspace.workflow;
  return isDelegationMode(workspace)
    ? (doneStatus !== undefined && statusName === doneStatus) || reviewConfirmed
    : statusName !== requestStatus &&
        statusName !== planningStatus &&
        statusName !== inProgressStatus;
}
