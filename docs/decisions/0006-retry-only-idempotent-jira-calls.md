# 0006: Jira 재시도는 멱등(읽기) 호출에만 적용

## Context

`writing-block.md`의 계획(M4)은 "Jira API 일시 오류 재시도(지수 백오프, idempotent 호출만)"를
요구한다. GGJIRA가 쓰는 Jira 호출은 두 종류로 나뉜다.

- 멱등: `searchIssues`(검색), `getIssue`(조회), `getTransitions`(조회) — 몇 번을 다시 불러도
  같은 결과만 돌려주고 부작용이 없다.
- 비멱등: `addComment`(호출마다 새 댓글 생성), `transitionIssue`(이미 전이된 상태에서 다시
  호출하면 실패하거나 의도치 않은 이중 전이가 될 수 있음), `addLabel`/`removeLabel`(Jira 쪽에서
  중복 추가/제거 자체는 안전하지만, GGJIRA의 claim 로직이 "정확히 한 번 성공"을 전제하므로
  자동 재시도 대상에 포함하지 않는다).

## Decision

- `src/jira/retry.ts`의 `withRetry()`(지수 백오프, 기본 3회 시도, 5xx/네트워크 오류만 재시도,
  4xx는 즉시 던짐)를 `JiraClient.searchIssues` / `getIssue` / `getTransitions`에만 적용한다.
- `addComment`, `transitionIssue`(내부에서 `getTransitions`는 재시도되지만 실제 전이 POST는
  아님), `addLabel`, `removeLabel`은 재시도하지 않는다. 실패하면 그대로 호출자(Reporter/Runner)에게
  던져지고, Runner의 `safeReport`가 잡아서 `job.reportingFailed`로 남긴다(ADR 관련: 이 결정과
  함께 T7에서 도입).

## Consequences

- 폴링/조회 단계에서 일시적인 Jira 5xx나 네트워크 오류로 전체 사이클이 실패하지 않는다.
- 쓰기 호출은 실패 시 재시도 없이 즉시 실패로 처리되므로, 댓글 중복 생성이나 이중 전이 같은
  부작용을 만들지 않는다. 대신 실패는 `job.reportingFailed` / `job.failureStage: "jira"`로
  기록되어 사람이 나중에 확인할 수 있다.
- 재시도 파라미터(횟수, 기본 지연)는 하드코딩된 기본값을 쓴다. 운영 중 필요해지면 config로
  노출하는 것을 검토한다 — 지금은 필요하지 않다.
