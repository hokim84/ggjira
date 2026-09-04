import type { JiraGateway } from "../jira/gateway.js";
import type { JiraIssue } from "../jira/types.js";
import type { Logger } from "../logger.js";
import { getItems, getScalar, parseSections, renderSections } from "./description.js";
import { PRESETS } from "./presets.js";
import { WORKSPACE_LABEL } from "./types.js";
import type { WorkspaceConfig, WorkspaceConfigInput } from "./types.js";

export const WORKSPACE_SUMMARY = "[GGJIRA] Workspace Configuration";

const DEFAULT_PROJECT_POLICY_PLACEHOLDER = "Add project-wide rules for all Agents here.";

function resolveProjectPolicy(items: string[]): string[] {
  return items.length ? items : [DEFAULT_PROJECT_POLICY_PLACEHOLDER];
}

/** Parses a `[GGJIRA] Workspace Configuration` issue. Missing Workflow fields fall back to config.ts's own defaults. */
export function parseWorkspaceConfig(issue: JiraIssue): WorkspaceConfig {
  const sections = parseSections(issue.description ?? "");
  const configVersionRaw = getScalar(sections, "GGJira Workspace", "Config Version");

  return {
    issueKey: issue.key,
    issueTypeName: issue.issueTypeName,
    projectKey: getScalar(sections, "GGJira Workspace", "Project Key") ?? issue.projectKey ?? "",
    configVersion: configVersionRaw ? Number(configVersionRaw) : 3,
    workflow: {
      readyStatus: getScalar(sections, "Workflow", "Ready Status") ?? "To Do",
      claimTransitionName: getScalar(sections, "Workflow", "Claim Transition") ?? "In Progress",
      doneTransitionName: getScalar(sections, "Workflow", "Done Transition") ?? "In Review",
      needsDecisionTransitionName: getScalar(sections, "Workflow", "Needs Decision Transition"),
      plannedTransitionName: getScalar(sections, "Workflow", "Planned Transition"),
      taskReadyTransitionName: getScalar(sections, "Workflow", "Task Ready Transition"),
      subtaskIssueType: getScalar(sections, "Workflow", "Subtask Issue Type") ?? "Subtask",
    },
    projectPolicy: resolveProjectPolicy(getItems(sections, "Project Policy")),
  };
}

/** Renders the description a Workspace Configuration issue is created with. */
export function renderWorkspaceDescription(input: WorkspaceConfigInput): string {
  return renderSections([
    {
      heading: "GGJira Workspace",
      scalars: [
        ["Config Version", String(input.configVersion)],
        ["GGJira Version", input.ggjiraVersion],
        ["Project Key", input.projectKey],
      ],
    },
    {
      heading: "Workflow",
      scalars: [
        ["Ready Status", input.workflow.readyStatus],
        ["Claim Transition", input.workflow.claimTransitionName],
        ["Done Transition", input.workflow.doneTransitionName],
        ["Needs Decision Transition", input.workflow.needsDecisionTransitionName],
        ["Planned Transition", input.workflow.plannedTransitionName],
        ["Task Ready Transition", input.workflow.taskReadyTransitionName],
        ["Subtask Issue Type", input.workflow.subtaskIssueType],
      ],
    },
    {
      heading: "Project Policy",
      items: resolveProjectPolicy(input.projectPolicy),
    },
    {
      heading: "Available Presets",
      items: PRESETS.map((p) => `${p.id} — ${p.description}`),
    },
  ]);
}

/**
 * Finds the project's Workspace Configuration issue by label. If more than
 * one exists (shouldn't normally happen -- createWorkspaceConfig only
 * creates one when none is found), the oldest is used and a warning logged;
 * this mirrors Jira's own ORDER BY created ASC ordering on read.
 */
export async function findWorkspaceConfig(
  jira: JiraGateway,
  projectKey: string,
  opts?: { logger?: Logger },
): Promise<WorkspaceConfig | null> {
  const issues = await jira.searchIssues(
    `project = "${projectKey}" AND labels = "${WORKSPACE_LABEL}" ORDER BY created ASC`,
  );
  const issue = issues[0];
  if (!issue) return null;
  if (issues.length > 1) {
    opts?.logger?.warn(
      { layer: "profile", projectKey, count: issues.length },
      "multiple Workspace Configuration issues found in this project; using the oldest",
    );
  }
  return parseWorkspaceConfig(issue);
}

/** Creates the project's Workspace Configuration issue and unassigns it (advanced_plan.md §2.11). */
export async function createWorkspaceConfig(
  jira: JiraGateway,
  input: WorkspaceConfigInput & { issueTypeName: string },
): Promise<WorkspaceConfig> {
  const projectPolicy = resolveProjectPolicy(input.projectPolicy);
  const description = renderWorkspaceDescription({ ...input, projectPolicy });
  const { key } = await jira.createIssue({
    projectKey: input.projectKey,
    issueTypeName: input.issueTypeName,
    summary: WORKSPACE_SUMMARY,
    description,
    labels: [WORKSPACE_LABEL],
  });
  await jira.assignIssue(key, null);

  return {
    issueKey: key,
    issueTypeName: input.issueTypeName,
    projectKey: input.projectKey,
    configVersion: input.configVersion,
    workflow: input.workflow,
    projectPolicy,
  };
}
