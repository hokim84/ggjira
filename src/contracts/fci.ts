import { z } from "zod";
import { PROTOCOL_VERSION } from "./protocol.js";

export const FCI_VERSION = "fci-v1";
export const FCI_ANALYZER = "ggjira-fci-1/tree-sitter-0.24.7/grammars-0.1.13";
export const FCI_NOTICE =
  "FCI는 코드 구조와 검증 가능성을 평가하는 실험적 상대 지표입니다. 개발 시간·비용 증가율이나 장애 확률이 아닙니다.";
export const FCI_AXES = ["coupling", "complexity", "verification", "ripple", "history"] as const;
export type FciAxis = (typeof FCI_AXES)[number];
export const FCI_LABELS: Record<FciAxis, string> = {
  coupling: "모듈 의존성·결합도",
  complexity: "제어 흐름·구조 복잡도",
  verification: "테스트·검증 어려움",
  ripple: "변경 파급·인터페이스 결합",
  history: "Git 이력의 변경 위험",
};
export const FCI_RUBRIC: Record<FciAxis, readonly string[]> = {
  coupling: [
    "명확히 분리됨",
    "제한된 직접 결합",
    "공유 모듈에 집중된 결합",
    "경계를 넘는 순환·상태 결합",
    "광범위한 순환과 숨은 상태 결합",
  ],
  complexity: [
    "단순하고 독립적인 흐름",
    "국소적인 분기",
    "중첩·중복이 여러 곳에 존재",
    "복합 분기와 중복 규칙이 얽힘",
    "변경 경로를 격리하기 어려운 구조",
  ],
  verification: [
    "핵심 동작을 독립 검증 가능",
    "일부 준비 작업 필요",
    "주요 경계의 검증 공백",
    "환경·전역 상태 의존으로 검증 곤란",
    "핵심 동작의 재현·판정이 매우 어려움",
  ],
  ripple: [
    "계약이 좁고 영향이 국소적",
    "제한된 소비자 영향",
    "여러 소비자의 조정 필요",
    "공개·직렬화 계약 변경이 넓게 전파",
    "숨은 계약과 동시 변경이 광범위함",
  ],
  history: [
    "충분한 이력에서 독립 변경 확인",
    "드문 공동 변경",
    "반복되는 비국소적 공동 변경",
    "구조 근거와 연결된 반복 수정·되돌림",
    "여러 경계에서 지속되는 수정 연쇄",
  ],
};
const weight = z.number().min(0).max(1);
export const FciWeightsSchema = z
  .object({
    coupling: weight.default(0.25),
    complexity: weight.default(0.2),
    verification: weight.default(0.25),
    ripple: weight.default(0.2),
    history: weight.default(0.1),
  })
  .refine(
    (w) => Math.abs(Object.values(w).reduce((a, b) => a + b, 0) - 1) < 1e-9,
    "weights must sum to 1",
  );
export type FciWeights = z.infer<typeof FciWeightsSchema>;
export const ShaSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const FciConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    baselineSha: ShaSchema.optional(),
    modelId: z.string().min(1).optional(),
    providerType: z.enum(["codex", "claude-code"]).default("codex"),
    ruleVersion: z.string().min(1).default(FCI_VERSION),
    weights: FciWeightsSchema.default({}),
    timeoutMs: z.number().int().min(1000).max(3600000).default(600000),
  })
  .refine(
    (c) => !c.enabled || Boolean(c.baselineSha && c.modelId),
    "FCI requires an explicit baseline SHA and model ID",
  );
