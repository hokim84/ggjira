import type { JobKind } from "../contracts/protocol.js";
import type { MessageLanguage } from "./comment-text.js";
import type { WorkspaceConfig } from "./config.js";

/**
 * The workspace workflow's rules (ADR 0044, ADR 0047): delegated by status, always planned first,
 * implemented only under a plan a human approved. Labels never request, approve or revoke work
 * (ADR 0046). Pure: no Jira or DB access.
 */

/** The status whose entry approves a job of `kind`: a plan is requested from `requestStatus`; an
 *  implementation runs in `inProgressStatus`, approved by the move there from `requestStatus`
 *  (src/router/delegation.ts). */
export function approvalStatusFor(kind: JobKind, workspace: WorkspaceConfig): string {
  const { requestStatus, inProgressStatus } = workspace.workflow;
  return kind !== "implementation" ? requestStatus : inProgressStatus;
}

/** Where a result asking for a human decision moves the issue: a planning question waits with the
 *  plans for review; an implementation stop stays in progress (`null`). */
export function decisionTransitionTarget(workspace: WorkspaceConfig, kind: JobKind): string | null {
  return null;
}

/** How a human approves a request of `kind` again (a new approval id), for held-request reasons
 *  and rework notes. */
export function reRequestHint(
  workspace: WorkspaceConfig,
  kind: JobKind = "implementation",
  language: MessageLanguage = "en",
): string {
  const { requestStatus, inProgressStatus } = workspace.workflow;
  if (language === "ko") {
    return kind === "implementation"
      ? `이슈를 "${requestStatus}" 상태로 옮겨 다시 계획한 뒤, 완성된 계획을 확인하고 "${inProgressStatus}" 상태로 옮기세요`
      : `담당자가 "재시도" 댓글을 남기거나 제목·설명을 수정하세요`;
  }
  return kind === "implementation"
    ? `move the issue to "${requestStatus}", wait for the new plan, then approve it by moving to "${inProgressStatus}"`
    : 'ask the assignee to comment "재시도" or edit the title or description';
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
