# 0001: Webhook 대신 JQL Polling으로 시작

## Context

`writing-block.md`에 합의된 기본 구조는 `Human → Jira → Webhook → GGJIRA → Job → Worker → 결과 → Jira`다.
그러나 개발/운영 환경은 로컬 머신이며 외부에서 인바운드 접근이 불가능하다. Webhook을 받으려면
ngrok/cloudflared 같은 터널을 상시 운영해야 하는데, 이는 MVP가 검증하려는 핵심 가치
(Jira ↔ Worker 실행 경로)와 무관한 인프라 비용이다.

## Decision

MVP는 Jira 이벤트 수신을 JQL Polling으로 구현한다. 수신 로직은 `src/poller/`에 격리하고,
"후보 이슈 목록을 반환하는" 하나의 경계(`IssueSource`)만 유지한다.

## Consequences

- 놓친 이벤트 복구가 자연스럽다 (다음 폴링에서 다시 조회됨). 재시작에도 강하다.
- 실시간성은 폴링 주기(`polling.intervalMs`, 기본 60초)만큼 지연된다.
- Post-MVP에 Webhook 수신 서버(Hono)를 추가할 때 Job 이후 흐름(claim → worker → reporter)은
  변경할 필요가 없다. Polling은 이벤트 유실 복구용으로 계속 유지한다.
- 이중 처리 방지 로직(claim, `state.json`)이 Polling 환경에서도 필요하며, 이는 Webhook으로
  전환해도 그대로 재사용된다.
