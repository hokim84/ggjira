import { appendFileSync } from "node:fs";
import type { JobHandler, JobHandlerParams } from "../agent/handler.js";
import type { ExecutionResult } from "../agent/result.js";
import type { AppConfig } from "../config.js";
import type { JobStore } from "../job/store.js";
import type { Logger } from "../logger.js";
import type { WorkerProvider, WorkerRequest } from "../worker/provider.js";
import { buildImplementPrompt, buildImplementSystemPrompt } from "../worker/prompt.js";
import {
  changedFilesSince,
  commitAll,
  createWorktree,
  hasUncommittedChanges,
} from "../worker/worktree.js";
import { runValidateCommand } from "./validate.js";

export interface ImplementHandlerDeps {
  config: AppConfig;
  provider: WorkerProvider;
  store: JobStore;
  worktreesRoot: string;
  logger?: Logger;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The implement role's JobHandler: worktree -> worker -> commit -> optional
 * validation. This is the "Worker executes and reports back" half of phase 2
 * — it never creates or transitions other Jira issues (that's the pm role).
 */
export function createImplementHandler(deps: ImplementHandlerDeps): JobHandler {
  return {
    async run({ issue, job }: JobHandlerParams): Promise<ExecutionResult> {
      const { config, provider, store, worktreesRoot } = deps;
      const logger = deps.logger?.child({
        layer: "implement",
        issueKey: issue.key,
        runId: job.runId,
      });

      const branch = `ggjira/${issue.key}-${job.runId}`;
      let worktreePath: string;
      try {
        const worktree = await createWorktree(
          config.workspace.path,
          config.workspace.baseBranch,
          branch,
          worktreesRoot,
        );
        worktreePath = worktree.path;
      } catch (error) {
        logger?.error({ err: error }, "failed to create worktree");
        return {
          status: "failed",
          summary: "Could not create a git worktree for this issue.",
          failureReason: errorMessage(error),
        };
      }

      const request: WorkerRequest = {
        prompt: buildImplementPrompt({ title: issue.summary, description: issue.description }),
        cwd: worktreePath,
        timeoutMs: config.provider.timeoutMs,
        systemPrompt: buildImplementSystemPrompt(),
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
          branch,
          timedOut: workerResult.exitReason === "timeout",
        };
      }

      let changedFiles: string[] = [];
      if (await hasUncommittedChanges(worktreePath)) {
        await commitAll(worktreePath, `GGJIRA worker: ${issue.key} ${issue.summary}`.slice(0, 200));
        changedFiles = await changedFilesSince(worktreePath, config.workspace.baseBranch);
      }

      const validation: string[] = [];
      if (config.workspace.validateCommand) {
        const validationResult = await runValidateCommand(
          config.workspace.validateCommand,
          worktreePath,
        );
        validation.push(validationResult.summary);
        if (!validationResult.ok) {
          return {
            status: "failed",
            summary: workerResult.summary,
            failureReason: `Validation command failed: ${validationResult.summary}`,
            branch,
            changes: changedFiles,
            validation,
          };
        }
      }

      const artifacts = changedFiles.length > 0 ? [`branch: ${branch}`] : [];

      return {
        status: "succeeded",
        summary: workerResult.summary,
        branch,
        changes: changedFiles,
        validation,
        artifacts,
      };
    },
  };
}
