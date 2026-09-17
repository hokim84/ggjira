import type { JiraGateway } from "../jira/gateway.js";
import type { JiraIssue } from "../jira/types.js";
import type { Logger } from "../logger.js";
import { getItems, getScalar, parseSections, renderSections } from "./description.js";
import { PRESETS } from "./presets.js";
import { WORKSPACE_LABEL } from "./types.js";
import type { WorkspaceConfig, WorkspaceConfigInput, WorkspaceDistribution } from "./types.js";

export const WORKSPACE_SUMMARY = "[GGJIRA] Workspace Configuration";

const DEFAULT_PROJECT_POLICY_PLACEHOLDER = "Add project-wide rules for all Agents here.";

function resolveProjectPolicy(items: string[]): string[] {
  return items.length ? items : [DEFAULT_PROJECT_POLICY_PLACEHOLDER];
}

/** Parses the "Distribution" section, if present -- unset entirely on workspaces that never ran setup option 5. */
function parseDistribution(
  sections: ReturnType<typeof parseSections>,
): WorkspaceDistribution | undefined {
  const enabledRaw = getScalar(sections, "Distribution", "Enabled");
  if (enabledRaw === null) return undefined;
  return {
    enabled: enabledRaw.trim().toLowerCase() === "true",
    executionAgentFieldId: getScalar(sections, "Distribution", "Execution Agent Field ID"),
    workspaceId: getScalar(sections, "Distribution", "Workspace ID"),
  };
}

/** Parses a `[GGJIRA] Workspace Configuration` issue. Missing Workflow fields fall back to config.ts's own defaults. */
export function parseWorkspaceConfig(issue: JiraIssue): WorkspaceConfig {
  const sections = parseSections(issue.description ?? "");
  const configVersionRaw = getScalar(sections, "GGJira Workspace", "Config Version");
  const distribution = parseDistribution(sections);

  return {
    issueKey: issue.key,
    issueTypeName: issue.issueTypeName,
    projectKey: getScalar(sections, "GGJira Workspace", "Project Key") ?? issue.projectKey ?? "",
    configVersion: configVersionRaw ? Number(configVersionRaw) : 3,
    workflow: {
      implementationStatus: getScalar(sections, "Workflow", "AI Request Status") ?? "",
      inProgressStatus: getScalar(sections, "Workflow", "In Progress Status") ?? "",
      reviewStatus: getScalar(sections, "Workflow", "Review Status") ?? "",
      planningStatus: getScalar(sections, "Workflow", "Planning Status"),
      needsDecisionStatus: getScalar(sections, "Workflow", "Needs Decision Status"),
      subtaskIssueType: getScalar(sections, "Workflow", "Subtask Issue Type") ?? "Subtask",
    },
    ...(distribution ? { distribution } : {}),
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
        ["AI Request Status", input.workflow.implementationStatus],
        ["In Progress Status", input.workflow.inProgressStatus],
        ["Review Status", input.workflow.reviewStatus],
        ["Planning Status", input.workflow.planningStatus ?? null],
        ["Needs Decision Status", input.workflow.needsDecisionStatus ?? null],
        ["Subtask Issue Type", input.workflow.subtaskIssueType],
      ],
    },
    ...(input.distribution
      ? [
          {
            heading: "Distribution",
            scalars: [
              ["Enabled", String(input.distribution.enabled)],
              ["Execution Agent Field ID", input.distribution.executionAgentFieldId ?? null],
              ["Workspace ID", input.distribution.workspaceId ?? null],
            ] satisfies [string, string | null][],
          },
        ]
      : []),
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
 * Rewrites an existing Workspace Configuration issue's description in place
 * (e.g. after re-validating workflow transition names against real Jira
 * data). Keeps the issue key/type, config version, and project key as they
 * were; only the caller-supplied fields (workflow, project policy) change.
 */
export async function updateWorkspaceConfig(
  jira: JiraGateway,
  current: Pick<WorkspaceConfig, "issueKey" | "issueTypeName" | "projectKey" | "configVersion">,
  input: Pick<
    WorkspaceConfigInput,
    "workflow" | "projectPolicy" | "ggjiraVersion" | "distribution"
  >,
): Promise<WorkspaceConfig> {
  const projectPolicy = resolveProjectPolicy(input.projectPolicy);
  const description = renderWorkspaceDescription({
    projectKey: current.projectKey,
    configVersion: current.configVersion,
    ggjiraVersion: input.ggjiraVersion,
    workflow: input.workflow,
    ...(input.distribution ? { distribution: input.distribution } : {}),
    projectPolicy,
  });
  await jira.updateIssueDescription(current.issueKey, description);
  return {
    issueKey: current.issueKey,
    issueTypeName: current.issueTypeName,
    projectKey: current.projectKey,
    configVersion: current.configVersion,
    workflow: input.workflow,
    ...(input.distribution ? { distribution: input.distribution } : {}),
    projectPolicy,
  };
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
