import { unknownCapabilities } from "../agent/capability.js";
import type { IssueRequirements } from "../agent/requirements.js";
import type { JiraIssue } from "../jira/types.js";
import type { PlanTaskMetadata } from "../pm/metadata.js";
import type { RouteResult } from "../contracts/route.js";
import type { ExecutionAgentFieldConfig, WorkspaceConfig } from "./config.js";

/**
 * Everything `RuleDecisionProvider.decide` needs to apply
 * docs/router-service-implementation-plan.md §2 "배정 규칙", already resolved by the
 * caller (`src/router/scheduler.ts`) so this stays a pure function: no Jira/DB access,
 * easy to unit-test, and swappable for a future LLM-based `DecisionProvider` without
 * touching how the context is assembled.
 */
export interface RouteContext {
  issue: JiraIssue;
  requirements: IssueRequirements;
  /** `null` for a manually created issue (no `ggjira.plan-task` property) — exempt from
   *  the workspace-match check below. */
  planTask: PlanTaskMetadata | null;
  workspace: WorkspaceConfig;
  /** Dependency issue keys (extracted from the requirements text) that have not yet reached
   *  a post-request status. Empty means every dependency is resolved. */
  unresolvedDependencies: string[];
  /** The execution-agent custom field's selected option, if the workspace's Router config
   *  has one configured and the issue has a value set. */
  executionAgentOptionId: string | null;
}

export interface DecisionProvider {
  decide(context: RouteContext): RouteResult;
}

/**
 * The only `DecisionProvider` this stage ships (§2 "규칙 기반 배분을 구현하고
 * `DecisionProvider` 인터페이스를 둔다. LLM 판단 연동은 후속 작업이다"). Applies the
 * ordered rules from §2 "배정 규칙" 1-5; the first rule that doesn't pass decides the
 * outcome.
 */
export class RuleDecisionProvider implements DecisionProvider {
  constructor(private readonly executionAgent?: ExecutionAgentFieldConfig) {}

  decide(context: RouteContext): RouteResult {
    const { issue, requirements, planTask, workspace, unresolvedDependencies } = context;

    if (!issue.assigneeAccountId) {
      return { target: "human", reason: `${issue.key} has no human assignee` };
    }

    if (planTask && planTask.workspaceId !== workspace.id) {
      return {
        target: "human",
        reason: `${issue.key}'s plan-task workspace "${planTask.workspaceId}" does not match workspace "${workspace.id}"`,
      };
    }

    if (unresolvedDependencies.length > 0) {
      return {
        target: "wait",
        reason: `${issue.key} is waiting on unresolved dependencies: ${unresolvedDependencies.join(", ")}`,
      };
    }

    const unknown = unknownCapabilities(requirements.requiredCapabilities);
    if (unknown.length > 0) {
      return {
        target: "human",
        reason: `${issue.key} requires unknown capabilities: ${unknown.join(", ")}`,
      };
    }

    let pinnedWorkerId: string | undefined;
    if (this.executionAgent && context.executionAgentOptionId) {
      const workerId = this.executionAgent.optionWorkerMap[context.executionAgentOptionId];
      if (!workerId) {
        return {
          target: "human",
          reason: `${issue.key}'s execution-agent option "${context.executionAgentOptionId}" is not mapped to a worker`,
        };
      }
      pinnedWorkerId = workerId;
    }

    const target =
      issue.statusName === workspace.workflow.planningStatus ? "planning" : "implementation";
    return {
      target,
      workspaceId: workspace.id,
      repositoryId: workspace.repositoryId,
      requiredCapabilities: requirements.requiredCapabilities,
      reason: `${issue.key} is approved and ready to dispatch`,
      ...(pinnedWorkerId ? { pinnedWorkerId } : {}),
    };
  }
}
