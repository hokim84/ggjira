import type { AppConfig } from "../config.js";
import { DECISION_REQUEST_MARKER } from "./marker.js";
import type { Plan } from "./plan.js";
import { renderDecisionRequest } from "./decision-render.js";

export function buildPmSystemPrompt(): string {
  return [
    "You are the GGJIRA PM agent. You analyze a Jira requirement issue and produce a plan.",
    "You never modify code or run commands that change the workspace — you only read the repository to understand context.",
    "You never execute the implementation yourself; a separate implement agent picks up the tasks you define.",
    "If the requirement has more than one reasonable implementation approach with materially different consequences, set needsDecision to true and describe the options instead of choosing one yourself.",
    "Otherwise set needsDecision to false and describe the objective, acceptance criteria, dependencies, constraints, required capabilities, and suggested execution strategy.",
    "Create subtasks only for independently completable units with their own acceptance criteria or dependencies. Keep low-level implementation steps in the strategy, not Jira tasks.",
    "Give every task a stable taskId. Express dependencies on tasks in this plan using those taskIds; use Jira issue keys for pre-existing dependencies.",
  ].join(" ");
}

/**
 * What the planning prompt reads. Structural, so both the v4 PM handler's Jira-backed
 * `PlanningContext` (src/pm/context.ts) and a v5 worker's envelope snapshot
 * (src/worker-runtime/planning.ts) fit without the worker importing Jira types.
 */
export interface PlanningPromptInput {
  issue: { key: string; summary: string; description: string | null };
  comments: ReadonlyArray<{ authorDisplayName: string | null; body: string }>;
  existingSubtasks: ReadonlyArray<{ key: string; statusName: string; summary: string }>;
  humanDecision?: { raw: string };
  agents?: ReadonlyArray<{
    agentId: string;
    role: string;
    preset: string | null;
    capabilities: readonly string[];
    enabled: boolean;
    registration: unknown;
  }>;
}

export function buildPlanningPrompt(ctx: PlanningPromptInput): string {
  const parts: string[] = [`Issue: ${ctx.issue.key} — ${ctx.issue.summary}`];
  if (ctx.issue.description) {
    parts.push("", "Description:", ctx.issue.description);
  }

  if (ctx.existingSubtasks.length > 0) {
    parts.push("", "Existing subtasks:");
    for (const task of ctx.existingSubtasks) {
      parts.push(`- ${task.key} [${task.statusName}]: ${task.summary}`);
    }
  }

  if (ctx.humanDecision) {
    parts.push(
      "",
      "A human has replied to a previous decision request. Use this as the deciding input for this plan; do not ask the same question again:",
      ctx.humanDecision.raw,
    );
  }

  if (ctx.agents && ctx.agents.length > 0) {
    parts.push("", "Registered agents:");
    for (const agent of ctx.agents) {
      const registered = agent.registration ? "registered" : "unregistered";
      const status = agent.enabled ? registered : "disabled";
      const preset = agent.preset ? `, preset ${agent.preset}` : "";
      const capabilities = agent.capabilities.length
        ? `, capabilities: ${agent.capabilities.join(", ")}`
        : "";
      parts.push(`- ${agent.agentId} (${agent.role}${preset}${capabilities}, ${status})`);
    }
  }

  const otherComments = ctx.comments.filter((c) => !c.body.includes(DECISION_REQUEST_MARKER));
  if (otherComments.length > 0) {
    parts.push("", "Other comments on this issue:");
    for (const comment of otherComments) {
      parts.push(`- ${comment.authorDisplayName ?? "(unknown)"}: ${comment.body}`);
    }
  }

  parts.push(
    "",
    "Produce a plan as JSON matching the given schema. If existing subtasks are still valid, list their keys in keepTaskKeys instead of recreating them; anything not listed there will be treated as superseded.",
    "Each executable task must list canonical requiredCapabilities. Do not select or assign an agent; Jira assignees remain unchanged during AI delegation.",
    "Every task needs a unique taskId, and intra-plan dependencies must reference those taskIds.",
    "Agent Profiles are human-managed configuration. Never create, disable, or assign an Agent Profile from a plan.",
  );

  return parts.join("\n");
}

export function buildDecisionRequestComment(
  plan: Plan,
  config: AppConfig,
  planVersion?: string,
): string {
  return renderDecisionRequest(plan, {
    ...(planVersion ? { planVersion } : {}),
    replyStatus: config.workflow.planningStatus ?? config.workflow.readyStatus,
    signature: `agent: ${config.agent.identity}@${config.agent.machine}`,
  });
}
