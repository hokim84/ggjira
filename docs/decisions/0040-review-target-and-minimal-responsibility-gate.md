# 0040. 검토 대상 고정과 최소 책임 게이트

## Context

구현 결과는 job의 `succeeded`와 Jira 검토 상태로만 남았다. 사람이 무엇을 검토했는지(어느 시도·승인·커밋)는
기록되지 않았고, 워커는 base/head 커밋을 보고하지 않았다. PR이 머지되면 Router는 그 PR이 어느 결과에서
나왔는지만 보고 이슈를 완료로 옮겼다(ADR 0027). 그 사이 PR에 커밋이 더해졌거나 같은 이슈의 새 시도가
결과를 냈어도 구별하지 않았다. 또 acceptance가 `not_verified`인 결과, 커밋이 없는 결과, 마이그레이션·공개
계약·권한 정책처럼 사람이 따로 봐야 하는 영역을 바꾼 결과도 일반 성공과 똑같이 보고됐다(ADR 0036
Consequences). M4 백로그 M4-11은 결과를 issue·job/attempt·승인/입력 해시·base/head에 고정하고, 고위험 판정
근거를 남기고, 과거 확인이 새 결과의 승인으로 재사용되지 않게 하라고 요구한다. 검토 화면 자체는 F01로 미룬다.

## Decision

1. **워커 보고**: 구현 결과에 `git {repository: git|none, baseBranch, baseSha, headSha, committed}`를 싣는다.
   `baseSha`는 worktree를 만든 직후의 HEAD, `headSha`는 커밋한 뒤의 HEAD이며 base와 다를 때만 넣는다.
   커밋하지 않은 실행(결정 대기·범위 이탈·검증 실패·변경 없음)에는 head가 없다. head를 만들거나 추정하지 않는다.
   git이 아닌 작업 공간은 `repository: "none"`이다. 선택 필드이므로 프로토콜 버전은 2 그대로이고, 이전
   워커의 결과는 `git`이 없어 "미확인"으로 읽는다.
2. **에이전트의 의미상 위험**: 구현 보고에 `risks[{area, description}]`을 추가한다. 같은 구현 호출의 최종
   구조화 응답에서 받으며 추가 LLM 호출은 없다. 범위 안의 변경이라도 공개 API·wire 계약, 데이터
   마이그레이션·스키마, 권한·보안 정책을 바꿨으면 적게 한다.
3. **고위험 규칙**: workspace 설정 `review.highRiskPaths[{name, paths[]}]`(선택). glob은 `allowedPaths`와 같다.
   워커가 보고한 변경 경로(`scopeCheck.changedPaths`: 추가·수정·삭제·rename, rename은 양쪽)를 규칙과 대조한다.
   규칙 내용의 해시 12자리를 "설정 버전"으로 근거와 함께 저장한다. 판정은 `high`(규칙 일치 또는 에이전트 위험
   보고), `not_matched`(규칙이 있고 경로를 알며 일치 없음), `unknown`(규칙 없음, 또는 경로 미보고·git 아님)이다.
   `not_matched`를 저위험이라 부르지 않는다. 별도 위험 평가 LLM 호출은 없다.
4. **검토 분류**(`src/router/review-gate.ts`, 순수 함수): 적용된 결과마다 `immediate`(개별 검토 필요) 또는
   `standard`(일반 검토 대기)를 정한다. `immediate` 사유는 실패·시간 초과, 결정 필요, 범위 이탈, 고위험,
   `not_verified` acceptance, 커밋 없음, 커밋 미보고다. 계획 결과는 결정 필요면 `immediate`, 아니면 `standard`다.
   취소된 결과는 검토 대상이 아니다.
5. **검토 대상 저장**(migration 11, `review_targets`): 결과 id를 키로 issue·job·attempt·종류·승인 id·입력
   해시·결과 상태·base/head·커밋 상태·분류·판정 전체(JSON)를 결과 저장과 같은 트랜잭션에서 남긴다. 같은
   이슈의 새 결과가 생기면 이전 행은 `superseded_by`로 이력이 되고 최신으로 표시하지 않는다. 결과 재전송은
   새 행을 만들지 않는다.
6. **사람 행동 기록**(`review_records`): Router가 본 사람의 행동을 대상과 함께 남긴다. 지금은 GitHub PR 머지·
   닫힘이다. actor(`github:<login>`), 인증(`github`), 그 행동이 가리킨 head, 대상과의 관계를 기록한다:
   `matched`(같은 head, 최신 대상), `stale`(head가 다르거나 대상이 대체됨), `unverified`(어느 한쪽 head를
   모름), `no_target`(대상 기록 없음).
7. **머지 → 완료**(ADR 0027 보완): `matched`와 `unverified`만 이슈를 완료로 옮긴다. `unverified`는 이전 워커와의
   호환을 위해 기존 동작을 유지하되 댓글에 "head 미비교"를 적는다. `stale`·`no_target`이면 옮기지 않고, 이유와
   "직접 확인하고 옮기라"를 댓글로 남긴다. 고위험 결과의 머지에는 "GGJIRA는 머지를 막지 않으며 필수 리뷰는
   저장소의 branch protection만 강제한다"를 적는다. 앱 표시로 머지 차단을 주장하지 않는다.
8. **보고**: 성공 댓글은 변화 → 분류와 사유 → 다음 행동(PR 링크) → 검토 커밋(head/base) → 고위험 근거 →
   acceptance별 판정 → 요약·변경·검증 → 서명(job·attempt·승인·입력 해시) 순서다.
9. **조회**: `GET /api/v1/admin/issues/:key/reviews`, `ggjira router issue reviews <KEY>`. 읽기 전용이다.
   관리 token으로 검토를 "확인"하는 쓰기 경로는 만들지 않는다. 공유 token의 표시가 사람 승인이나 완료를
   만들지 않게 하기 위해서다. 기존 `authorize`는 실행 권한 확인으로만 쓴다.

## Consequences

- 같은 이슈에서 재작업이 결과를 내면, 이전 시도의 PR을 머지해도 이슈가 완료로 가지 않는다. 사람이 무엇이
  머지됐는지 보고 직접 옮긴다.
- 리뷰 중 PR에 커밋을 더하고 머지하면 완료로 자동 이동하지 않는다. 의도한 흐름이라면 사람이 옮긴다.
- `highRiskPaths`가 없으면 모든 결과의 고위험 판정이 `unknown`이다. 분류는 `standard`로 둔다(설정 부족을
  사유로 모든 결과를 개별 검토로 돌리면 분류가 의미를 잃는다). 댓글과 조회에 "미확인"으로 보인다.
- 의미상 위험은 에이전트 자기 보고에 의존한다. 경로 규칙은 의미를 보지 못하고, 자기 보고는 빠질 수 있다.
- 커밋 없는 결과는 커밋 기반 최신성 검증을 할 수 없음을 댓글과 판정에 적고 개별 검토로 보낸다.
- DB migration 11이 추가된다(append-only). 이전 Router 바이너리는 새 테이블을 읽지 않으므로 DB를 되돌리지 않고도
  코드만 되돌릴 수 있다. 그 경우 머지 → 완료는 ADR 0027 동작으로 돌아간다.
- 검토 대기 화면·묶음 검토·항목별 판단은 F01·F02다.
