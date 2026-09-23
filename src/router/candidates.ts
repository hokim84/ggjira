import type { JiraGateway } from "../jira/gateway.js";
import type { JiraIssue } from "../jira/types.js";
import type { WorkspaceConfig } from "./config.js";

/** Labels of the v4 meta issues (`[AGENT] <id>` Agent Profiles, `[GGJIRA] Workspace
 *  Configuration`). v5 no longer reads or writes them (ADR 0022), but projects that ran v4 still
 *  have them, and they must never be treated as work. */
const META_LABELS = new Set(["ggjira-agent", "ggjira-workspace"]);

/** The statuses that make an issue in this workspace a candidate: `requestStatus` always,
 *  plus `planningStatus` when the workspace has one configured. */
function candidateStatuses(workspace: WorkspaceConfig): string[] {
  const { requestStatus, planningStatus } = workspace.workflow;
  return planningStatus && planningStatus !== requestStatus
    ? [requestStatus, planningStatus]
    : [requestStatus];
}

export function buildWorkspaceJql(workspace: WorkspaceConfig): string {
  const projects = workspace.projectKeys.map((key) => `"${key}"`).join(", ");
  const statuses = candidateStatuses(workspace)
    .map((status) => `"${status}"`)
    .join(", ");
  return `project in (${projects}) AND status in (${statuses}) ORDER BY created ASC`;
}

/**
 * Router's supplemental Jira query for one workspace (docs/router-service-implementation-plan.md
 * §2 "웹훅과 보완 조회" — Router polls in addition to webhooks, since webhooks can be lost or
 * arrive out of order). Returns candidates oldest-first so the scheduler processes them in
 * creation order (§2 "실행 가능한 작업은 생성 순서대로 처리한다").
 */
export async function findWorkspaceCandidates(
  jira: JiraGateway,
  workspace: WorkspaceConfig,
): Promise<JiraIssue[]> {
  const issues = await jira.searchIssues(buildWorkspaceJql(workspace), {
    maxResults: 100,
    all: true,
  });
  return issues.filter((issue) => !issue.labels.some((label) => META_LABELS.has(label)));
}
