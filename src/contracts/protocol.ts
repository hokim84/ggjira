/**
 * Version of the Router <-> Worker wire contract (job envelopes, results, and
 * the `/api/v1/*` request/response shapes). Bumped whenever an incompatible
 * change is made; Router and Worker both reject a mismatch before executing
 * anything (docs/router-service-implementation-plan.md §3 "버전 불일치는 실행 전에
 * 명시적인 호환 오류로 처리한다").
 */
export const PROTOCOL_VERSION = 1;

export const JOB_KINDS = ["planning", "implementation"] as const;
export type JobKind = (typeof JOB_KINDS)[number];
