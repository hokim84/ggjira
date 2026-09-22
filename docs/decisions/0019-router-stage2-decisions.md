# 0019. Router 2단계(입력·판단) 구현 판단 3가지

## Context

`docs/router-service-implementation-plan.md`의 2단계(Router 입력·판단)를 구현하면서, 계획
문서가 명시하지 않은 세 가지를 사용자와 확정했다. 세 판단 모두 3단계 이후 구현에 영향을
주므로 근거를 남긴다([`0018-router-centric-architecture.md`](./0018-router-centric-architecture.md)를
구체화하는 결정이며, 그 결정을 대체하지 않는다).

## Decision

1. **의존성 완료 판정.** v5 `WorkflowStatusSchema`(`src/router/config.ts`)에는
   `completionStatus`가 없다 — `requestStatus`/`planningStatus`/`inProgressStatus`/
   `reviewStatus`/`needsDecisionStatus`뿐이다. 의존성 이슈의 현재 상태가
   `requestStatus`·`planningStatus`·`inProgressStatus` 중 하나가 아니면(즉 `reviewStatus`
   도달 또는 그 이후 커스텀 상태 포함) 완료로 간주한다. `src/router/scheduler.ts`의
   `isDependencyUnresolved`가 이 규칙을 구현한다.

2. **웹훅 서버 도입 시점.** 계획 §4는 "2. Router 입력·판단"에 "웹훅 검증·중복 제거"를 넣고
   "3. Worker 통신·실행"에 pairing/session/long-polling을 넣지만, 실제 HTTP 서버(Fastify)를
   어느 단계에서 세울지는 명시하지 않았다. 2단계에서 Fastify를 도입하고 `POST /webhooks/jira`,
   `GET /health`만 최소로 세웠다(`src/router/server.ts`). 서명 검증(`verifyJiraWebhookSignature`)과
   이벤트 저장(`ingestJiraWebhookEvent`)은 `src/router/webhook.ts`의 순수 함수로 분리해
   서버 없이도 유닛 테스트했고, 라우트는 Fastify `inject`로 HTTP 레벨까지 별도 검증했다
   (`test/router-webhook.test.ts`, `test/router-server.test.ts`). 3단계는 같은 Fastify
   인스턴스에 `/api/v1/*` 워커 라우트를 추가하기만 하면 된다.

3. **가용 워커 입력.** 워커 등록(`workers` 테이블)·heartbeat는 3단계 범위라 아직 없다.
   `src/router/scheduler.ts`의 `reconcileCandidates`는 호출자가 구성해 넘기는
   `WorkerAvailability[]`(workerId, capabilities, repositoryIds, lastAssignedAt)를 순수
   입력으로 받는다. 테스트는 이 배열을 직접 구성한 Fake worker로 검증한다
   (계획 §4 "2. Router 입력·판단"의 "Fake worker로 작업 생성·배정·대기를 검증한다"와 일치).

## Consequences

- 의존성 완료 판정 규칙은 워크스페이스에 `Done` 같은 커스텀 최종 상태가 있어도 안전하게
  동작하지만, 의존성 이슈가 `reviewStatus`에서 다시 `inProgressStatus`로 되돌아가는(재작업)
  경우를 "미완료"로 재평가하지 못한다 — Router가 의존성 이슈 자체의 상태 변화를 감시하는
  것도 아니고, 그 이슈가 다시 대기 중인 이슈의 workspace 후보 스캔에 잡히는 것도 아니기
  때문이다. 실제로 이런 재작업 패턴이 나오면 별도 ADR로 재검토한다.
- 2단계는 Jira에 아무것도 쓰지 않는다(읽기만). `src/router/scheduler.ts`의 승인 철회 감지
  (`reverifyStaleOpenJobs`)는 "이번 패스의 후보 목록에 없다 = 승인 철회"로 단순화했는데, 이는
  Router 자신이 Jira 상태를 바꾸지 않는다는 전제에 의존한다. 4단계에서 Router가 실행 시작 시
  이슈를 `inProgressStatus`로 전이시키기 시작하면, 그 전이 자체가 이슈를 후보 목록에서 빠지게
  만들어 같은 감지 로직이 오작동한다 — 4단계 구현 시 이 가정을 재검토해야 한다.
- `RuleDecisionProvider`(`src/router/decision.ts`)는 `RouterConfig` 전체가 아니라
  `executionAgent` 설정 조각만 생성자로 받는다. 3단계에서 다른 `DecisionProvider`(예: LLM
  기반)를 추가할 때도 필요한 조각만 주입하는 패턴을 유지한다.
