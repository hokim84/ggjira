# 0035. 승인 입력 해시 v2

## Context

2단계(ADR 0019)에서 만든 입력 해시(v1)는 파싱한 objective·acceptance·dependencies·constraints·capabilities와 계획
버전만 담았다. 워커는 제목과 설명 전체를 실행 지시로 받는데, 제목(Objective 줄이 있을 때), 설명의 자유
텍스트, 실행 전략, ADR 0034의 범위 계약이 바뀌어도 해시는 그대로였다. 게다가 envelope는 job이 만들어질
때가 아니라 마지막 reconcile이 저장한 스냅샷으로 만든다. 그래서 해시에 들어가지 않는 편집은 승인 철회
없이 워커에 그대로 전달될 수 있었다.

지금까지는 입력이 바뀐 열린 job을 취소한 뒤 같은 승인 id로 새 job을 바로 만들었다(2단계 scheduler 동작). 사람이
승인하지 않은 편집본이 승인 없이 실행되는 경로다.

## Decision

1. **정규 입력**(`src/issue/input-hash.ts`, 순수 로직): job 종류, 제목, 설명 전체, 파싱한 requirements
   전체(실행 전략·범위 계약 포함), plan-task의 `planVersion·workspaceId·taskId·parentKey·dependencies`.
   **제외**: 댓글(Router 보고 댓글이 철회를 일으키면 안 된다), 라벨(Router가 실패 라벨을 붙인다), 상태와
   Assignee(따로 검사하고 따로 안내한다), 계획 컨텍스트(댓글·하위 이슈 목록).
2. **정규화**: NFC, CRLF/CR→LF, 줄 끝 공백 제거, 앞뒤 빈 줄 제거. 그 밖의 차이(문구, 안쪽 빈 줄,
   들여쓰기)는 변경이다. 순서에 의미가 없는 dependencies·capabilities만 정렬한다. acceptance·verification
   등 계약 목록은 순서를 지킨다.
3. **형식**: `v2:` + sha256. payload에 `v: 2`를 넣는다. 접두가 없는 해시는 v1이다.
4. **기존 job**: 저장된 해시를 덮어쓰지 않는다. v1으로 찍힌 job은 닫힐 때까지 v1 규칙으로 비교한다.
   approval 스냅샷에 같은 입력의 v1 해시(`legacyInputHash`)를 함께 저장하므로 migration이 필요 없다.
   비교는 `inputHashMatches` 하나로 모아 reconcile, 활성 job 재확인(`checkJobAgainstJira`), Worker API의
   start·heartbeat·authorize(commit/validate/push), envelope 생성에서 쓴다. v2 해시로 바뀌는 곳은
   관리자 `jobs retry`의 restamp뿐이고, audit에 이전·새 해시를 남긴다.
5. **같은 승인으로 재실행 금지**: 승인 id는 그대로인데 입력이 바뀌면 열린 job을 기존 경로로
   취소하고(`cancelStaleJob`, 실행 중이면 `cancel_requested`), 그 승인을 `admin_holds`에
   actor `router:inputs-changed`로 보류한다. 관리자 cancel과 같은 장치다. 이슈를 요청 상태로 다시 옮겨
   새 승인 id가 생겨야 편집본이 실행된다.
6. **envelope 일치**: 저장된 승인 스냅샷이 job의 승인 id·해시와 맞지 않으면 envelope를 만들지 않는다
   (`EnvelopeUnavailableError`). reconcile이 스냅샷 저장과 취소를 동기적으로 함께 하므로 정상 흐름에서는
   생기지 않는 방어 장치다. 생기면 `jobs/next`가 그 요청을 실패시키고, job은 다음 reconcile에서 취소된다.

## Consequences

- 제목, 자유 텍스트, 실행 전략, 범위 계약을 고치면 실행 중인 작업도 멈춘다. 고친 내용을 실행하려면
  재승인(요청 상태로 다시 이동)이 필요하다. 대기(`waiting`)나 큐(`queued`)에 있던 job도 마찬가지다.
  2단계 scheduler의 "입력 변경 후 같은 승인으로 재생성" 동작을 이 결정이 대체한다.
- 댓글과 라벨 변경은 철회를 일으키지 않는다.
- 공백·줄바꿈만 다른 편집은 변경이 아니다. Jira 편집기가 줄 끝 공백이나 CRLF를 바꿔도 작업이 멈추지 않는다.
- 업그레이드 직전에 열려 있던 job은 v1 규칙으로 끝난다. 이 job들에 대해서는 v1의 사각지대(자유 텍스트,
  실행 전략)가 닫힐 때까지 남는다.