export const FciEvidenceSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive(),
  endLine: z.number().int().positive().optional(),
  explanation: z.string().min(1),
});
const AxisAssessmentSchema = z.object({
  grade: z.number().int().min(0).max(4).nullable(),
  confidence: z.enum(["low", "medium", "high"]),
  explanation: z.string().min(1),
  evidence: z.array(FciEvidenceSchema),
  uncertainties: z.array(z.string()),
});
export const FciAssessmentSchema = z.object({
  summary: z.string().min(1),
  axes: z.object({
    coupling: AxisAssessmentSchema,
    complexity: AxisAssessmentSchema,
    verification: AxisAssessmentSchema,
    ripple: AxisAssessmentSchema,
    history: AxisAssessmentSchema,
  }),
  priorities: z.array(
    z.object({
      priority: z.enum(["high", "medium", "low"]),
      suggestion: z.string().min(1),
      evidence: z.array(FciEvidenceSchema),
    }),
  ),
  unverified: z.array(z.string()),
});
export type FciAssessment = z.infer<typeof FciAssessmentSchema>;
export const FCI_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "axes", "priorities", "unverified"],
  properties: {
    summary: { type: "string" },
    axes: {
      type: "object",
      additionalProperties: false,
      required: [...FCI_AXES],
      properties: Object.fromEntries(
        FCI_AXES.map((axis) => [
          axis,
          {
            type: "object",
            additionalProperties: false,
            required: ["grade", "confidence", "explanation", "evidence", "uncertainties"],
            properties: {
              grade: { type: ["integer", "null"], minimum: 0, maximum: 4 },
              confidence: { type: "string", enum: ["low", "medium", "high"] },
              explanation: { type: "string" },
              evidence: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["path", "line", "explanation"],
                  properties: {
                    path: { type: "string" },
                    line: { type: "integer", minimum: 1 },
                    explanation: { type: "string" },
                  },
                },
              },
              uncertainties: { type: "array", items: { type: "string" } },
            },
          },
        ]),
      ),
    },
    priorities: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["priority", "suggestion", "evidence"],
        properties: {
          priority: { type: "string", enum: ["high", "medium", "low"] },
          suggestion: { type: "string" },
          evidence: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["path", "line", "explanation"],
              properties: {
                path: { type: "string" },
                line: { type: "integer", minimum: 1 },
                explanation: { type: "string" },
              },
            },
          },
        },
      },
    },
    unverified: { type: "array", items: { type: "string" } },
  },
};
export function rawFci(assessment: FciAssessment, weights: FciWeights): number | null {
  if (FCI_AXES.some((axis) => assessment.axes[axis].grade === null)) return null;
  return FCI_AXES.reduce(
    (sum, axis) => sum + weights[axis] * 25 * (assessment.axes[axis].grade as number),
    0,
  );
}
export function normalizedFci(raw: number | null, baseline: number | null): number | null {
  return raw === null || baseline === null ? null : 100 + raw - baseline;
}
export const FciSnapshotSchema = z.object({
  sha: ShaSchema,
  assessment: FciAssessmentSchema,
  facts: z.record(z.unknown()),
  model: z.string().min(1),
  modelSource: z.enum(["reported", "configured"]),
  providerVersion: z.string().default("unreported"),
  analyzedAt: z.string(),
  tests: z.array(
    z.object({
      command: z.string(),
      status: z.enum(["pass", "fail", "not_run"]),
      evidence: z.string(),
    }),
  ),
});
export type FciSnapshot = z.infer<typeof FciSnapshotSchema>;
export const FciTaskSchema = z.object({
  id: z.string(),
  attemptId: z.string(),
  leaseToken: z.string(),
  repositoryId: z.string(),
  providerId: z.string(),
  model: z.string(),
  providerType: z.enum(["codex", "claude-code"]).default("codex"),
  seriesId: z.string(),
  profileKey: z.string(),
  purpose: z.enum(["baseline", "task_result", "pr_preview", "merge_final", "manual"]),
  baseBranch: z.string(),
  baselineSha: ShaSchema,
  beforeSha: ShaSchema,
  afterSha: ShaSchema,
  prRepo: z.string().nullable(),
  prNumber: z.number().nullable(),
  issueKey: z.string().nullable(),
  systemPrompt: z.string(),
  weights: FciWeightsSchema,
  timeoutMs: z.number(),
  revision: z.number(),
  mergeSha: ShaSchema.nullable(),
  prCommits: z.array(ShaSchema),
  originalBaseSha: ShaSchema.nullable(),
  validationEvidence: z
    .array(z.object({ sha: ShaSchema, summary: z.string(), source: z.literal("implementation") }))
    .default([]),
});
export type FciTask = z.infer<typeof FciTaskSchema>;
export const FciOutcomeSchema = z.object({
  status: z.enum(["succeeded", "failed", "unassessable"]),
  reason: z.string().optional(),
  beforeSha: ShaSchema.optional(),
  afterSha: ShaSchema.optional(),
  snapshots: z.array(FciSnapshotSchema).default([]),
  boundary: z.string().optional(),
  change: z.record(z.unknown()).optional(),
});
export type FciOutcome = z.infer<typeof FciOutcomeSchema>;
export const FciNextRequestSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  workerId: z.string(),
  sessionId: z.string(),
  requestId: z.string(),
  providers: z.array(z.object({ id: z.string(), model: z.string().optional(), type: z.string() })),
});
export const FciLeaseRequestSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  sessionId: z.string(),
  leaseToken: z.string(),
});
export const FciResultRequestSchema = FciLeaseRequestSchema.extend({
  resultId: z.string(),
  outcome: FciOutcomeSchema,
});
