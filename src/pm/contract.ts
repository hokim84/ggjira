import { normalizeCapabilities } from "../issue/capability.js";
import type { IssueRequirements } from "../issue/requirements.js";
import type { Plan } from "./plan.js";
import type { PlanTask } from "./plan-render.js";

/**
 * The contract a job runs under, taken from the plan a human approved (ADR 0047) — never parsed
 * back out of the issue description Router rendered it into. Pure: the plan comes from Router's
 * own record of the planning result.
 */

/** A planning request carries no contract yet; completing the request is the plan's job. */
export function planningRequirements(summary: string): IssueRequirements {
  return {
    objective: summary,
    acceptanceCriteria: [],
    dependencies: [],
    constraints: [],
    requiredCapabilities: [],
    suggestedExecutionStrategy: null,
    verification: [],
    inScope: [],
    outOfScope: [],
    affectedAreas: [],
    allowedPaths: [],
  };
}

/** A plan without tasks keeps the parent as the executable unit, under the plan's own contract. */
export function parentPlanRequirements(plan: Plan, summary: string): IssueRequirements {
  return {
    objective: plan.objective ?? summary,
    acceptanceCriteria: plan.acceptanceCriteria ?? [],
    dependencies: plan.dependencies ?? [],
    constraints: plan.constraints ?? [],
    requiredCapabilities: normalizeCapabilities(plan.requiredCapabilities ?? []),
    suggestedExecutionStrategy: plan.suggestedExecutionStrategy ?? null,
    verification: plan.verification,
    inScope: plan.inScope,
    outOfScope: plan.outOfScope,
    affectedAreas: plan.affectedAreas,
    allowedPaths: plan.allowedPaths,
  };
}

/** One task of a plan. `dependencies` are the issue keys Router resolved the task's dependencies
 *  to when it created the plan's subtasks (the task's `ggjira.plan-task` metadata). */
export function planTaskRequirements(
  task: PlanTask,
  dependencies: readonly string[],
): IssueRequirements {
  return {
    objective: task.title,
    acceptanceCriteria: task.acceptance,
    dependencies: [...dependencies],
    constraints: task.constraints ?? [],
    requiredCapabilities: normalizeCapabilities(task.requiredCapabilities ?? ["programming"]),
    suggestedExecutionStrategy: task.suggestedExecutionStrategy ?? null,
    verification: task.verification,
    inScope: task.inScope,
    outOfScope: task.outOfScope,
    affectedAreas: task.affectedAreas,
    allowedPaths: task.allowedPaths,
  };
}

/** Executable units of `plan` with no acceptance criteria or no verification. A plan with any is
 *  not applied, so nobody can approve a run that has no definition of done (ADR 0047). */
export function missingContracts(plan: Plan): string[] {
  const lacking = (acceptance: readonly string[], verification: readonly string[]) =>
    [
      ...(acceptance.length === 0 ? ["acceptance criteria"] : []),
      ...(verification.length === 0 ? ["verification"] : []),
    ].join(" and ");
  if (plan.tasks.length === 0) {
    const gap = lacking(plan.acceptanceCriteria ?? [], plan.verification);
    return gap ? [`the plan has no ${gap}`] : [];
  }
  return plan.tasks.flatMap((task, index) => {
    const gap = lacking(task.acceptance, task.verification);
    return gap ? [`task ${task.taskId ?? `task-${index + 1}`} has no ${gap}`] : [];
  });
}
