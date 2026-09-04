import type { AppConfig } from "../config.js";
import type { JiraGateway } from "../jira/gateway.js";
import type { JiraIssue } from "../jira/types.js";
import {
  createAgentProfile,
  disableAgentProfile,
  findAgentProfileById,
} from "../profile/profile.js";
import type { AgentProfile, WorkspaceConfig } from "../profile/types.js";
import type { Plan, PlanTaskSchema } from "./plan.js";
import type { z } from "zod";

const SUPERSEDED_LABEL = "ggjira-superseded";

export interface ApplyPlanResult {
  createdKeys: string[];
  supersededKeys: string[];
  createdProfileKeys: string[];
  disabledAgentIds: string[];
}

export class PlanApplyError extends Error {}

async function resolveAssigneeAccountId(jira: JiraGateway, config: AppConfig): Promise<string> {
  const assignee = config.pm.implementAssignee;
  if (!assignee) throw new PlanApplyError("pm.implementAssignee is not configured");
  const matches = await jira.searchUsers(assignee);
  const exact =
    matches.find((u) => u.emailAddress === assignee) ??
    matches.find((u) => u.accountId === assignee) ??
    matches[0];
  if (!exact) {
    throw new PlanApplyError(`No Jira user found matching pm.implementAssignee "${assignee}"`);
  }
  return exact.accountId;
}

function isRoutableImplementAgent(agent: AgentProfile): boolean {
  return agent.role === "implement" && agent.enabled && agent.registration !== null;
}

/**
 * Resolves the Jira account a task's subtask should be assigned to, in
 * order (advanced_plan.md §2.10): the task's own requested agent (if it's a
 * routable implement agent) -> the roster's first routable implement agent
 * -> the legacy pm.implementAssignee lookup. The legacy lookup is only ever
 * made when actually needed (a profile-only plan with a full roster never
 * touches it), and at most once per applyPlan call.
 */
async function resolveTaskAssigneeAccountId(
  jira: JiraGateway,
  config: AppConfig,
  roster: AgentProfile[] | undefined,
  task: z.infer<typeof PlanTaskSchema>,
  legacyCache: { accountId?: string },
): Promise<string> {
  if (task.assigneeAgentId) {
    const requested = roster?.find(
      (a) => a.agentId === task.assigneeAgentId && isRoutableImplementAgent(a),
    );
    if (requested?.registration) return requested.registration.jiraAccountId;
  }

  const fallback = roster?.find(isRoutableImplementAgent);
  if (fallback?.registration) return fallback.registration.jiraAccountId;

  if (legacyCache.accountId) return legacyCache.accountId;
  const resolved = await resolveAssigneeAccountId(jira, config);
  legacyCache.accountId = resolved;
  return resolved;
}

/**
 * Applies an approved (needsDecision=false) plan to Jira: creates subtasks
 * under the parent issue (routed to a registered implement agent when the
 * roster provides one, otherwise the legacy pm.implementAssignee), creates
 * or disables Agent Profiles the plan requested, and supersedes any
 * previous subtasks this replan dropped. Only subtasks still in the ready
 * status are superseded — work already in progress or done is never touched
 * (phase 2 §5.7: no full plan-diff engine, but don't lose real work either).
 */
export async function applyPlan(
  jira: JiraGateway,
  config: AppConfig,
  parent: JiraIssue,
  plan: Plan,
  existingSubtasks: JiraIssue[],
  roster?: AgentProfile[],
  workspace?: WorkspaceConfig | null,
): Promise<ApplyPlanResult> {
  if (plan.tasks.length > config.pm.maxTasksPerPlan) {
    throw new PlanApplyError(
      `Plan has ${plan.tasks.length} tasks, exceeding pm.maxTasksPerPlan (${config.pm.maxTasksPerPlan})`,
    );
  }

  const projectKey = parent.projectKey;
  if (!projectKey) throw new PlanApplyError(`Issue ${parent.key} has no projectKey`);

  const legacyCache: { accountId?: string } = {};
  const createdKeys: string[] = [];
  for (const task of plan.tasks) {
    const assigneeAccountId = await resolveTaskAssigneeAccountId(
      jira,
      config,
      roster,
      task,
      legacyCache,
    );
    const description = task.acceptance.length
      ? `${task.description}\n\nAcceptance criteria:\n${task.acceptance.map((a) => `- ${a}`).join("\n")}`
      : task.description;
    const { key } = await jira.createIssue({
      projectKey,
      issueTypeName: config.pm.subtaskIssueType,
      summary: task.title,
      description,
      parentKey: parent.key,
      assigneeAccountId,
    });
    if (config.pm.taskReadyTransitionName) {
      await jira.transitionIssue(key, config.pm.taskReadyTransitionName);
    }
    createdKeys.push(key);
  }

  const keep = new Set(plan.keepTaskKeys);
  const supersededKeys: string[] = [];
  for (const task of existingSubtasks) {
    if (keep.has(task.key)) continue;
    if (task.statusName !== config.workflow.readyStatus) continue;
    await jira.assignIssue(task.key, null);
    await jira.addLabel(task.key, SUPERSEDED_LABEL);
    await jira.addComment(task.key, "Superseded by a replan of the parent issue.");
    supersededKeys.push(task.key);
  }

  const createdProfileKeys: string[] = [];
  for (const request of plan.agentProfiles) {
    const existing = await findAgentProfileById(jira, projectKey, request.agentId);
    if (existing) continue; // idempotent: never recreate an agentId that already exists
    const created = await createAgentProfile(jira, {
      projectKey,
      issueTypeName: workspace?.issueTypeName ?? "Task",
      agentId: request.agentId,
      displayName: request.displayName ?? request.agentId,
      role: request.role,
      preset: request.preset ?? null,
      capabilities: request.capabilities,
      workStyle: [],
      humanInstructions: [],
    });
    createdProfileKeys.push(created.issueKey);
  }

  const disabledAgentIds: string[] = [];
  for (const agentId of plan.disableAgentIds) {
    const existing =
      roster?.find((a) => a.agentId === agentId) ??
      (await findAgentProfileById(jira, projectKey, agentId));
    if (!existing) continue;
    await disableAgentProfile(jira, existing);
    disabledAgentIds.push(agentId);
  }

  return { createdKeys, supersededKeys, createdProfileKeys, disabledAgentIds };
}
