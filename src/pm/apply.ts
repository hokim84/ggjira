import type { AppConfig } from "../config.js";
import type { JiraGateway } from "../jira/gateway.js";
import type { JiraIssue } from "../jira/types.js";
import type { Plan } from "./plan.js";

const SUPERSEDED_LABEL = "ggjira-superseded";

export interface ApplyPlanResult {
  createdKeys: string[];
  supersededKeys: string[];
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

/**
 * Applies an approved (needsDecision=false) plan to Jira: creates subtasks
 * under the parent issue, assigns them to the implement identity, optionally
 * moves them to a ready-for-execution transition, and supersedes any
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
): Promise<ApplyPlanResult> {
  if (plan.tasks.length > config.pm.maxTasksPerPlan) {
    throw new PlanApplyError(
      `Plan has ${plan.tasks.length} tasks, exceeding pm.maxTasksPerPlan (${config.pm.maxTasksPerPlan})`,
    );
  }

  const projectKey = parent.projectKey;
  if (!projectKey) throw new PlanApplyError(`Issue ${parent.key} has no projectKey`);

  const assigneeAccountId = await resolveAssigneeAccountId(jira, config);

  const createdKeys: string[] = [];
  for (const task of plan.tasks) {
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

  return { createdKeys, supersededKeys };
}
