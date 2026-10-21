import { z } from "zod";
import { PLAN_JSON_SCHEMA, PlanTaskSchema } from "../pm/plan.js";

export const GitIntegrationSchema = z.object({
  baseBranch: z.string().min(1),
  mergeCommits: z.array(z.string().regex(/^[a-f0-9]{40}$/i)),
});
export const QualityContextSchema = z.object({
  cycleId: z.string().min(1),
  planVersion: z.string().min(1),
  policyVersion: z.literal(1),
  objective: z.string().min(1),
  acceptance: z.array(z.string()).min(1),
  verification: z.array(z.string()).min(1),
  integration: GitIntegrationSchema,
  resultIds: z.array(z.string()).min(1),
  previousFindings: z.array(z.string()).default([]),
  expectedSha: z
    .string()
    .regex(/^[a-f0-9]{40}$/i)
    .optional(),
  verificationOnly: z.boolean().optional(),
});
export type QualityContext = z.infer<typeof QualityContextSchema>;

export const QualityFindingSchema = z.object({
  id: z.string().min(1),
  category: z.enum(["defect", "new_debt", "existing_debt", "environment", "unknown"]),
  summary: z.string().min(1),
  evidence: z.array(z.string().min(1)).min(1),
  impact: z.string().min(1),
  remediation: PlanTaskSchema.refine(
    (task) => task.acceptance.length > 0 && task.verification.length > 0,
    "remediation needs acceptance and verification",
  ),
});
export const QualityReportSchema = z
  .object({
    targetSha: z.string().regex(/^[a-f0-9]{40}$/i),
    baselineSha: z.string().regex(/^[a-f0-9]{40}$/i),
    summary: z.string().min(1),
    verificationPassed: z.boolean(),
    verificationEvidence: z.array(z.string().min(1)).min(1),
    findings: z.array(QualityFindingSchema),
  })
  .superRefine((report, ctx) => {
    if (new Set(report.findings.map((finding) => finding.id)).size !== report.findings.length)
      ctx.addIssue({ code: "custom", path: ["findings"], message: "finding ids must be unique" });
  });
export type QualityReport = z.infer<typeof QualityReportSchema>;

const strings = { type: "array", items: { type: "string" } } as const;
export const QUALITY_REPORT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "targetSha",
    "baselineSha",
    "summary",
    "verificationPassed",
    "verificationEvidence",
    "findings",
  ],
  properties: {
    targetSha: { type: "string" },
    baselineSha: { type: "string" },
    summary: { type: "string" },
    verificationPassed: { type: "boolean" },
    verificationEvidence: strings,
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "category", "summary", "evidence", "impact", "remediation"],
        properties: {
          id: { type: "string" },
          category: {
            type: "string",
            enum: ["defect", "new_debt", "existing_debt", "environment", "unknown"],
          },
          summary: { type: "string" },
          evidence: strings,
          impact: { type: "string" },
          remediation: PLAN_JSON_SCHEMA.properties.tasks.items,
        },
      },
    },
  },
} as const;
