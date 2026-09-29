import type Database from "better-sqlite3";
import { IssueSnapshotSchema } from "../contracts/envelope.js";
import type { Logger } from "../logger.js";
import { listJobsToAssess, recordAssessment, recordAssessmentFailure } from "./db/assessments.js";
import { getApproval } from "./db/approvals.js";
import type { JobRow } from "./db/jobs.js";
import type { JevClient, JevQuestion } from "./jev.js";

/**
 * Shadow assessment (ADR 0030): Jev reads each new job's issue and answers two questions. The
 * answers are stored next to the job and shown to admins — nothing reads them to make a decision
 * yet. Once they prove reliable on real (Korean) issues, `modelTier` can pick the model and
 * `readiness` can gate dispatch, each behind its own confidence threshold.
 *
 * Questions and criteria are in English (Jev's strongest language); the issue text is passed as
 * written. Only what the decision needs goes into the state — Jev loses accuracy on unrelated
 * content.
 */
export const ASSESSMENT_QUESTIONS: Record<string, JevQuestion> = {
  modelTier: {
    type: "choice",
    instructions:
      "An autonomous coding agent will do this Jira task alone, with no chance to ask questions. How capable a model does it need to get the task right on the first try?",
    criteria: {
      small:
        "Trivial and fully specified: a typo, text or config value, rename, or a small edit in one or two files with no design decisions.",
      standard:
        "An ordinary feature or bug fix: a few files, some reading of existing code, clear requirements, limited design choices.",
      large:
        "Hard or broad: cross-cutting changes, new architecture or data model, tricky debugging, concurrency, security or performance concerns, or requirements that need careful interpretation.",
    },
  },
  readiness: {
    type: "choice",
    instructions:
      "Can an autonomous coding agent start this Jira task as written, without a human clarifying or splitting it first?",
    criteria: {
      ready:
        "Yes: the goal and the expected behavior are stated, or obvious from the summary and description.",
      needs_plan:
        "The goal is clear but the work is too large or has several independent parts; it should be split into subtasks first.",
      unclear:
        "The goal or the expected behavior is missing or ambiguous; a human must clarify before any work starts.",
    },
  },
};

/** Keeps the state well inside Jev's 32k-token state budget and away from long pasted logs. */
export const MAX_DESCRIPTION_CHARS = 12_000;
/** Jobs older than this at startup are not back-filled. */
export const ASSESS_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const MAX_TRIES = 3;
const BATCH = 5;

export interface AssessmentDeps {
  db: Database.Database;
  jev: JevClient;
  now: () => string;
  logger?: Logger;
}

export interface AssessmentPassReport {
  assessed: string[];
  failed: Array<{ jobId: string; error: string }>;
}

export function assessmentState(
  job: JobRow,
  issue: {
    summary: string;
    description: string | null;
    issueTypeName: string | null;
  },
): Record<string, string> {
  const description = issue.description ?? "";
  return {
    jobKind: job.kind,
    issueType: issue.issueTypeName ?? "",
    summary: issue.summary,
    description:
      description.length > MAX_DESCRIPTION_CHARS
        ? `${description.slice(0, MAX_DESCRIPTION_CHARS)}\n[truncated]`
        : description,
  };
}

/** Asks Jev about up to a few unassessed recent jobs. Failures are recorded and retried on later
 *  passes up to `MAX_TRIES`; they never touch the job itself. */
export async function assessPendingJobs(deps: AssessmentDeps): Promise<AssessmentPassReport> {
  const report: AssessmentPassReport = { assessed: [], failed: [] };
  const since = new Date(Date.parse(deps.now()) - ASSESS_LOOKBACK_MS).toISOString();
  for (const job of listJobsToAssess(deps.db, { since, maxTries: MAX_TRIES, limit: BATCH })) {
    const issue = IssueSnapshotSchema.safeParse(
      (getApproval(deps.db, job.issueKey)?.inputSnapshot as { issue?: unknown } | undefined)?.issue,
    );
    if (!issue.success) {
      const error = "no stored issue snapshot for this job";
      recordAssessmentFailure(deps.db, { jobId: job.id, error, now: deps.now() });
      report.failed.push({ jobId: job.id, error });
      continue;
    }
    try {
      const answer = await deps.jev.systemOne(
        assessmentState(job, issue.data),
        ASSESSMENT_QUESTIONS,
      );
      recordAssessment(deps.db, {
        jobId: job.id,
        model: answer.model,
        answers: answer.answers,
        inputTokens: answer.usage.input_tokens ?? null,
        latencyMs: answer.latencyMs,
        now: deps.now(),
      });
      report.assessed.push(job.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordAssessmentFailure(deps.db, { jobId: job.id, error: message, now: deps.now() });
      report.failed.push({ jobId: job.id, error: message });
    }
  }
  return report;
}
