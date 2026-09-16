import { appendFileSync } from "node:fs";
import type { JobHandler, JobHandlerParams } from "../agent/handler.js";
import type { ExecutionResult } from "../agent/result.js";
import type { AppConfig } from "../config.js";
import type { JiraGateway } from "../jira/gateway.js";
import type { JobStore } from "../job/store.js";
import type { Logger } from "../logger.js";
import type { AgentProfile, WorkspaceConfig } from "../profile/types.js";
import type { WorkerProvider, WorkerRequest } from "../worker/provider.js";
import { createWorktree } from "../worker/worktree.js";
import { applyPlan } from "./apply.js";
import { buildPlanningContext } from "./context.js";
import { PLAN_JSON_SCHEMA, parsePlan } from "./plan.js";
import { buildDecisionRequestComment, buildPlanningPrompt, buildPmSystemPrompt } from "./prompt.js";

export interface PmHandlerDeps {
  config: AppConfig;
  jira: JiraGateway;
  provider: WorkerProvider;
  store: JobStore;
  worktreesRoot: string;
  logger?: Logger;
  /** Composed system prompt (core policy + project policy + preset + profile); falls back to buildPmSystemPrompt(). */
  buildSystemPrompt?: () => Promise<string>;
  /** The registered Agent Profile roster + Workspace Configuration (profile mode only). */
  loadRoster?: () => Promise<{ agents: AgentProfile[]; workspace: WorkspaceConfig | null }>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The pm role's JobHandler: reads the issue + comments + existing subtasks,
 * asks the provider for a Plan, and either requests a human decision or
 * applies the plan to Jira as new subtasks. PM never runs implementation
 * work itself and never imports implement/executor.ts (phase 2 §4.1) — it
 * only writes Jira issues/comments/transitions.
 */
export function createPmHandler(deps: PmHandlerDeps): JobHandler {
  return {
    async run({ issue, job }: JobHandlerParams): Promise<ExecutionResult> {
      const { config, jira, provider, store, worktreesRoot } = deps;
      const logger = deps.logger?.child({ layer: "pm", issueKey: issue.key, runId: job.runId });

      const self = await jira.getMyself();
      const [comments, existingSubtasks, roster] = await Promise.all([
        jira.getComments(issue.key),
        jira.searchIssues(`parent = "${issue.key}"`),
        deps.loadRoster?.(),
      ]);
      const planningContext = buildPlanningContext(
        issue,
        comments,
        existingSubtasks,
        self.accountId,
        roster?.agents,
        issue.assigneeAccountId,
      );

      const branch = `ggjira-pm/${issue.key}-${job.runId}`;
      let worktreePath = config.workspace.path;
      try {
        const worktree = await createWorktree(
          config.workspace.path,
          config.workspace.baseBranch,
          branch,
          worktreesRoot,
        );
        worktreePath = worktree.path;
      } catch (error) {
        logger?.warn(
          { err: error },
          "could not create a worktree for planning context; continuing against the base workspace",
        );
      }

      const systemPrompt = deps.buildSystemPrompt
        ? await deps.buildSystemPrompt()
        : buildPmSystemPrompt();

      const request: WorkerRequest = {
        prompt: buildPlanningPrompt(planningContext),
        cwd: worktreePath,
        timeoutMs: config.provider.timeoutMs,
        systemPrompt,
        outputSchema: PLAN_JSON_SCHEMA,
        readOnly: true,
      };

      const workerLogPath = store.workerLogPath(issue.key, job.runId);
      const workerResult = await provider.run(request, {
        onEvent: (line) => appendFileSync(workerLogPath, `${line}\n`),
      });

      if (workerResult.exitReason !== "completed" || workerResult.isError) {
        return {
          status: "failed",
          summary: workerResult.summary,
          failureReason: workerResult.summary,
          timedOut: workerResult.exitReason === "timeout",
        };
      }

      let plan: ReturnType<typeof parsePlan>;
      try {
        plan = parsePlan(workerResult.structuredOutput, workerResult.summary);
      } catch (error) {
        logger?.error({ err: error }, "failed to parse plan output");
        return {
          status: "failed",
          summary: "The PM agent's plan output could not be parsed.",
          failureReason: errorMessage(error),
        };
      }

      if (plan.needsDecision) {
        return {
          status: "needs_decision",
          summary: plan.summary,
          decisionRequest: buildDecisionRequestComment(plan, config, job.runId),
        };
      }

      try {
        const applied = await applyPlan(
          jira,
          config,
          issue,
          plan,
          existingSubtasks,
          roster?.agents,
          roster?.workspace,
          job.runId,
          planningContext.humanDecision?.decisionId,
        );
        return {
          status: "planned",
          summary: plan.summary,
          artifacts: [
            ...applied.createdKeys.map((key) => `created: ${key}`),
            ...applied.supersededKeys.map((key) => `superseded: ${key}`),
          ],
        };
      } catch (error) {
        logger?.error({ err: error }, "failed to apply plan to Jira");
        return {
          status: "failed",
          summary: "Could not apply the plan to Jira.",
          failureReason: errorMessage(error),
        };
      }
    },
  };
}
