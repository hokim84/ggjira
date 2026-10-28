import type { DecisionText, ImplementationDecisionText } from "../pm/decision-render.js";
import type { ReviewAssessment, ReviewReason } from "./review-gate.js";

/**
 * Every sentence Router writes on a Jira issue, in each language it writes (ADR 0048). The
 * language is Router config `reporting.language`, Korean by default. Pure: builders pass in what
 * a sentence names (statuses, keys, counts); what agents or people wrote (summaries, notes,
 * questions) is shown as written. Failure codes and their messages are in
 * src/router/failure-codes.ts.
 *
 * Lines other code reads back stay the same in every language: the decision request's
 * `planVersion:`/`decisionId:`/`decisionOptions:` lines and the signature lines
 * (`ggjira job:`, `attempt:`, `approval:`).
 */

export type MessageLanguage = "ko" | "en";

/** Why a merge is or is not the acceptance of the reviewed result (src/router/github.ts). */
export type MergeWhy =
  | { kind: "matched" }
  | { kind: "no_target" }
  | { kind: "superseded" }
  | { kind: "no_merged_head" }
  | { kind: "no_reviewed_commit" }
  | { kind: "head_mismatch"; merged: string; reviewed: string };

/** Why a move to in progress approves no plan (src/router/delegation.ts). */
export type PlanRefusal =
  | { kind: "needs_decision"; planVersion: string }
  | { kind: "not_applied"; planVersion: string }
  | { kind: "earlier_request"; planVersion: string }
  | { kind: "plan_mismatch"; planVersion: string; jiraVersion: string | null };

export interface CommentText {
  failure: {
    failed: string;
    timedOut: string;
    next: (hint: string) => string;
    keptChanges: string;
    details: (logPath: string) => string;
    lostContact: string;
    /** ADR 0062: posted once when a run is left `recovery_required`. */
    uncertainRun: string;
    adminStopped: (admin: string) => string;
    nothingApplied: string;
  };
  planningStarted: (requestStatus: string) => string;
  stopped: string;
  unassigned: { title: string; impact: string; next: (statusName: string) => string };
  pullRequest: {
    merged: (number: number, by: string | null) => string;
    closed: (number: number, by: string | null) => string;
    withheld: (reason: string) => string;
    moveYourself: string;
    headNotCompared: (reason: string) => string;
    highRisk: string;
    movingToDone: (doneStatus: string) => string;
    closedNext: string;
    why: (why: MergeWhy) => string;
  };
  reviewJudgment: {
    subject: (attemptId: string, headSha: string | null) => string;
    hold: (subject: string) => string;
    rework: (subject: string) => string;
    by: (actor: string) => string;
    reason: (note: string) => string;
    holdNothing: string;
    reworkNext: (hint: string) => string;
    /** ADR 0061, 0066: a confirm of a child completed with unverified checks. */
    childConfirmed: (subject: string, completeStatus: string) => string;
  };
  /** ADR 0066: a child completed with acceptance criteria only a person can check. */
  humanCheck: {
    waiting: (checks: string[], completeStatus: string, inProgressStatus: string) => string;
  };
  result: {
    completed: string;
    needsReview: string;
    reason: (reason: ReviewReason, review: ReviewAssessment) => string;
    ordinaryQueue: string;
    nextWithPullRequest: (url: string, doneStatus: string | undefined) => string;
    nextWithoutPullRequest: (doneStatus: string | undefined) => string;
    reviewedCommit: (head: string, base: string) => string;
    noCommit: (location: string | undefined) => string;
    commitUnknown: string;
    riskHigh: (review: ReviewAssessment) => string;
    riskNotMatched: (policyVersion: string | null) => string;
    riskUnknown: (review: ReviewAssessment) => string;
    agentRisk: (area: string, description: string) => string;
    acceptanceChecks: string;
    verificationStatus: (status: string) => string;
    verificationMethod: (method: string) => string;
    summary: string;
    noSummary: string;
    changes: string;
    validation: string;
    pathScopeNotChecked: (reason: string | undefined) => string;
    artifacts: string;
  };
  plan: {
    applied: string;
    summary: string;
    createdSubtasks: string;
    nothingRunsYet: (hasTasks: boolean) => string;
    toApprove: (requestStatus: string, inProgressStatus: string) => string;
    toChange: (requestStatus: string) => string;
    approved: (planVersion: string, inProgressStatus: string) => string;
    tasksRun: (count: number, inProgressStatus: string, keys: string) => string;
    workInIssue: string;
    withdraw: (inProgressStatus: string, requestStatus: string) => string;
    completed: (keys: string) => string;
    completedNext: (reviewStatus: string) => string;
    refused: (inProgressStatus: string, refusal: PlanRefusal) => string;
    refusedImpact: string;
    refusedNext: (refusal: PlanRefusal, requestStatus: string) => string;
    refusal: (refusal: PlanRefusal) => string;
    superseded: string;
  };
  decision: DecisionText;
  implementationDecision: ImplementationDecisionText;
}

