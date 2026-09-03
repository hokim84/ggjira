import type { Job } from "../job/job.js";
import type { JiraIssue } from "../jira/types.js";
import type { ExecutionResult } from "./result.js";

export interface JobHandlerParams {
  issue: JiraIssue;
  job: Job;
}

/**
 * Executes one claimed job's actual work and returns a standardized result.
 * `implement/executor.ts` and `pm/executor.ts` each provide one of these; the
 * generic `job/runner.ts` lifecycle (claim -> handler.run() -> report) never
 * needs to know which role it's driving.
 */
export interface JobHandler {
  run(params: JobHandlerParams): Promise<ExecutionResult>;
}
