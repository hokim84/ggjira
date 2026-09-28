import { z } from "zod";
import { PlanSchema } from "../pm/plan.js";
import { JOB_KINDS, PROTOCOL_VERSION } from "./protocol.js";

/**
 * A read-only snapshot of the Jira issue a job is about, captured by Router
 * at dispatch time and handed to the worker verbatim. The worker never calls
 * Jira itself (docs/router-service-implementation-plan.md "Worker Runtime"),
 * so this is the only view of the issue it gets.
 */
export const IssueSnapshotSchema = z.object({
  key: z.string().min(1),
  id: z.string().min(1),
  summary: z.string().min(1),
  description: z.string().nullable(),
  statusName: z.string().min(1),
  labels: z.array(z.string()),
  assigneeAccountId: z.string().nullable(),
  issueTypeName: z.string().nullable(),
  parentKey: z.string().nullable(),
  projectKey: z.string().nullable(),
});
export type IssueSnapshot = z.infer<typeof IssueSnapshotSchema>;

export const CommentSnapshotSchema = z.object({
  id: z.string().min(1),
  authorDisplayName: z.string().nullable(),
  body: z.string(),
  created: z.string(),
});

/** The human's reply to Router's latest decision-request comment (`findHumanDecision` in
 *  src/pm/context.ts, resolved by Router since only Router knows its own Jira account). */
export const HumanDecisionSnapshotSchema = z.object({
  raw: z.string(),
  optionId: z.string().min(1).optional(),
  decisionId: z.string().min(1).optional(),
  planVersion: z.string().min(1).optional(),
});

/** Extra context Router assembles only for `kind: "planning"` jobs. */
export const PlanningContextSchema = z.object({
  planVersion: z.string().min(1).optional(),
  comments: z.array(CommentSnapshotSchema).default([]),
  existingSubtasks: z.array(IssueSnapshotSchema).default([]),
  humanDecision: HumanDecisionSnapshotSchema.optional(),
});
export type PlanningContext = z.infer<typeof PlanningContextSchema>;

/** What Router hands a worker in response to `jobs/next` or `jobs/{id}/start`. */
export const JobEnvelopeSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  jobId: z.string().min(1),
  attemptId: z.string().min(1),
  leaseToken: z.string().min(1),
  workspaceId: z.string().min(1),
  repositoryId: z.string().min(1),
  kind: z.enum(JOB_KINDS),
  providerId: z.string().min(1),
  approvalId: z.string().min(1),
  /** Hash of the inputs (issue snapshot + planning context) this job was dispatched with, so a
   *  worker resuming a session can detect the request changed underneath it. */
  inputHash: z.string().min(1),
  issueSnapshot: IssueSnapshotSchema,
  planningContext: PlanningContextSchema.optional(),
  systemPrompt: z.string().min(1),
  timeoutMs: z.number().int().positive(),
});
export type JobEnvelope = z.infer<typeof JobEnvelopeSchema>;

export const ExecutionStatusSchema = z.enum([
  "succeeded",
  "failed",
  "cancelled",
  "needs_decision",
  "planned",
]);

/** What a worker submits to `jobs/{id}/result`. Extends the existing `ExecutionResult` shape
 *  (src/agent/result.ts) with the identifiers Router needs for idempotent result handling. */
export const JobResultSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  jobId: z.string().min(1),
  attemptId: z.string().min(1),
  resultId: z.string().min(1),
  status: ExecutionStatusSchema,
  summary: z.string().min(1),
  branch: z.string().optional(),
  /** The pull request the worker opened for `branch` (ADR 0027); Router closes the loop on merge. */
  pullRequest: z
    .object({
      repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
      number: z.number().int().positive(),
      url: z.string().url(),
    })
    .optional(),
  changes: z.array(z.string()).optional(),
  validation: z.array(z.string()).optional(),
  artifacts: z.array(z.string()).optional(),
  failureReason: z.string().optional(),
  blockingIssue: z.string().optional(),
  timedOut: z.boolean().optional(),
  decisionRequest: z.string().optional(),
  /** Present only for `kind: "planning"` jobs. */
  plan: PlanSchema.optional(),
});
export type JobResult = z.infer<typeof JobResultSchema>;
