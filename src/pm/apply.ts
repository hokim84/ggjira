import type { z } from "zod";
import type { AppConfig } from "../config.js";
import type { JiraGateway } from "../jira/gateway.js";
import type { JiraIssue } from "../jira/types.js";
import { renderSections } from "../profile/description.js";
import {
  createAgentProfile,
  disableAgentProfile,
  findAgentProfileById,
} from "../profile/profile.js";
import type { AgentProfile, WorkspaceConfig } from "../profile/types.js";
import { PLAN_PROPERTY_KEY, PLAN_TASK_PROPERTY_KEY, readPlanTaskMetadata } from "./metadata.js";
import type { Plan, PlanTaskSchema } from "./plan.js";

const SUPERSEDED_LABEL = "ggjira-superseded";

export interface ApplyPlanResult {
  createdKeys: string[];
  supersededKeys: string[];
  createdProfileKeys: string[];
  disabledAgentIds: string[];
}

export class PlanApplyError extends Error {}

function isRoutableImplementAgent(agent: AgentProfile): boolean {
  return agent.role === "implement" && agent.enabled && agent.registration !== null;
}

async function resolveLegacyAssignee(
  jira: JiraGateway,
  config: AppConfig,
  roster: AgentProfile[] | undefined,
  task: z.infer<typeof PlanTaskSchema>,
): Promise<string> {
  const requested = task.assigneeAgentId
    ? roster?.find(
        (agent) => agent.agentId === task.assigneeAgentId && isRoutableImplementAgent(agent),
      )
    : undefined;
  const registered = requested ?? roster?.find(isRoutableImplementAgent);
  if (registered?.registration) return registered.registration.jiraAccountId;
  const configured = config.pm.implementAssignee;
  if (!configured) throw new PlanApplyError("pm.implementAssignee is not configured");
  const matches = await jira.searchUsers(configured);
  const exact =
    matches.find((user) => user.emailAddress === configured || user.accountId === configured) ??
    matches[0];
  if (!exact)
    throw new PlanApplyError(`No Jira user found matching pm.implementAssignee "${configured}"`);
  return exact.accountId;
}

function renderTaskDescription(task: z.infer<typeof PlanTaskSchema>): string {
  return [
    task.description,
    "",
    renderSections([
      {
        heading: "GGJIRA Plan",
        scalars: [
          ["Objective", task.title],
          ["Suggested Execution Strategy", task.suggestedExecutionStrategy ?? null],
        ],
      },
      { heading: "Acceptance Criteria", items: task.acceptance },
      { heading: "Dependencies", items: task.dependencies ?? [] },
      { heading: "Constraints", items: task.constraints ?? [] },
      { heading: "Required Capabilities", items: task.requiredCapabilities ?? ["programming"] },
    ]),
  ].join("\n");
}

