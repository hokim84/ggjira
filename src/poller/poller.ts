import type { AppConfig } from "../config.js";
import type { JiraGateway } from "../jira/gateway.js";
import type { JiraIssue } from "../jira/types.js";
import type { JobStore } from "../job/store.js";
import { AGENT_LABEL, WORKSPACE_LABEL } from "../profile/types.js";

/** GGJIRA's own meta issues carry one of these labels and must never be picked up as work. */
const META_LABELS = new Set([AGENT_LABEL, WORKSPACE_LABEL]);

/** Builds the JQL for "issues assigned to me that are ready to claim", unless config overrides it. */
export function buildAssignedJql(config: AppConfig): string {
  if (config.jira.jql) return config.jira.jql;
  if (config.configVersion !== 4) {
    return `assignee = currentUser() AND status = "${config.workflow.readyStatus}" ORDER BY created ASC`;
  }
  const project = config.jira.projectKey ? `project = "${config.jira.projectKey}" AND ` : "";
  // Only statuses this install actually configured go into the JQL: naming a
  // status the project doesn't have makes Jira reject the whole query, which
  // would stop polling entirely. Planning is opt-in (setup doesn't ask for it).
  const statuses = executableStatuses(config);
  return `${project}status in (${statuses.map((s) => `"${s}"`).join(", ")}) ORDER BY created ASC`;
}

/** The statuses a v4 agent treats as "there is work here": planning (if set) and implementation. */
function executableStatuses(config: AppConfig): string[] {
  const implementationStatus = config.workflow.implementationStatus ?? "AI Implementation";
  const planningStatus = config.workflow.planningStatus;
  return planningStatus && planningStatus !== implementationStatus
    ? [planningStatus, implementationStatus]
    : [implementationStatus];
}

/**
 * Fetches issues assigned to this agent's Jira identity that are ready to
 * claim, then filters out anything already claimed locally (defense against
 * a stale/overlapping poll within the same GGJIRA process; Jira's own
 * assignee + status filter in the JQL is the primary guard against
 * re-selecting issues another run already moved on) and any GGJIRA meta
 * issue (Agent Profile / Workspace Configuration) that ended up assigned to
 * this agent — e.g. a project's default assignee is the PM account
 * (advanced_plan.md §2.11). This filter is client-side rather than added to
 * the JQL itself, so `buildAssignedJql`'s string stays stable for callers
 * that override `jira.jql`.
 */
export async function findAssignedJobs(
  jira: JiraGateway,
  config: AppConfig,
  store: JobStore,
): Promise<JiraIssue[]> {
  const issues = await jira.searchIssues(buildAssignedJql(config), { maxResults: 50, all: true });
  const claims = store.listClaims();
  const statuses = executableStatuses(config);
  return issues.filter((issue) => {
    const executableStatus =
      config.configVersion === 4
        ? statuses.includes(issue.statusName)
        : issue.statusName === config.workflow.readyStatus && issue.assigneeAccountId !== null;
    return (
      executableStatus &&
      !(issue.key in claims) &&
      (config.configVersion !== 4 || !store.wasHandled(issue)) &&
      !issue.labels.some((label) => META_LABELS.has(label))
    );
  });
}
