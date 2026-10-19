# 0039. 이슈별 AI 참여(opt-in 라벨) 관리 API와 웹 UI

## Context

label 모드(ADR 0037)에서 AI 참여는 이슈의 opt-in 라벨 하나로 정해진다. 사람은 Jira에서 라벨을 직접 붙일 수
있지만, 라벨 이름을 틀리거나(대소문자·공백) 다른 라벨을 지우는 실수가 있고, 붙인 뒤에도 왜 시작되지
않는지(요청 상태 아님, 담당자 없음, 준비 보류, 관리자 취소)는 Router 로그를 봐야 알 수 있었다. M4 백로그
M4-03·M4-04는 Router 관리 요청으로 opt-in 라벨만 바꾸고, 웹 UI에서 현재 상태와 보류 이유를 보이라고 한다.

## Decision

1. **API**: `GET /api/v1/admin/issues/:key/opt-in`은 이슈의 상태·라벨·opt-in 여부·열린 job·시작되지 않는
   이유(`blockers`)를 돌려준다(읽기 전용). `PUT …/opt-in {enabled}`는 opt-in 라벨만 붙이거나 뗀다.
   CLI는 `router issue show <KEY>`, `router issue opt-in <KEY> on|off`다. 구현은
   `src/router/issue-opt-in.ts`.
2. **대상 제한**: 이슈 키 형식과 프로젝트가 설정된 workspace에 속하는지를 Jira 호출 전에 검사한다. Jira가 옮겨진
   이슈를 다른 프로젝트 키로 돌려주면 거절한다. legacy workspace는 409 `not_label_mode`다.
3. **쓰기**: Jira의 부분 수정(`update.labels: [{add}|{remove}]`)을 쓴다. 전체 배열을 쓰지 않으므로 다른 사람이
   동시에 고친 일반 라벨을 덮어쓰지 않는다. 제거는 opt-in으로 인정되는 모든 철자(NFC·trim·소문자 기준
   같은 라벨)를 뗀다. 이미 원하는 상태이면 아무것도 쓰지 않는다(`unchanged`). 같은 요청을 반복해도 결과가
   같다.
4. **확인**: 쓰기 뒤 반드시 이슈를 다시 읽어 라벨을 확인한 뒤에만 성공으로 답한다. 4xx(429 포함)는 바뀐
   것이 없으므로 그대로 오류다. 5xx·시간 초과·연결 끊김은 반영됐을 수 있어 재조회로 판단하고, 반영됐으면
   `confirmedAfterError: true`로 성공, 아니면 502 `unconfirmed`다. 재조회도 실패하면 `unconfirmed`다.
   오류는 `unknown_issue`(404), `jira_forbidden`·`jira_rate_limited`·`jira_error`·`unconfirmed`(502)로 구별한다.
5. **감사**: 성공·변경 없음·실패 모두 `audit_log`에 `issue.opt_in.{added|removed|unchanged|failed}`로 남긴다.
   `authentication: "admin-token"`, 전후 라벨, 그때의 열린 job을 함께 적는다. actor는 호출자가 선언한
   이름(`x-ggjira-actor`)이고 공유 관리 token이므로, Jira 담당자 본인의 인증으로 기록하지 않는다.
6. **철회**: 이 API는 job을 직접 취소하지 않는다. 라벨이 사라지면 ADR 0037의 기존 철회 경로(verify 루프,
   다음 reconcile)가 취소하거나 중단을 요청한다. 다시 붙이면 새 승인이므로 관리자가 취소한 이전 승인의 보류는
   새 요청을 막지 않는다.
7. **보류 이유**: 열린 job이 없을 때 `opt_in_missing`·`not_requested`·`no_assignee`·`inputs_changed`·
   `approval_held`·`readiness_hold`를 계산한다. 승인 id 계산(changelog 1회)은 라벨과 요청 상태가 모두 맞을 때만
   한다. 의존성·capability 라우팅·워커 가용성은 reconcile에서만 판단하므로 여기서 "시작 가능"은 "다음 조회에서
   후보가 된다"는 뜻이다.
8. **웹 UI**: `#/issues` 화면에서 이슈 키로 조회하고, Jira 링크·상태·라벨·보류 이유와 다음 행동, 켜기/끄기
   버튼을 보인다. 서버 응답 전에는 성공으로 표시하지 않고, 요청 중에는 버튼을 막는다. 15초마다 다시 읽어
   Jira에서 직접 바뀐 라벨·상태를 반영한다. 버튼 옆에 "라벨은 실행 승인이 아니다", 끌 때는 "열린 작업이
   취소되며 이미 push된 변경은 되돌리지 않는다"를 적는다.

## Consequences

- Router의 Jira 계정에 이슈 편집 권한이 있어야 한다(라벨 쓰기는 보고 경로에서 이미 필요했다).
- 공유 admin token을 가진 사람은 누구나 라벨을 바꿀 수 있다. 개인별 권한 모델은 후속(F02의 actor 권한 모델)이다.
- 라벨을 끈 뒤 최대 5초 동안 commit·push 허가가 남을 수 있다는 ADR 0037의 제약은 그대로다.
- DB migration과 Worker 프로토콜 변경은 없다.
