# 0018. Router 중심 아키텍처로 전환

## Context

지금까지 각 머신이 독립적으로 Jira를 폴링하고, 이슈를 발견·claim·실행·보고했다
(v2~v4, ADR 0007/0008/0015/0016/0017). 여러 워커를 안정적으로 배분하려면 Jira 접근과
배정 판단을 한 곳(Router)에 모으고, 워커는 Router에만 연결해 작업을 받는 구조가 필요하다는
결론에 이르렀다. 전체 배경과 요구사항은 `docs/router-service-implementation-plan.md`에
있다(사용자와 확정한 사항: 단일 Router + SQLite, 웹훅 우선 + Router만 보완 조회, 워커는
Jira를 직접 조회하지 않음, 규칙 기반 배정 + `DecisionProvider` 확장점, 구형 실행 경로는
자동 이전 없이 제거).

## Decision

- Jira 접근(웹훅 수신, 인증, 조회, 쓰기)과 배정 판단(라우팅, 스케줄링, 임대)을
  `src/router/`로 모은다. 워커(`src/worker-runtime/`)는 Router가 발급한 작업만 실행하고
  Jira를 직접 호출하지 않는다.
- Router와 Worker가 주고받는 wire 계약(작업 envelope, 결과, `/api/v1/*` 요청/응답,
  라우팅 결과, provider 옵션)은 `src/contracts/`에 순수 Zod 스키마 + 타입으로 정의하고,
  Router/Worker 양쪽이 그대로 import한다.
- 작업/attempt의 상태 머신은 계약(`contracts/job-state.ts`, `contracts/attempt-state.ts`)에
  순수 함수로 정의하고, 저장소 계층(`src/router/db/`)이 SQLite 파샬 유니크 인덱스(이슈당
  비종결 작업 하나, 워커당 활성 attempt 하나)와 repository 함수(`jobs.ts`, `attempts.ts`)로
  두 번 — 스키마 레벨과 애플리케이션 레벨 — 집행한다.
- 설정은 `configVersion: 5`로 분리하고, v2~v4 실행 경로·설정 호환은 유지하지 않는다(자동
  이전 도구 없음 — 계획 §1).
- 구현은 계획 문서 §4 "구현 단계"의 5단계를 순서대로 따른다. 각 단계의 완료 여부는
  `docs/router-service-implementation-plan.md` 상단의 "구현 상태" 절에 기록해 다른
  세션/모델이 이어받을 수 있게 한다.

## Consequences

- Router가 단일 장애점이 된다 — 계획 §5 "운영 전환"에서 관측 항목(큐 대기 시간, 워커 연결
  상태 등)을 정의해 이를 인지하고 대응한다.
- 워커가 Jira를 직접 보지 않으므로, 새로운 실행 판단 로직(예: LLM 기반 `DecisionProvider`)을
  추가해도 워커 코드는 바뀌지 않는다 — Router의 라우팅 계층만 바뀐다.
- 기존 v2~v4 poller/claim/JobStore 경로는 계획 §4의 유지·리팩터링·삭제 경계에 따라
  5단계에서 제거된다. 그 전까지는 두 경로가 저장소에 공존한다(`src/job/`, `src/poller/`
  등은 아직 손대지 않음).
- 계약을 `src/contracts/`에 분리한 대가로, Router/Worker 양쪽에서 필드를 바꿀 때마다
  두 프로세스가 서로 다른 배포본으로 돌 수 있다는 점을 고려해야 한다 — `PROTOCOL_VERSION`
  불일치를 실행 전에 명시적으로 거부하는 것이 이 문제의 유일한 안전장치다(계약 §3).
