import { describe, expect, it } from "vitest";
import { COMMENT_TEXT } from "../src/router/comment-text.js";
import { judgeMerge } from "../src/router/github.js";
import type { ReviewAssessment } from "../src/router/review-gate.js";

/** Router's Jira comment text (ADR 0048): Korean by default, English kept for what is recorded. */
describe("comment text", () => {
  it("records merge judgments in the same English as before, whatever the comment language", () => {
    const target = { supersededBy: null, headSha: "a".repeat(40) } as Parameters<
      typeof judgeMerge
    >[0];
    expect(judgeMerge(undefined, null)).toMatchObject({
      outcome: "no_target",
      reason: "no review target was recorded for this run",
    });
    expect(judgeMerge(target, "b".repeat(40))).toMatchObject({
      outcome: "stale",
      why: { kind: "head_mismatch", merged: "bbbbbbbbbbbb", reviewed: "aaaaaaaaaaaa" },
      reason:
        "the merged head bbbbbbbbbbbb is not the reviewed commit aaaaaaaaaaaa (commits were added after GGJIRA's run)",
    });
    const why = judgeMerge(target, "b".repeat(40)).why;
    expect(COMMENT_TEXT.ko.pullRequest.why(why)).toBe(
      "머지된 head bbbbbbbbbbbb가 검토한 커밋 aaaaaaaaaaaa와 다릅니다(GGJIRA 실행 뒤에 커밋이 추가됐습니다)",
    );
  });

  it("keeps the English refusal reasons attention items are grouped by", () => {
    const refusal = { kind: "needs_decision", planVersion: "plan-1" } as const;
    expect(COMMENT_TEXT.en.plan.refusal(refusal)).toBe(
      "its latest plan plan-1 waits for a decision that has not been answered",
    );
    expect(COMMENT_TEXT.ko.plan.refused("작업 중", refusal)).toBe(
      'GGJIRA는 "작업 중" 상태로의 이동을 계획 승인으로 보지 않았습니다: 최신 계획 plan-1이 아직 답하지 않은 결정을 기다립니다.',
    );
    expect(COMMENT_TEXT.ko.plan.refusedNext(refusal, "AI 계획 요청")).toBe(
      '다음: 결정 요청에 답한 뒤 이슈를 "AI 계획 요청" 상태로 옮겨 최신 계획을 받으세요.',
    );
  });

  it("says the review reasons in Korean from the assessment itself", () => {
    const review = (risk: Partial<ReviewAssessment["risk"]>, commitState = "committed") =>
      ({
        reviewClass: "immediate",
        reasons: [],
        commit: { state: commitState },
        verification: { reported: true, pass: 1, fail: 0, notVerified: 2 },
        risk: {
          status: "unknown",
          policyVersion: null,
          matches: [],
          agentRisks: [],
          basis: "",
          ...risk,
        },
      }) as ReviewAssessment;
    const text = COMMENT_TEXT.ko.result;
    expect(text.reason({ code: "not_verified", detail: "" }, review({}))).toBe(
      "완료 조건 2개가 검증되지 않았습니다",
    );
    expect(text.riskUnknown(review({}))).toBe(
      "고위험 확인: 알 수 없음 — workspace에 review.highRiskPaths가 없습니다.",
    );
    expect(text.riskUnknown(review({ policyVersion: "v1" }, "unknown"))).toBe(
      "고위험 확인: 알 수 없음 — 워커가 변경 경로를 보고하지 않았습니다.",
    );
    const high = review({
      status: "high",
      policyVersion: "v1",
      matches: [{ rule: "auth", path: "src/auth.ts", change: "modified" }],
      agentRisks: [{ area: "db", description: "migration" }],
    });
    expect(text.riskHigh(high)).toBe(
      "고위험 확인: 변경 경로 1개가 고위험 규칙에 맞습니다; AI가 위험 1건을 보고했습니다(규칙 v1)",
    );
    // English shows the basis review-gate wrote.
    expect(COMMENT_TEXT.en.result.riskUnknown(review({ basis: "no rules" }))).toBe(
      "High-risk check: unknown — no rules.",
    );
  });
});
