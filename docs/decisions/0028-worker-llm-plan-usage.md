# 0028. 워커가 LLM 플랜 사용량을 연결 시와 작업 직후에 Router로 보고한다

## Context

워커는 Claude Code나 Codex를 운영자의 구독 플랜으로 실행한다. 5시간·주간 한도에 닿으면 작업이
실패하는데, Router 웹 UI에서는 어느 워커가 한도에 가까운지 볼 수 없었다. 워커는 Jira를 직접 부르지 않고
Router에만 연결한다(ADR 0018). 사용량을 주기적으로 조회하면 그만큼 CLI를 더 실행해야 하고, Claude
Code는 모델 호출 없이 사용량만 알려 주는 명령이 없다.

CLI에서 읽을 수 있는 것(Claude Code 2.1.x, Codex 0.158 기준):
- Claude Code `-p --output-format stream-json`은 `rate_limit_event`를 내보낸다.
  `rate_limit_info.unifiedWindows.{five_hour,seven_day}.utilization`(0–1 비율)과 `resetsAt`(epoch 초),
  `status`(`allowed`/`allowed_warning`/`rejected`)가 있다. 플랜 종류는 `claude auth status`의
  `subscriptionType`에 있다. API 키 과금에서는 이 이벤트가 오지 않는다.
- Codex `exec --json`에는 한도 정보가 없다. `codex app-server`의 JSON-RPC `account/rateLimits/read`는
  모델 호출 없이 `primary`/`secondary`(`usedPercent` 0–100, `windowDurationMins`, `resetsAt`)와
  `planType`을 돌려준다.

## Decision

1. **시점은 두 번뿐이다.** 워커 프로세스가 처음 연결할 때 한 번(`source: "probe"`), 그리고 작업을 마치고
   결과를 제출한 직후(`source: "job"`). 타이머로 조회하지 않는다. 재연결(stale session)은 다시 probe하지
   않는다.
2. **provider가 읽는다.** `WorkerProvider.readUsage()`(연결 시)와 `WorkerRunHooks.onUsage`(작업 중).
   - Claude Code: 작업 중 `rate_limit_event`를 그대로 쓴다. 연결 시에는 `haiku`로 "Reply with OK."를
     도구 없이 한 번 실행해 이벤트를 받는다(운영자가 이 비용을 허용했다). 플랜은 `claude auth status`.
   - Codex: 연결 시와 작업 직후 모두 짧게 띄운 `codex app-server`에 `account/rateLimits/read`를 묻는다.
   - 창 이름은 `five_hour`/`seven_day`로 맞춘다. Codex는 300분·10080분 창을 이 이름으로 부른다.
3. **전송은 새 엔드포인트 `POST /api/v1/workers/usage`**(`{sessionId, workerId, usage: ProviderUsage[]}`)다.
   다른 워커 API처럼 token과 현재 세션을 검사한다. 추가만 한 것이라 `PROTOCOL_VERSION`은 그대로다. 이전
   Router는 404를 주고, 워커는 경고 로그만 남긴다. 보고는 best-effort이며 spool하지 않는다.
4. **Router는 워커·provider별 마지막 값만 SQLite `worker_provider_usage`에 저장한다**(migration 6).
   이력은 없다. 사용량은 배정에 쓰지 않고 관리 API `GET /api/v1/admin/workers`의 `providerUsage`와 웹 UI
   워커 화면에만 보인다.

## Consequences

- 웹 UI 워커 카드에 provider별 5시간·주간 사용률 막대, 리셋까지 남은 시간, 관측 시점("연결 시"/"작업 후")이
  보인다. 값은 마지막 보고 시점 기준이라 워커가 오래 쉬면 실제보다 높게 보일 수 있다.
- Claude Code 워커는 시작할 때마다 아주 작은 haiku 호출 한 번을 쓴다.
- CLI 출력 형식(`rate_limit_event`, app-server 메서드)은 공개 계약이 아니다. 형식이 바뀌면 창이 비고
  `error`가 표시될 뿐 작업 실행에는 영향이 없다.
- 한도 기반 자동 배정 회피는 하지 않았다. 필요해지면 저장된 값을 스케줄러가 읽도록 새 ADR로 정한다.
