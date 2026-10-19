import type { JiraGateway } from "../jira/gateway.js";
import type { JiraIssue } from "../jira/types.js";
import type { WorkspaceConfig } from "./config.js";
import { candidateStatuses, hasOptIn, optInLabelOf } from "./workflow-mode.js";

/** Labels of the v4 meta issues (`[AGENT] <id>` Agent Profiles, `[GGJIRA] Workspace
 *  Configuration`). v5 no longer reads or writes them (ADR 0022), but projects that ran v4 still
 *  have them, and they must never be treated as work. */
const META_LABELS = new Set(["ggjira-agent", "ggjira-workspace"]);

function jqlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** The request status(es) for the workspace, and in `label` mode its opt-in label (ADR 0037). */
export function buildWorkspaceJql(workspace: WorkspaceConfig): string {
  const projects = workspace.projectKeys.map((key) => `"${key}"`).join(", ");
  const statuses = candidateStatuses(workspace)
    .map((status) => `"${status}"`)
    .join(", ");
  const optIn = optInLabelOf(workspace);
  const label = optIn ? ` AND labels = ${jqlString(optIn)}` : "";
  return `project in (${projects}) AND status in (${statuses})${label} ORDER BY created ASC`;
}

/**
 * Router's supplemental Jira query for one workspace (docs/router-service-implementation-plan.md
 * §2 "웹훅과 보완 조회" — Router polls in addition to webhooks, since webhooks can be lost or
 * arrive out of order). Returns candidates oldest-first so the scheduler processes them in
 * creation order (§2 "실행 가능한 작업은 생성 순서대로 처리한다"). The opt-in label is checked again
 * here, so a JQL that matched more loosely never makes an issue a candidate.
 */
export async function findWorkspaceCandidates(
  jira: JiraGateway,
  workspace: WorkspaceConfig,
): Promise<JiraIssue[]> {
  const issues = await jira.searchIssues(buildWorkspaceJql(workspace), {
    maxResults: 100,
    all: true,
  });
  return issues.filter(
    (issue) => !issue.labels.some((label) => META_LABELS.has(label)) && hasOptIn(issue, workspace),
  );
}