function validateTaskGraph(tasks: Array<z.infer<typeof PlanTaskSchema>>, taskIds: string[]): void {
  const known = new Set(taskIds);
  const graph = new Map<string, string[]>();
  for (const [index, task] of tasks.entries()) {
    const taskId = taskIds[index] ?? `task-${index + 1}`;
    const unresolved = (task.dependencies ?? []).filter(
      (dependency) => !known.has(dependency) && !/^[A-Z][A-Z0-9_]+-\d+$/.test(dependency),
    );
    if (unresolved.length > 0) {
      throw new PlanApplyError(
        `Task ${taskId} has unresolved dependencies: ${unresolved.join(", ")}`,
      );
    }
    graph.set(
      taskId,
      (task.dependencies ?? []).filter((dependency) => known.has(dependency)),
    );
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (taskId: string): void => {
    if (visiting.has(taskId))
      throw new PlanApplyError(`Plan contains a dependency cycle at ${taskId}`);
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    for (const dependency of graph.get(taskId) ?? []) visit(dependency);
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const taskId of taskIds) visit(taskId);
}

/**
 * Whether an existing subtask is still untouched and safe to supersede on a replan. In v2/legacy
 * mode a fresh task always sits at `workflow.readyStatus`, so equality is exact. In v4 mode a
 * fresh task can land in any of several "not yet claimed" statuses depending on setup
 * (`implementationStatus`, `taskWaitingStatus`, or wherever `pm.taskReadyTransitionName` happens
 * to lead) -- so instead of matching one fixed "ready" status, treat anything that hasn't reached
 * in-progress/review/done/plan-review as still pending.
 */
function isStillPending(config: AppConfig, task: JiraIssue): boolean {
  if (config.configVersion !== 4) return task.statusName === config.workflow.readyStatus;
  const startedStatuses = new Set(
    [
      config.workflow.inProgressStatus,
      config.workflow.reviewStatus,
      config.workflow.completionStatus,
      config.workflow.planningInProgressStatus,
      config.workflow.planReviewStatus,
    ].filter((status): status is string => Boolean(status)),
  );
  return !startedStatuses.has(task.statusName);
}

const PLAN_START = "{noformat}[GGJIRA:PLAN:START]{noformat}";
const PLAN_END = "{noformat}[GGJIRA:PLAN:END]{noformat}";

function renderParentPlan(parent: JiraIssue, plan: Plan): string {
  const managed = [
    PLAN_START,
    renderSections([
      {
        heading: "GGJIRA Plan",
        scalars: [
          ["Objective", plan.objective ?? parent.summary],
          ["Suggested Execution Strategy", plan.suggestedExecutionStrategy ?? null],
        ],
      },
      { heading: "Acceptance Criteria", items: plan.acceptanceCriteria ?? [] },
      { heading: "Dependencies", items: plan.dependencies ?? [] },
      { heading: "Constraints", items: plan.constraints ?? [] },
      { heading: "Required Capabilities", items: plan.requiredCapabilities ?? [] },
    ]),
    PLAN_END,
  ].join("\n");
  const original = parent.description ?? "";
  const start = original.indexOf(PLAN_START);
  const end = original.indexOf(PLAN_END);
  if (start >= 0 && end >= start) {
    return `${original.slice(0, start)}${managed}${original.slice(end + PLAN_END.length)}`.trim();
  }
  return [original.trim(), managed].filter(Boolean).join("\n\n");
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
  planVersion = `plan-${Date.now()}`,
  decisionId?: string,
): Promise<ApplyPlanResult> {
  if (plan.tasks.length > config.pm.maxTasksPerPlan) {
    throw new PlanApplyError(
      `Plan has ${plan.tasks.length} tasks, exceeding pm.maxTasksPerPlan (${config.pm.maxTasksPerPlan})`,
    );
  }

  const projectKey = parent.projectKey;
  if (!projectKey) throw new PlanApplyError(`Issue ${parent.key} has no projectKey`);

  if (config.configVersion === 4) {
    await jira.updateIssueDescription(parent.key, renderParentPlan(parent, plan));
  }

  const createdKeys: string[] = [];
  const taskIds = plan.tasks.map((task, index) => task.taskId ?? `task-${index + 1}`);
  if (new Set(taskIds).size !== taskIds.length) {
    throw new PlanApplyError("Plan taskId values must be unique");
  }
  if (config.distribution.enabled) {
    validateTaskGraph(plan.tasks, taskIds);
  }
  const createdByTaskId = new Map<string, string>();
  for (const [index, task] of plan.tasks.entries()) {
    const taskId = taskIds[index] ?? `task-${index + 1}`;
    const description =
      config.configVersion === 4
        ? renderTaskDescription(task)
        : task.acceptance.length
          ? `${task.description}\n\nAcceptance criteria:\n${task.acceptance.map((item) => `- ${item}`).join("\n")}`
          : task.description;
    const { key } = await jira.createIssue({
      projectKey,
      issueTypeName: config.pm.subtaskIssueType,
      summary: task.title,
      description,
      parentKey: parent.key,
      ...(config.configVersion === 4
        ? parent.assigneeAccountId
          ? { assigneeAccountId: parent.assigneeAccountId }
          : {}
        : { assigneeAccountId: await resolveLegacyAssignee(jira, config, roster, task) }),
    });
    createdByTaskId.set(taskId, key);
    if (config.distribution.enabled && config.workflow.taskWaitingStatus) {
      await jira.transitionIssueToStatus(key, config.workflow.taskWaitingStatus);
    } else if (config.pm.taskReadyTransitionName) {
      await jira.transitionIssue(key, config.pm.taskReadyTransitionName);
    }
    createdKeys.push(key);
  }

  if (config.distribution.enabled) {
    for (const [index, task] of plan.tasks.entries()) {
      const taskId = taskIds[index] ?? `task-${index + 1}`;
      const key = createdByTaskId.get(taskId);
      if (!key) throw new PlanApplyError(`Created issue missing for taskId ${taskId}`);
      const dependencies = (task.dependencies ?? []).map(
        (dependency) => createdByTaskId.get(dependency) ?? dependency,
      );
      if (dependencies.join("\n") !== (task.dependencies ?? []).join("\n")) {
        await jira.updateIssueDescription(key, renderTaskDescription({ ...task, dependencies }));
      }
      await jira.setIssueProperty(key, PLAN_TASK_PROPERTY_KEY, {
        planVersion,
        taskId,
        parentKey: parent.key,
        // config.ts's superRefine requires distribution.workspaceId whenever distribution is
        // enabled, so this branch never sees it unset; falling back to workspace.path (a local
        // git worktree path, unrelated to the shared distribution workspace ID) would be wrong.
        workspaceId: config.distribution.workspaceId,
        dependencies,
      });
    }
  }

  const keep = new Set(plan.keepTaskKeys);
  const keptTaskIds: string[] = [];
  if (config.distribution.enabled) {
    // A kept task's own ggjira.plan-task property still names the previous planVersion. Left
    // alone, the parent's plan property below moves to the new version and every kept task
    // then fails its version check at execution time (looks approved on the board, but the
    // runtime rejects it as "no longer matches the current parent plan"). Re-stamp it to the
    // new version so a replan that keeps a task doesn't strand it.
    for (const keptKey of keep) {
      const existing = await readPlanTaskMetadata(jira, keptKey);
      if (!existing) continue; // not a plan-tracked task (e.g. created manually) -- leave as is
      await jira.setIssueProperty(keptKey, PLAN_TASK_PROPERTY_KEY, {
        ...existing,
        planVersion,
        parentKey: parent.key,
      });
      keptTaskIds.push(existing.taskId);
    }
  }

  if (config.distribution.enabled) {
    await jira.setIssueProperty(parent.key, PLAN_PROPERTY_KEY, {
      version: planVersion,
      status: "review",
      taskIds: [...taskIds, ...keptTaskIds],
      ...(decisionId ? { decisionId } : {}),
    });
  }

  const supersededKeys: string[] = [];
  for (const task of existingSubtasks) {
    if (keep.has(task.key)) continue;
    if (!isStillPending(config, task)) continue;
    if (config.configVersion !== 4) await jira.assignIssue(task.key, null);
    await jira.addLabel(task.key, SUPERSEDED_LABEL);
    await jira.addComment(task.key, "Superseded by a replan of the parent issue.");
    supersededKeys.push(task.key);
  }

  const createdProfileKeys: string[] = [];
  const disabledAgentIds: string[] = [];
  if (config.configVersion !== 4) {
    for (const request of plan.agentProfiles) {
      const existing = await findAgentProfileById(jira, projectKey, request.agentId);
      if (existing) continue;
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
    for (const agentId of plan.disableAgentIds) {
      const existing =
        roster?.find((agent) => agent.agentId === agentId) ??
        (await findAgentProfileById(jira, projectKey, agentId));
      if (!existing) continue;
      await disableAgentProfile(jira, existing);
      disabledAgentIds.push(agentId);
    }
  }

  return { createdKeys, supersededKeys, createdProfileKeys, disabledAgentIds };
}
