import type { AppConfig } from "../config.js";
import type { PlanningContext } from "./context.js";
import { DECISION_REQUEST_MARKER } from "./marker.js";
import type { Plan } from "./plan.js";

export function buildPmSystemPrompt(): string {
  return [
    "You are the GGJIRA PM agent. You analyze a Jira requirement issue and produce a plan.",
    "You never modify code or run commands that change the workspace — you only read the repository to understand context.",
    "You never execute the implementation yourself; a separate implement agent picks up the tasks you define.",
    "If the requirement has more than one reasonable implementation approach with materially different consequences, set needsDecision to true and describe the options instead of choosing one yourself.",
    "Otherwise set needsDecision to false and break the work into small, independently completable tasks with clear acceptance criteria.",
  ].join(" ");
}

export function buildPlanningPrompt(ctx: PlanningContext): string {
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
    "Set a task's assigneeAgentId only when a specific registered agent's capabilities clearly fit that task better than the default routing; otherwise omit it.",
    "If the issue asks to add an agent, respond with agentProfiles (one entry per agent to create) and an empty tasks array; if it asks to remove one, use disableAgentIds the same way. Only do this when explicitly asked.",
  );

  return parts.join("\n");
}

export function buildDecisionRequestComment(plan: Plan, config: AppConfig): string {
  const decision = plan.decision;
  if (!decision) {
    throw new Error("buildDecisionRequestComment called on a plan with no decision");
  }

  const lines = [
    DECISION_REQUEST_MARKER,
    "",
    "GGJIRA needs a decision before it can continue planning.",
    "",
    `Question: ${decision.question}`,
    "",
    "Options:",
  ];
  for (const option of decision.options) {
    lines.push(`- ${option.id}: ${option.title}`);
    if (option.pros.length > 0) lines.push(`  pros: ${option.pros.join("; ")}`);
    if (option.cons.length > 0) lines.push(`  cons: ${option.cons.join("; ")}`);
  }
  if (decision.recommendation) lines.push("", `Recommendation: ${decision.recommendation}`);
  if (decision.impact) lines.push("", `Impact: ${decision.impact}`);
  lines.push(
    "",
    `To respond: comment "Decision: <option id>" on this issue and move it back to "${config.workflow.readyStatus}".`,
    "",
    `agent: ${config.agent.identity}@${config.agent.machine}`,
  );
  return lines.join("\n");
}
