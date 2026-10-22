import { z } from "zod";
import { DECISION_REQUEST_JSON_SCHEMA, DecisionRequestSchema } from "./decision.js";

/**
 * The approved scope contract (ADR 0034) as Router hands it to an implementation worker
 * (`JobEnvelope.executionContract`, ADR 0036). Copied from the approval snapshot, so it is exactly
 * what the input hash covers. `allowedPaths` is enforced by the worker when non-empty;
 * `affectedAreas` is a hint only.
 */
export const ExecutionContractSchema = z.object({
  acceptance: z.array(z.string()).default([]),
  verification: z.array(z.string()).default([]),
  inScope: z.array(z.string()).default([]),
  outOfScope: z.array(z.string()).default([]),
  affectedAreas: z.array(z.string()).default([]),
  allowedPaths: z.array(z.string()).default([]),
  constraints: z.array(z.string()).default([]),
});
export type ExecutionContract = z.infer<typeof ExecutionContractSchema>;

export const VERIFICATION_STATUSES = ["pass", "fail", "not_verified"] as const;

/**
 * What the implement agent reports in its final, structured answer — the same model call that did
 * the work, never an extra one. `scopeDeviations` is the agent's own judgement that it went (or
 * would have to go) beyond the contract; path checks cannot see that, so it is reported here.
 */
export const ImplementationReportSchema = z
  .object({
    outcome: z.enum(["completed", "needs_decision"]),
    summary: z.string().min(1),
    noChangeReason: z.string().min(1).optional(),
    scopeDeviations: z
      .array(z.object({ description: z.string().min(1), reason: z.string().min(1) }))
      .default([]),
    decision: DecisionRequestSchema.optional(),
    /** Changes inside the contract that still deserve a human's individual review — a public API
     *  or contract, data migration, permission/security policy — in the agent's own judgement
     *  (M4-11, ADR 0040). Path rules cannot see meaning; this is kept as evidence next to them. */
    risks: z
      .array(z.object({ area: z.string().min(1), description: z.string().min(1) }))
      .default([]),
    verification: z
      .array(
        z.object({
          acceptance: z.string().min(1),
          status: z.enum(VERIFICATION_STATUSES),
          evidence: z.string(),
        }),
      )
      .default([]),
  })
  .superRefine((report, ctx) => {
    if (report.outcome === "needs_decision" && !report.decision) {
      ctx.addIssue({
        code: "custom",
        path: ["decision"],
        message: "decision is required when outcome is needs_decision",
      });
    }
  });
export type ImplementationReport = z.infer<typeof ImplementationReportSchema>;

/**
 * Hand-authored JSON Schema mirroring ImplementationReportSchema, passed to the provider as
 * outputSchema. `test/contracts-implementation-schema.test.ts` keeps the two in step.
 */
export const IMPLEMENTATION_REPORT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["outcome", "summary", "scopeDeviations", "risks", "verification"],
  properties: {
    noChangeReason: { type: "string" },
    outcome: { type: "string", enum: ["completed", "needs_decision"] },
    summary: { type: "string" },
    scopeDeviations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["description", "reason"],
        properties: {
          description: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
    decision: DECISION_REQUEST_JSON_SCHEMA,
    risks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["area", "description"],
        properties: {
          area: { type: "string" },
          description: { type: "string" },
        },
      },
    },
    verification: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["acceptance", "status", "evidence"],
        properties: {
          acceptance: { type: "string" },
          status: { type: "string", enum: [...VERIFICATION_STATUSES] },
          evidence: { type: "string" },
        },
      },
    },
  },
} as const;

export const PATH_CHANGE_KINDS = ["added", "modified", "deleted", "renamed"] as const;

export const ChangedPathSchema = z.object({
  path: z.string().min(1),
  change: z.enum(PATH_CHANGE_KINDS),
  /** The old path of a rename. */
  from: z.string().min(1).optional(),
});
export type ChangedPath = z.infer<typeof ChangedPathSchema>;

/**
 * The worker's own check of the changed paths against `allowedPaths`. `checked: false` (no
 * allowed paths, or not a git workspace) means "not checked" — never "no deviation". A clean path
 * check says nothing about semantic scope; that is `ImplementationReport.scopeDeviations`.
 */
export const ScopeCheckSchema = z.object({
  checked: z.boolean(),
  reason: z.string().optional(),
  changedPaths: z.array(ChangedPathSchema).default([]),
  outsideAllowed: z.array(ChangedPathSchema).default([]),
});
export type ScopeCheck = z.infer<typeof ScopeCheckSchema>;

/** Where the worker left changes it did not commit or push (a deviation or failed verification),
 *  and how to clean them up. */
export const LocalEvidenceSchema = z.object({
  worktreePath: z.string().optional(),
  branch: z.string().optional(),
  patchFile: z.string().optional(),
  cleanup: z.string().min(1),
});
export type LocalEvidence = z.infer<typeof LocalEvidenceSchema>;

const GitShaSchema = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);

/**
 * The Git state a result describes, so a human's review attaches to exact commits (M4-11,
 * ADR 0040). `repository: "none"` is a workspace edited in place: there is no commit to point at.
 * `headSha` is set only when the worker committed this run's changes; it is never guessed, and a
 * result without `git` (an older worker) is read as "unknown", not as "no commit".
 */
export const ResultGitSchema = z.object({
  repository: z.enum(["git", "none"]),
  baseBranch: z.string().min(1).optional(),
  /** The commit the job branch started from. */
  baseSha: GitShaSchema.optional(),
  headSha: GitShaSchema.optional(),
  committed: z.boolean(),
});
export type ResultGit = z.infer<typeof ResultGitSchema>;
