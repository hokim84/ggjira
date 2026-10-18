import type { JobResult } from "../contracts/envelope.js";
import type { AttentionKind } from "./db/attention.js";
import { normalizeCause } from "./db/attention.js";
import type { ReviewAssessment } from "./review-gate.js";

/**
 * Which results need a human's attention, and as what incident (M4-09, ADR 0041). Pure. The
 * classification itself is ADR 0040's review assessment: an `immediate` result is an attention
 * item, a `standard` one waits in the ordinary review queue, and heartbeats, lease renewals and
 * automatic report retries stay internal records — they never become items.
 *
 * `evidence` holds only what makes two tellings of an incident differ in substance (the failure
 * text, the paths, the question); ids and timestamps are left out so a resend or a retry that
 * changes nothing counts as a repeat.
 */
export interface ResultAttention {
  kind: AttentionKind;
  cause: string;
  reason: string;
  evidence: Record<string, unknown>;
}

export function resultAttention(
  result: JobResult,
  review: ReviewAssessment,
): ResultAttention | undefined {
  if (review.reviewClass !== "immediate") return undefined;
  const codes = review.reasons.map((reason) => reason.code);
  if (codes.includes("failed")) {
    const text = result.failureReason ?? result.summary;
    return {
      kind: "failed",
      cause: normalizeCause(text),
      reason: `${review.reasons[0]?.detail ?? "the run failed"}; it does not run again under the same approval`,
      // Normalized like the cause: another run of the same failing test is not new evidence.
      evidence: { failureReason: normalizeCause(text) },
    };
  }
  if (codes.includes("scope_deviation")) {
    const paths = (result.scopeCheck?.outsideAllowed ?? []).map((change) => change.path).sort();
    const deviations = (result.implementation?.scopeDeviations ?? []).map((d) => d.description);
    return {
      kind: "scope_deviation",
      cause: normalizeCause([...paths, ...deviations].join(" ") || "scope deviation"),
      reason: "the run stopped before commit because it went beyond the approved scope",
      evidence: { paths, deviations },
    };
  }
  if (codes.includes("decision_needed")) {
    const question =
      result.implementation?.decision?.question ??
      result.plan?.decision?.question ??
      result.summary;
    return {
      kind: "decision_needed",
      cause: normalizeCause(question),
      reason: "the run waits for a human decision",
      evidence: { question },
    };
  }
  return {
    kind: "review_required",
    cause: [...codes].sort().join(","),
    reason: `needs individual review: ${review.reasons.map((reason) => reason.detail).join("; ")}`,
    evidence: {
      reasons: codes,
      matches: review.risk.matches,
      agentRisks: review.risk.agentRisks,
      notVerified: review.verification.notVerified,
    },
  };
}

/** Kinds a fresh approval of the issue settles: whatever the earlier run left behind. */
export const SETTLED_BY_NEW_APPROVAL: readonly AttentionKind[] = [
  "failed",
  "decision_needed",
  "scope_deviation",
  "review_required",
];
