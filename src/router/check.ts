import type { JiraGateway } from "../jira/gateway.js";
import type { RouterConfig, WorkspaceConfig } from "./config.js";
import { checkWorkflowHops } from "./workflow-check.js";

/**
 * `ggjira router check`: confirms the Router config matches the real Jira before `serve`
 * (docs/router-service-implementation-plan.md §5 "운영 전환" 4. "실제 Jira 상태와 전이 가능 여부를
 * router check로 확인한다"). Read-only — it never writes to Jira.
 */

export type CheckLevel = "ok" | "warn" | "fail";

export interface CheckItem {
  level: CheckLevel;
  message: string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function configuredStatuses(workspace: WorkspaceConfig): Array<[label: string, status: string]> {
  const { workflow } = workspace;
  return [
    ["requestStatus", workflow.requestStatus],
    ["inProgressStatus", workflow.inProgressStatus],
    ["reviewStatus", workflow.reviewStatus],
    ...(workflow.planningStatus
      ? [["planningStatus", workflow.planningStatus] as [string, string]]
      : []),
    ...(workflow.needsDecisionStatus
      ? [["needsDecisionStatus", workflow.needsDecisionStatus] as [string, string]]
      : []),
    ...(workflow.doneStatus ? [["doneStatus", workflow.doneStatus] as [string, string]] : []),
  ];
}

async function checkProject(
  jira: JiraGateway,
  config: RouterConfig,
  workspace: WorkspaceConfig,
  projectKey: string,
  items: CheckItem[],
): Promise<void> {
  const where = `workspace "${workspace.id}" project ${projectKey}`;
  let issueTypes: Array<{ name: string; subtask: boolean }>;
  try {
    issueTypes = (await jira.getProject(projectKey)).issueTypes;
  } catch (error) {
    items.push({ level: "fail", message: `${where}: cannot read project (${errorText(error)})` });
    return;
  }

  let statuses: string[];
  try {
    statuses = (await jira.listProjectStatuses(projectKey)).map((s) => s.normalize("NFC"));
  } catch (error) {
    items.push({ level: "fail", message: `${where}: cannot list statuses (${errorText(error)})` });
    return;
  }
  for (const [label, status] of configuredStatuses(workspace)) {
    items.push(
      statuses.includes(status)
        ? { level: "ok", message: `${where}: ${label} "${status}" exists` }
        : {
            level: "fail",
            message: `${where}: ${label} "${status}" is not a status of this project (has: ${statuses.join(", ")})`,
          },
    );
  }

  try {
    for (const hop of await checkWorkflowHops(jira, projectKey, workspace.workflow)) {
      const move = `transition "${hop.from}" → "${hop.to}" (${hop.label})`;
      if (hop.state === "ok") {
        items.push({
          level: "ok",
          message: `${where}: ${move} is available${hop.sampleIssue ? ` (checked on ${hop.sampleIssue})` : ""}`,
        });
      } else if (hop.state === "missing") {
        items.push({
          level: "fail",
          message: `${where}: no ${move} in the workflow (checked on ${hop.sampleIssue}; reachable: ${hop.reachable.join(", ") || "none"})`,
        });
      } else {
        items.push({ level: "warn", message: `${where}: ${move} not verified — ${hop.reason}` });
      }
    }
  } catch (error) {
    items.push({
      level: "warn",
      message: `${where}: cannot check transitions (${errorText(error)})`,
    });
  }

  if (workspace.workflow.planningStatus) {
    const subtaskType = config.planning.subtaskIssueType;
    const found = issueTypes.find((type) => type.name.normalize("NFC") === subtaskType);
    items.push(
      found?.subtask
        ? { level: "ok", message: `${where}: subtask issue type "${subtaskType}" exists` }
        : {
            level: "fail",
            message: `${where}: planning.subtaskIssueType "${subtaskType}" is not a subtask type of this project`,
          },
    );
    // The REST API does not expose a workflow's initial status, so this stays a manual check.
    items.push({
      level: "warn",
      message: `${where}: confirm by hand that a new "${subtaskType}" starts in a status other than "${workspace.workflow.requestStatus}" — otherwise every PM subtask would be dispatched before a human approves it`,
    });
  }
}

/** What each status's issue must be able to reach next for Router's own transitions. */
function expectedNextStatuses(workspace: WorkspaceConfig, current: string): string[] {
  const { workflow } = workspace;
  if (current === workflow.requestStatus || current === workflow.planningStatus) {
    return [workflow.inProgressStatus];
  }
  if (current === workflow.inProgressStatus) {
    return [
      workflow.reviewStatus,
      ...(workflow.needsDecisionStatus ? [workflow.needsDecisionStatus] : []),
    ];
  }
  return [];
}

async function checkSampleIssue(
  jira: JiraGateway,
  config: RouterConfig,
  issueKey: string,
  items: CheckItem[],
): Promise<void> {
  let issue: Awaited<ReturnType<JiraGateway["getIssue"]>>;
  try {
    issue = await jira.getIssue(issueKey);
  } catch (error) {
    items.push({ level: "fail", message: `issue ${issueKey}: cannot read (${errorText(error)})` });
    return;
  }
  const workspace = config.workspaces.find((w) => w.projectKeys.includes(issue.projectKey ?? ""));
  if (!workspace) {
    items.push({
      level: "fail",
      message: `issue ${issueKey}: project ${issue.projectKey ?? "?"} is not in any workspace`,
    });
    return;
  }
  const transitions = await jira.getTransitions(issueKey);
  const reachable = transitions.map((t) => t.toStatusName.normalize("NFC"));
  const expected = expectedNextStatuses(workspace, issue.statusName);
  if (expected.length === 0) {
    items.push({
      level: "warn",
      message: `issue ${issueKey} is in "${issue.statusName}", which Router never moves from; pick an issue in the request or in-progress status to check transitions (reachable now: ${reachable.join(", ") || "none"})`,
    });
    return;
  }
  for (const status of expected) {
    items.push(
      reachable.includes(status)
        ? {
            level: "ok",
            message: `issue ${issueKey}: "${issue.statusName}" → "${status}" is available`,
          }
        : {
            level: "fail",
            message: `issue ${issueKey}: no transition from "${issue.statusName}" to "${status}" (reachable: ${reachable.join(", ") || "none"})`,
          },
    );
  }
}

export async function runRouterCheck(
  jira: JiraGateway,
  config: RouterConfig,
  opts: { issueKey?: string } = {},
): Promise<CheckItem[]> {
  const items: CheckItem[] = [];
  try {
    const me = await jira.getMyself();
    items.push({ level: "ok", message: `Jira authentication works (as ${me.displayName})` });
  } catch (error) {
    items.push({ level: "fail", message: `Jira authentication failed: ${errorText(error)}` });
    return items;
  }

  for (const workspace of config.workspaces) {
    for (const projectKey of workspace.projectKeys) {
      await checkProject(jira, config, workspace, projectKey, items);
    }
  }

  if (config.executionAgent) {
    const fieldId = config.executionAgent.fieldId;
    try {
      const fields = await jira.listFields();
      items.push(
        fields.some((field) => field.id === fieldId)
          ? { level: "ok", message: `executionAgent.fieldId ${fieldId} exists` }
          : { level: "fail", message: `executionAgent.fieldId ${fieldId} is not a Jira field` },
      );
    } catch (error) {
      items.push({ level: "fail", message: `cannot list Jira fields (${errorText(error)})` });
    }
  }

  if (config.workers.length === 0) {
    items.push({
      level: "warn",
      message: "no workers declared in config; nothing can be dispatched",
    });
  }

  if (opts.issueKey) await checkSampleIssue(jira, config, opts.issueKey, items);
  return items;
}
