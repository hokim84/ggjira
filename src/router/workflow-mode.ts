import type { JobKind } from "../contracts/protocol.js";
import type { WorkspaceConfig } from "./config.js";

/**
 * The workspace workflow's rules (ADR 0044, ADR 0047): delegated by status, always planned first,
 * implemented only under a plan a human approved. Labels never request, approve or revoke work
 * (ADR 0046). Pure: no Jira or DB access.
 */

/** The status whose entry approves a job of `kind`: a plan is requested from `requestStatus`; an
 *  implementation runs in `inProgressStatus`, approved by the move there from `planReviewStatus`
 *  (src/router/delegation.ts). */
export function approvalStatusFor(kind: JobKind, workspace: WorkspaceConfig): string {
  const { requestStatus, inProgressStatus } = workspace.workflow;
  return kind === "planning" ? requestStatus : inProgressStatus;
}

/** Where a result asking for a human decision moves the issue: a planning question waits with the
 *  plans for review; an implementation stop stays in progress (`null`). */
export function decisionTransitionTarget(workspace: WorkspaceConfig, kind: JobKind): string | null {
  return kind === "planning" ? workspace.workflow.planReviewStatus : null;
}

/** How a human approves a request of `kind` again (a new approval id), for held-request reasons
 *  and rework notes. */
export function reRequestHint(
  workspace: WorkspaceConfig,
  kind: JobKind = "implementation",
): string {
  const { requestStatus, planReviewStatus, inProgressStatus } = workspace.workflow;
  return kind === "implementation"
    ? `move the issue to "${planReviewStatus}" and then to "${inProgressStatus}" to run the approved plan again, or to "${requestStatus}" to plan it again`
    : `move the issue out of "${requestStatus}" and back into it`;
}

/** Whether a dependency no longer blocks the issue that names it: only `doneStatus`, or a result a
 *  human confirmed on the review screen (F01). Reaching review alone is not completion. */
export function isDependencyResolved(
  workspace: WorkspaceConfig,
  statusName: string,
  reviewConfirmed: boolean,
): boolean {
  const { doneStatus } = workspace.workflow;
  return (doneStatus !== undefined && statusName === doneStatus) || reviewConfirmed;
}