const by = (who: string | null, text: (name: string) => string): string => (who ? text(who) : "");

export const COMMENT_TEXT: Record<MessageLanguage, CommentText> = {
  ko: {
    failure: {
      failed: "실행 실패",
      timedOut: "실행 시간 초과",
      next: (hint) => `다음: 원인을 고친 뒤 ${hint}.`,
      keptChanges: "커밋하지 않은 변경은 워커에 보관했습니다(자세한 내용 참고).",
      details: (logPath) => `자세한 내용: Router 머신의 ${logPath}`,
      lostContact: "AI 실행이 GGJIRA Router와 연결이 끊겼습니다.",
      uncertainRun:
        '실행이 멈췄는지 GGJIRA가 확인할 수 없어 자동으로 다시 실행하지 않습니다(워커 종료·네트워크 단절·워커 해지). 다음: 워커가 멈춘 것을 확인한 뒤 담당자가 "재시도" 댓글을 남기면 새로 실행합니다. 이전 실행이 아직 돌고 있었다면 같은 작업이 한 번 더 실행되지만, 늦게 도착한 이전 결과는 반영하지 않습니다.',
      adminStopped: (admin) => `관리자(${admin})가 실행이 멈춘 것을 확인했습니다.`,
      nothingApplied:
        "다음: 이 실행의 결과는 이슈에 반영되지 않았습니다. 다시 실행하려면 이슈를 요청 상태로 옮기세요.",
    },
    planningStarted: (requestStatus) =>
      `GGJIRA가 계획 실행을 시작하여 "${requestStatus}"으로 이동합니다. 질문에 답하거나 게시된 계획의 작업을 개별 승인하세요.`,
    stopped: "AI 실행이 중지됐습니다.",
    unassigned: {
      title: "GGJIRA가 이 요청을 시작하지 않았습니다: 이슈에 담당자가 없습니다.",
      impact: "영향: 아무것도 실행하지 않습니다. GGJIRA는 책임자가 있는 작업만 실행합니다.",
      next: (statusName) =>
        `다음: 이슈에 책임자를 담당자로 지정하세요. GGJIRA가 다음 확인 때 시작합니다. 이슈는 "${statusName}" 상태에 그대로 있습니다.`,
    },
    pullRequest: {
      merged: (number, who) => `PR #${number}이 머지됐습니다${by(who, (n) => `(머지: ${n})`)}.`,
      closed: (number, who) =>
        `PR #${number}이 머지되지 않고 닫혔습니다${by(who, (n) => `(닫음: ${n})`)}.`,
      withheld: (reason) => `GGJIRA는 이슈를 옮기지 않았습니다: ${reason}.`,
      moveYourself: "머지된 내용을 확인하고 이슈를 직접 옮기세요.",
      headNotCompared: (reason) => `head 커밋을 비교하지 못했습니다: ${reason}.`,
      highRisk:
        "이 결과는 고위험으로 표시됐습니다. GGJIRA는 머지를 막지 않습니다. 필수 리뷰는 저장소의 branch protection만 강제합니다.",
      movingToDone: (doneStatus) => `이슈를 "${doneStatus}" 상태로 옮깁니다.`,
      closedNext: "이슈는 그대로 둡니다. 작업을 다시 하려면 요청 상태로 옮기세요.",
      why: (why) => {
        switch (why.kind) {
          case "matched":
            return "머지된 head가 검토한 커밋입니다";
          case "no_target":
            return "이 실행의 검토 대상이 기록되지 않았습니다";
          case "superseded":
            return "이 이슈에 더 새로운 결과가 있습니다. 이 PR은 이전 실행의 것입니다";
          case "no_merged_head":
            return "GitHub이 머지된 head 커밋을 알려 주지 않았습니다";
          case "no_reviewed_commit":
            return "워커가 만든 커밋을 보고하지 않았습니다";
          case "head_mismatch":
            return `머지된 head ${why.merged}가 검토한 커밋 ${why.reviewed}와 다릅니다(GGJIRA 실행 뒤에 커밋이 추가됐습니다)`;
        }
      },
    },
    reviewJudgment: {
      subject: (attemptId, headSha) =>
        `attempt ${attemptId}의 결과(${headSha ? `커밋 ${headSha.slice(0, 12)}` : "커밋 없음"})`,
      hold: (subject) => `검토 보류: ${subject}.`,
      rework: (subject) => `재작업 요청: ${subject}.`,
      by: (actor) => `요청자: ${actor}(공유 관리자 토큰으로 밝힌 이름).`,
      reason: (note) => `이유: ${note}`,
      holdNothing: "아무것도 승인하거나 옮기지 않았습니다. 결과는 계속 검토를 기다립니다.",
      reworkNext: (hint) => `GGJIRA가 스스로 다시 실행하지 않습니다. 다음: ${hint}.`,
      childConfirmed: (subject, completeStatus) =>
        `사람 확인 완료: ${subject}. AI가 확인하지 못한 항목을 사람이 확인했습니다. 이슈는 "${completeStatus}"에 둡니다.`,
    },
    humanCheck: {
      waiting: (checks, completeStatus, inProgressStatus) =>
        [
          `사람 확인 필요: 구현 결과 커밋을 원격에 보존하고 "${completeStatus}"(으)로 옮겼지만, AI가 다음 완료 조건을 확인하지 못했습니다.`,
          ...checks.map((check) => `- ${check}`),
          `다음: 부모 PR을 병합하기 전에 직접 확인하고 Router 검토 화면에서 확인을 기록하세요. 문제가 있으면 설명을 고친 뒤 이슈를 "${inProgressStatus}"(으)로 옮겨 다시 요청하세요.`,
        ].join("\n"),
    },
    result: {
      completed: "구현을 완료했습니다.",
      needsReview: "받아들이기 전에 개별 검토가 필요합니다:",
      reason: (reason, review) => {
        switch (reason.code) {
          case "failed":
            return reason.detail.includes("timed out")
              ? "실행이 시간 초과됐습니다"
              : "실행이 실패했습니다";
          case "scope_deviation":
            return "승인된 범위를 벗어났습니다";
          case "decision_needed":
            return "AI가 사람의 결정을 요청했습니다";
          case "high_risk":
            return koRiskBasis(review);
          case "not_verified":
            return `완료 조건 ${review.verification.notVerified}개가 검증되지 않았습니다`;
          case "no_commit":
            return `검토할 커밋이 없습니다(${review.commit.location ?? "위치 모름"}). 결과 자체로 판단하세요`;
          case "commit_unknown":
            return "워커가 이 결과의 커밋을 보고하지 않았습니다(이전 버전 워커)";
          case "no_trusted_validation":
            return "워커 검증 명령이 실행되지 않았습니다. AI 자체 보고만 근거입니다";
        }
      },
      ordinaryQueue: "일반 검토 대기열에 올렸습니다.",
      nextWithPullRequest: (url, doneStatus) =>
        // The URL stands apart: a particle written onto it would become part of Jira's link.
        `다음: PR을 검토하고 머지하세요 — ${url}${doneStatus ? ` (병합 후 통합 검증이 통과하면 "${doneStatus}"으로 이동합니다. FCI는 활성화된 경우 병합 후 별도로 분석합니다)` : ""}`,
      nextWithoutPullRequest: (doneStatus) =>
        `다음: 아래 결과를 검토하세요${doneStatus ? `. 이슈는 직접 "${doneStatus}" 상태로 옮기세요` : ""}. PR은 없습니다.`,
      reviewedCommit: (head, base) => `검토 대상 커밋: ${head}(base ${base})`,
      noCommit: (location) =>
        `커밋 없음: ${location ?? "위치 모름"}. 커밋 기반 최신성 확인은 적용되지 않습니다.`,
      commitUnknown: "커밋: 워커가 보고하지 않았습니다.",
      riskHigh: (review) =>
        `고위험 확인: ${koRiskBasis(review)}${review.risk.policyVersion ? `(규칙 ${review.risk.policyVersion})` : ""}`,
      riskNotMatched: (policyVersion) => `고위험 확인: 맞는 규칙 없음(규칙 ${policyVersion}).`,
      riskUnknown: (review) => `고위험 확인: 알 수 없음 — ${koRiskBasis(review)}.`,
      agentRisk: (area, description) => `- AI: ${area} — ${description}`,
      acceptanceChecks: "완료 조건 확인:",
      verificationStatus: (status) =>
        ({ pass: "통과", fail: "실패", not_verified: "미검증" })[status] ?? status,
      verificationMethod: (method) =>
        ({ executed: "실행", inspected: "코드 확인" })[method] ?? method,
      summary: "요약:",
      noSummary: "(요약 없음)",
      changes: "변경:",
      validation: "검증 명령:",
      pathScopeNotChecked: (reason) => `경로 범위: 확인하지 않음(${reason ?? "이유 없음"}).`,
      artifacts: "산출물:",
    },
    plan: {
      applied: "계획을 반영했습니다.",
      summary: "요약:",
      createdSubtasks: "만든 하위 작업:",
      nothingRunsYet: (hasTasks) =>
        `아직 아무것도 실행하지 않습니다${hasTasks ? ". 하위 작업도 승인을 기다립니다" : ""}.`,
      toApprove: (requestStatus, inProgressStatus) =>
        `이 계획을 승인하려면: 이슈를 "${requestStatus}"에서 "${inProgressStatus}" 상태로 옮기세요.`,
      toChange: (requestStatus) =>
        `바꾸려면: "${requestStatus}" 상태에서 제목이나 설명을 수정하세요. 자동으로 다시 계획합니다.`,
      approved: (planVersion, inProgressStatus) =>
        `계획 ${planVersion} 승인: "${inProgressStatus}" 상태로의 이동을 승인으로 기록했습니다.`,
      tasksRun: (count, inProgressStatus, keys) =>
        `하위 작업 ${count}개를 "${inProgressStatus}" 상태로 옮기고 이 승인으로 실행합니다: ${keys}. 이 이슈는 조정만 합니다.`,
      workInIssue: "작업은 이 이슈 자체에서 합니다.",
      withdraw: (inProgressStatus, requestStatus) =>
        `철회하려면: 이슈를 "${inProgressStatus}" 상태 밖으로 옮기세요. 계획을 바꾸려면: "${requestStatus}" 상태로 옮기세요.`,
      completed: (keys) => `승인된 계획의 하위 작업이 모두 끝났습니다: ${keys}.`,
      completedNext: (reviewStatus) =>
        `다음: 여기서 전체 결과를 검토하세요. 이슈는 "${reviewStatus}" 상태로 옮겨집니다.`,
      refused: (inProgressStatus, refusal) =>
        `GGJIRA는 "${inProgressStatus}" 상태로의 이동을 계획 승인으로 보지 않았습니다: ${COMMENT_TEXT.ko.plan.refusal(refusal)}.`,
      refusedImpact: "영향: 아무것도 실행하지 않습니다. 이 이슈는 사람의 작업으로 봅니다.",
      refusedNext: (refusal, requestStatus) =>
        `다음: ${refusal.kind === "needs_decision" ? "결정 요청에 답한 뒤 " : ""}이슈를 "${requestStatus}" 상태로 옮겨 최신 계획을 받으세요.`,
      refusal: (refusal) => {
        switch (refusal.kind) {
          case "needs_decision":
            return `최신 계획 ${refusal.planVersion}이 아직 답하지 않은 결정을 기다립니다`;
          case "not_applied":
            return `최신 계획 ${refusal.planVersion}을 적용할 수 없었습니다`;
          case "earlier_request":
            return `계획 ${refusal.planVersion}은 최신 요청이 아니라 이전 요청에 대한 계획입니다`;
          case "plan_mismatch":
            return `Jira의 계획(${refusal.jiraVersion ?? "없음"})이 검토한 계획 ${refusal.planVersion}이 아닙니다`;
        }
      },
      superseded: "부모 이슈를 다시 계획해 이 하위 작업은 대체됐습니다.",
    },
    decision: {
      needsDecision: "GGJIRA가 계획을 계속하려면 결정이 필요합니다.",
      question: "질문:",
      options: "선택지:",
      pros: "장점",
      cons: "단점",
      recommendation: "추천:",
      impact: "영향:",
      respond: (replyStatus) =>
        `답하려면: 담당자가 이 이슈에 선택지 번호만 댓글로 남기세요(예: 2). "${replyStatus}" 상태에서 자동으로 다시 계획합니다.`,
    },
    implementationDecision: {
      stopped: "GGJIRA가 이 구현을 커밋·push 전에 멈췄습니다: 사람의 결정이 필요합니다.",
      whatHappened: "무슨 일이 있었나:",
      outOfScope: (description, reason) => `- 범위 밖: ${description}(${reason})`,
      changedOutside: "- 허용 경로 밖에서 바뀐 경로:",
      question: "질문:",
      options: "선택지:",
      pros: "장점",
      cons: "단점",
      recommendation: "추천:",
      impact: "영향:",
      defaultImpact:
        "아무것도 커밋·push하지 않았고 PR도 열지 않았습니다. 이슈는 결정을 기다립니다.",
      toContinue: (requestStatus) =>
        `계속하려면: 결정을 이슈 설명에 적은 뒤 이슈를 "${requestStatus}" 상태로 옮겨 다시 계획하세요. 댓글만으로는 부족합니다. 실행은 승인된 계획을 따르므로, 범위가 바뀌면 새 계획과 새 승인이 필요합니다.`,
      evidence: "증거(워커에 있음):",
      branch: (branch) => `- 브랜치: ${branch}(push 안 함)`,
    },
  },
  en: {
    failure: {
      failed: "Execution failed",
      timedOut: "Execution timed out",
      next: (hint) => `Next: fix the cause, then ${hint}.`,
      keptChanges: "Uncommitted changes were kept on the worker (see the details).",
      details: (logPath) => `Details: ${logPath} on the Router machine.`,
      lostContact: "AI execution lost contact with GGJIRA Router.",
      uncertainRun:
        'GGJIRA cannot tell whether the run stopped (worker stopped, network lost or worker revoked), so it does not rerun it by itself. Next: once the worker is known to be stopped, the assignee comments "재시도" to start a new run. If the old run was still going, the work runs once more, but its late result is not applied.',
      adminStopped: (admin) => `An admin (${admin}) confirmed the run is stopped.`,
      nothingApplied:
        "Next: nothing from this run was applied; to run it again, move the issue back to its request status.",
    },
    planningStarted: (requestStatus) =>
      `GGJIRA started planning and moves this issue to "${requestStatus}". Answer questions or approve individual tasks when ready.`,
    stopped: "AI execution stopped.",
    unassigned: {
      title: "GGJIRA did not start this request: the issue has no assignee.",
      impact: "Impact: nothing runs; GGJIRA only runs work a person is responsible for.",
      next: (statusName) =>
        `Next: assign the issue to that person. GGJIRA starts on its next pass; the issue stays in "${statusName}".`,
    },
    pullRequest: {
      merged: (number, who) => `Pull request #${number} was merged${by(who, (n) => ` by ${n}`)}.`,
      closed: (number, who) =>
        `Pull request #${number} was closed without merging${by(who, (n) => ` by ${n}`)}.`,
      withheld: (reason) => `GGJIRA did not move the issue: ${reason}.`,
      moveYourself: "Check what was merged and move the issue yourself.",
      headNotCompared: (reason) => `Head commit not compared: ${reason}.`,
      highRisk:
        "This result was flagged high risk. GGJIRA does not block merges; only the repository's branch protection enforces a required review.",
      movingToDone: (doneStatus) => `Moving the issue to "${doneStatus}".`,
      closedNext:
        "The issue stays where it is. To redo the work, move it back to its request status.",
      why: (why) => {
        switch (why.kind) {
          case "matched":
            return "the merged head is the reviewed commit";
          case "no_target":
            return "no review target was recorded for this run";
          case "superseded":
            return "a newer result exists for this issue; this pull request is from an earlier run";
          case "no_merged_head":
            return "GitHub did not report the merged head commit";
          case "no_reviewed_commit":
            return "the worker did not report the commit it produced";
          case "head_mismatch":
            return `the merged head ${why.merged} is not the reviewed commit ${why.reviewed} (commits were added after GGJIRA's run)`;
        }
      },
    },
    reviewJudgment: {
      subject: (attemptId, headSha) =>
        `the result of attempt ${attemptId} (${headSha ? `commit ${headSha.slice(0, 12)}` : "no commit"})`,
      hold: (subject) => `Review on hold: ${subject}.`,
      rework: (subject) => `Rework requested: ${subject}.`,
      by: (actor) => `By ${actor} (name declared with the shared admin token).`,
      reason: (note) => `Reason: ${note}`,
      holdNothing: "Nothing was approved or moved. The result stays waiting for review.",
      reworkNext: (hint) => `GGJIRA does not rerun it by itself. Next: ${hint}.`,
      childConfirmed: (subject, completeStatus) =>
        `Confirmed by a person: ${subject}. A person checked what the agent could not. The issue stays in "${completeStatus}".`,
    },
    humanCheck: {
      waiting: (checks, completeStatus, inProgressStatus) =>
        [
          `Needs a person: the result commit is kept on the remote and the issue moved to "${completeStatus}", but the agent could not verify these acceptance criteria.`,
          ...checks.map((check) => `- ${check}`),
          `Next: check them yourself before merging the parent PR and record the confirmation on Router's review screen. If something is wrong, edit the description and move the issue to "${inProgressStatus}" to request it again.`,
        ].join("\n"),
    },
    result: {
      completed: "Implementation completed.",
      needsReview: "Needs your individual review before it is accepted:",
      reason: (reason) => reason.detail,
      ordinaryQueue: "Ready for the ordinary review queue.",
      nextWithPullRequest: (url, doneStatus) =>
        `Next: review and merge ${url}${doneStatus ? `; successful integration validation then moves the issue to "${doneStatus}"` : ""}. Optional FCI analysis runs only after merge. Done remains manual.`,
      nextWithoutPullRequest: (doneStatus) =>
        `Next: review the result below${doneStatus ? ` and move the issue to "${doneStatus}" yourself` : ""}; there is no pull request.`,
      reviewedCommit: (head, base) => `Reviewed commit: ${head} (base ${base})`,
      noCommit: (location) =>
        `No commit: ${location ?? "unknown location"}. Commit-based freshness checks do not apply.`,
      commitUnknown: "Commit: not reported by the worker.",
      riskHigh: (review) =>
        `High-risk check: ${review.risk.basis}${review.risk.policyVersion ? ` (rules ${review.risk.policyVersion})` : ""}`,
      riskNotMatched: (policyVersion) =>
        `High-risk check: no rule matched (rules ${policyVersion}).`,
      riskUnknown: (review) => `High-risk check: unknown — ${review.risk.basis}.`,
      agentRisk: (area, description) => `- agent: ${area} — ${description}`,
      acceptanceChecks: "Acceptance checks:",
      verificationStatus: (status) => status,
      verificationMethod: (method) => method,
      summary: "Summary:",
      noSummary: "(no summary)",
      changes: "Changes:",
      validation: "Validation:",
      pathScopeNotChecked: (reason) => `Path scope: not checked (${reason ?? "no reason given"}).`,
      artifacts: "Artifacts:",
    },
    plan: {
      applied: "Plan applied.",
      summary: "Summary:",
      createdSubtasks: "Created subtasks:",
      nothingRunsYet: (hasTasks) =>
        `Nothing runs yet${hasTasks ? "; the subtasks wait for the approval too" : ""}.`,
      toApprove: (requestStatus, inProgressStatus) =>
        `To approve this plan: move the issue from "${requestStatus}" to "${inProgressStatus}".`,
      toChange: (requestStatus) =>
        `To change it: edit the title or description in "${requestStatus}"; planning restarts automatically.`,
      approved: (planVersion, inProgressStatus) =>
        `Plan ${planVersion} approved: GGJIRA recorded the move to "${inProgressStatus}" as its approval.`,
      tasksRun: (count, inProgressStatus, keys) =>
        `Its ${count} subtask(s) move to "${inProgressStatus}" and run under this approval: ${keys}. This issue only coordinates them.`,
      workInIssue: "The work is done in this issue itself.",
      withdraw: (inProgressStatus, requestStatus) =>
        `To withdraw it: move the issue out of "${inProgressStatus}". To change the plan: move it to "${requestStatus}".`,
      completed: (keys) => `All subtasks of the approved plan are done: ${keys}.`,
      completedNext: (reviewStatus) =>
        `Next: review the whole result here; the issue moves to "${reviewStatus}".`,
      refused: (inProgressStatus, refusal) =>
        `GGJIRA did not take the move to "${inProgressStatus}" as approval of a plan: ${COMMENT_TEXT.en.plan.refusal(refusal)}.`,
      refusedImpact: "Impact: nothing runs; the issue is treated as human work.",
      refusedNext: (refusal, requestStatus) =>
        `Next: ${refusal.kind === "needs_decision" ? "answer the decision request, then " : ""}move the issue to "${requestStatus}" to get a current plan.`,
      refusal: (refusal) => {
        switch (refusal.kind) {
          case "needs_decision":
            return `its latest plan ${refusal.planVersion} waits for a decision that has not been answered`;
          case "not_applied":
            return `its latest plan ${refusal.planVersion} could not be applied`;
          case "earlier_request":
            return `plan ${refusal.planVersion} answers an earlier request, not the latest one`;
          case "plan_mismatch":
            return `the plan in Jira (${refusal.jiraVersion ?? "none"}) is not the reviewed plan ${refusal.planVersion}`;
        }
      },
      superseded: "Superseded by a replan of the parent issue.",
    },
    decision: {
      needsDecision: "GGJIRA needs a decision before it can continue planning.",
      question: "Question:",
      options: "Options:",
      pros: "pros",
      cons: "cons",
      recommendation: "Recommendation:",
      impact: "Impact:",
      respond: (replyStatus) =>
        `To respond: the assignee comments only the option number (for example, 2). Planning resumes automatically in "${replyStatus}".`,
    },
    implementationDecision: {
      stopped:
        "GGJIRA stopped this implementation before commit and push: it needs a human decision.",
      whatHappened: "What happened:",
      outOfScope: (description, reason) => `- Out of scope: ${description} (${reason})`,
      changedOutside: "- Changed paths outside Allowed Paths:",
      question: "Question:",
      options: "Options:",
      pros: "pros",
      cons: "cons",
      recommendation: "Recommendation:",
      impact: "Impact:",
      defaultImpact:
        "nothing was committed, pushed or opened as a pull request; the issue waits for a decision.",
      toContinue: (requestStatus) =>
        `To continue: record the decision in the issue description, then move the issue to "${requestStatus}" to plan it again. A comment alone is not enough: the run is held to the approved plan, so a changed scope needs a new plan and a new approval.`,
      evidence: "Evidence (on the worker):",
      branch: (branch) => `- branch: ${branch} (not pushed)`,
    },
  },
};

/** The Korean of `RiskEvidence.basis`, from the same evidence src/router/review-gate.ts reads. */
function koRiskBasis(review: ReviewAssessment): string {
  const { risk, commit } = review;
  switch (risk.status) {
    case "not_applicable":
      return "계획은 코드를 바꾸지 않습니다";
    case "high":
      return [
        risk.matches.length > 0
          ? `변경 경로 ${risk.matches.length}개가 고위험 규칙에 맞습니다`
          : null,
        risk.agentRisks.length > 0 ? `AI가 위험 ${risk.agentRisks.length}건을 보고했습니다` : null,
      ]
        .filter(Boolean)
        .join("; ");
    case "unknown":
      if (!risk.policyVersion) return "workspace에 review.highRiskPaths가 없습니다";
      return commit.state === "unknown"
        ? "워커가 변경 경로를 보고하지 않았습니다"
        : "맞출 git 경로가 없습니다(git 작업 공간이 아님)";
    case "not_matched":
      return "고위험 규칙에 맞는 변경 경로가 없습니다(이것만으로 저위험은 아닙니다)";
  }
}
