import type { z } from "zod";
import { renderSections } from "../issue/description.js";
import type { Plan, PlanTaskSchema } from "./plan.js";

/**
 * Pure plan rendering and validation shared by the legacy v4 PM path (`src/pm/apply.ts`) and
 * Router's v5 plan application (`src/router/report-journal.ts`) — docs/router-service-implementation-plan.md
 * §4 "capability·requirements·계획 검증 → 공유 순수 로직으로 분리". No Jira access here.
 */

export type PlanTask = z.infer<typeof PlanTaskSchema>;

export class PlanApplyError extends Error {}

/** Marks a subtask a replan dropped while it was still untouched. */
export const SUPERSEDED_LABEL = "ggjira-superseded";

export function renderTaskDescription(task: PlanTask): string {
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

/** Throws `PlanApplyError` for dependencies that are neither a taskId in this plan nor a Jira
 *  issue key, and for dependency cycles among this plan's tasks. */
export function validateTaskGraph(tasks: readonly PlanTask[], taskIds: readonly string[]): void {
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

/** Every task's stable id: its own `taskId`, or `task-<n>` by position. */
export function planTaskIds(plan: Plan): string[] {
  return plan.tasks.map((task, index) => task.taskId ?? `task-${index + 1}`);
}

export const PLAN_START = "{noformat}[GGJIRA:PLAN:START]{noformat}";
export const PLAN_END = "{noformat}[GGJIRA:PLAN:END]{noformat}";

/** The parent's description with its GGJIRA-managed plan block replaced (or appended), leaving
 *  whatever the human wrote around it untouched. */
export function renderParentPlan(
  parent: { summary: string; description: string | null },
  plan: Plan,
): string {
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
