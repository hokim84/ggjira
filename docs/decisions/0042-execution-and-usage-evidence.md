# 0042. 실행·사용량 증거 보존

## Context

워커는 provider 호출의 플랜 사용량(5시간·주간 창의 사용률, ADR 0028)만 Router에 보냈다. 호출 하나하나가 어느
모델로 얼마나 썼는지, 실패·취소된 호출이 무엇을 썼는지, 같은 요구사항의 재시도·재작업에 얼마가 들었는지는
남지 않았다. Claude Code는 result 이벤트에 토큰과 비용을, Codex는 `turn.completed`에 턴별 토큰을 주지만 버려졌다.
M4 백로그 M4-12는 이후 부채·변경 저항·비용 분석(F05)을 위해 원래 요구사항, 호출 종류, provider·모델, 호출
식별자, 성공/실패/재개·재작업, 제공되는 토큰을 연결해 남기되, 미제공은 0이 아닌 "미확인"으로, 재전송은 한 번만,
원인은 섣불리 판정하지 않고, 추가 LLM 호출 없이 하라고 요구한다.

## Decision

1. **provider 파싱**(`src/worker/call-usage.ts`, 순수 함수): Claude Code는 `system/init`의 `model`과 result
   이벤트의 `usage`(`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`)·
   `total_cost_usd`를 읽는다. 캐시 읽기는 입력에 포함되지 않는다(`cacheReadIncludedInInput: false`). Codex는
   `thread.started`의 `thread_id`와 `turn.completed`의 `usage`(`input_tokens`, `cached_input_tokens`,
   `output_tokens`)를 턴마다 더한다. 캐시 입력은 입력의 일부다(`true`). 스트림에 없는 값은 넣지 않는다.
2. **결과 계약**: `JobResult.execution {providerId, providerType, model, modelSource(reported|configured),
   callId, exitReason, durationMs, numTurns, usage?}`(선택 필드, 프로토콜 2 유지). 워커가 provider를 실제로 부른
   모든 결과(실패·시간 초과·취소·범위 이탈 포함)에 붙는다. 호출 전에 거절한 결과(저장소·provider 미설정)에는 없다.
   모델은 CLI가 보고하면 `reported`, 아니면 워커 설정값을 `configured`로 적는다.
3. **Router 저장**(migration 13, `execution_records`): 저장된 결과마다 한 행(결과 id 키, 재전송·재시작에도 한 번).
   적용되지 않은 늦은 결과도 `applied = 0`으로 남긴다. 연결: job·attempt·이슈·원래 요구사항(`parent_issue_key`,
   승인 스냅샷의 상위 이슈)·job 종류(계획/구현)·승인 id. 실행 유형: 같은 job의 두 번째 이후 attempt는 `retry`(관리자
   재시도), 같은 이슈의 이전 job이 있으면 `rework`(새 승인), 아니면 `initial`. 토큰 열은 미보고면 NULL이고
   `usage_reported`가 0이다.
4. **원인 분류**: Router가 스스로 알 수 있는 것만 적고 `cause_source = router`로 표시한다. 승인 뒤 요청이 고쳐져
   취소됨 → `requirements_change`, provider 시간 초과·비정상 종료·시작 실패·작업 공간 준비 실패 → `environment`.
   성공·계획은 `none`, 결정·범위 이탈 중단과 다른 이유의 취소는 `not_applicable`, 나머지 실패는 `unknown`이다.
   Router는 실패를 코드 구조 문제로 판정하지 않는다. 재시도 횟수나 소요 시간으로 부채를 판정하지 않는다.
5. **조회·내보내기**: `GET /api/v1/admin/executions?issue=&children=true`, `ggjira router usage [--issue K]
   [--children] [--json]`. 합계는 보고된 값만 더하고 미보고 건수를 따로 준다. 캐시 읽기는 "입력 안에 포함"과
   "입력과 별도"를 나눠 합산해 이중 계산을 막는다. 대시보드·요금 환산·비교 분석은 F05다.
6. 보고·상태 갱신·사용량 기록·위험 규칙 검사·주의 항목 분류 어디에도 LLM 호출을 추가하지 않는다. 기존 Jev 관찰
   평가(ADR 0030)는 배정 게이트로 쓰지 않으며 이 기록과 섞지 않는다.

## Consequences

- 이전 워커의 결과와 사용량을 보고하지 않는 CLI 버전의 결과는 "미보고"로 남는다. 과거 수치를 소급해 만들지 않는다.
- 같은 호출을 여러 결과가 공유하지 않으므로 결과 단위 합계가 호출 단위 합계와 같다.
- Codex의 모델 이름은 `exec --json`이 알려 주지 않아 설정값(`configured`)이다.
- DB migration 13이 추가된다.
