/**
 * Version of the Router <-> Worker wire contract (job envelopes, results, and
 * the `/api/v1/*` request/response shapes). Bumped whenever an incompatible
 * change is made; Router and Worker both reject a mismatch before executing
 * anything (docs/router-service-implementation-plan.md §3 "버전 불일치는 실행 전에
 * 명시적인 호환 오류로 처리한다").
 *
 * 2 (ADR 0036): the envelope carries `executionContract`, and an implementation `needs_decision`
 * result carries `implementation`/`scopeCheck`/`localEvidence` instead of a plan.
 * 4 (ADR 0052): all workers execute every job kind; no capability fields.
 * 3 (ADR 0051): child-only lifecycle, Git integration inputs and quality_review results.
 */
export const PROTOCOL_VERSION = 8;

export const JOB_KINDS = [
  "planning",
  "implementation",
  "quality_review",
  "integration_check",
  "assemble_pr",
] as const;
export type JobKind = (typeof JOB_KINDS)[number];
