import { DECISION_REQUEST_MARKER } from "./marker.js";

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
 * What the planning prompt reads: the envelope's issue snapshot and planning context
 * (src/worker-runtime/planning.ts). Structural, so the worker never imports Jira types.
 */
export interface PlanningPromptInput {
  issue: { key: string; summary: string; description: string | null };
  comments: ReadonlyArray<{ authorDisplayName: string | null; body: string }>;
  existingSubtasks: ReadonlyArray<{ key: string; statusName: string; summary: string }>;
  humanDecision?: { raw: string };
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
    "Each executable task must list canonical requiredCapabilities. Do not select or assign a worker; Router routes tasks by capability and Jira assignees stay unchanged.",
    "Every task needs a unique taskId, and intra-plan dependencies must reference those taskIds.",
  );

  return parts.join("\n");
}
