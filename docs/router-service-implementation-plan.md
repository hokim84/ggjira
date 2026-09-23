# GGJIRA Router 중심 아키텍처 전환 구현 계획

문서 경로: `docs/router-service-implementation-plan.md`  
분석 기준: 커밋 `6c9c8ca`, 2026-09-22 작업 트리  
문서 상태: 사용자와 확정한 구현 인계용 계획. 아래 "구현 상태"에 단계별 진행 상황을 기록한다.
설계 결정 배경은 [`decisions/0018-router-centric-architecture.md`](./decisions/0018-router-centric-architecture.md).

## 구현 상태

이 절은 다른 세션/다른 AI 모델이 이어받을 수 있도록 단계별 완료 여부를 기록한다. §4
"구현 단계"의 번호와 대응한다.

| 단계 | 상태 | 비고 |
|---|---|---|
| 1. 계약·설정·저장소 | ✅ 완료 (2026-09-22) | 아래 상세 참고 |
| 2. Router 입력·판단 | ✅ 완료 (2026-09-23) | 아래 상세 참고 |
| 3. Worker 통신·실행 | ✅ 완료 (2026-09-23) | 아래 상세 참고 |
| 4. PM·보고·복구 | ✅ 완료 (2026-09-23) | 아래 상세 참고 |
| 5. 운영 기능·기존 구조 제거 | ✅ 구현 완료 (2026-09-23) | 아래 상세 참고. 실제 배포·외부 연동은 운영 단계 |

### 5단계: 운영 기능·기존 구조 제거 — 구현 완료

`docs/decisions/0022-router-stage5-operations-and-legacy-removal.md`에 판단을 기록했다. 여기에는
구형 코드 삭제(사용자 확인), CLI 구성, 관리 API 경유, `jobs cancel`의 승인 hold, disable·revoke 범위,
`router serve` 루프 구성, loopback 외 HTTP 금지, 백업 방식, Compose 구성이 들어 있다. 이 ADR은 0001·
0004·0007·0008·0011·0012와 0013·0014 일부를 대체한다.

구현 파일:

- `src/router/daemon.ts` — `router serve`. HTTP 서버와 sync(부팅·60초·웹훅)·verify·reports·leases
  루프다.
- `src/router/admin-service.ts`·`server.ts` — `/api/v1/admin/*`(status, workers, jobs, reports,
  reconcile, backup), `audit_log` actor 기록.
- `src/router/db/holds.ts`·migration 4(`admin_holds`), `db/jobs.ts`의 `listJobs`(keyset 페이지네이션)·
  통계, `db/attempts.ts`의 `listAttemptsForJob`.
- `src/router/check.ts` — `router check`(인증, 상태, 하위 이슈 타입, 실행-Agent 필드, 샘플 이슈 전이).
- `src/router/cli.ts`·`admin-client.ts`, `src/worker-runtime/cli.ts`·`ops.ts`, `src/cli*.ts` — CLI.
  구형 명령은 대체 명령을 안내하고 종료 코드 2로 끝난다.
- `src/worker-runtime/config.ts` — `dataDir`(spool·worktree 위치), `routerUrl` HTTPS 규칙.
- `Dockerfile`(deps/test/build/runtime), `docker-compose.yml`(router + Caddy), `docker-compose.test.yml`,
  `deploy/`(Caddyfile, 예시 설정·env), `worker.config.example.json`.
- 삭제: `src/agent`, `src/implement/executor.ts`, `src/job`, `src/poller`, `src/profile`, `src/reporter`,
  `src/setup`, `src/pm/apply.ts`·`executor.ts`, `src/config.ts`, v4 설정 예시·fixture, 관련 테스트 22개.
  공유 로직은 `src/issue/`(capability·requirements·description)와 `src/worker/validate.ts`로 옮겼다.
  PM 계획 스키마에서 Agent Profile 필드를 뺐다.
- 문서: README, `docs/architecture.md`(v5로 재작성), `docs/runbook.md`(§16 배포, §17 백업·복원,
  §18 워커 운영, §19 v4 전환. v4 절 삭제), `CLAUDE.md`. Node 24(`engines`, `.nvmrc`, CI).

테스트:

- `test/router-admin-api.test.ts` — 인증, disable/enable, revoke(임대 재대기·실행 취소), 페이지네이션,
  cancel hold와 재승인, resolve/retry, 보고 재시도(워커 재실행 없음), 백업, status.
- `test/router-daemon.test.ts` — 웹훅 기반 sync, 실패 backoff, 직렬 lane, 보고 루프, 백업 복원 후
  웹훅·임대·보고 복구.
- `test/router-integration.test.ts` — 실제 loopback HTTP 위의 Router 1대와 Fake 워커 2대. 관리 API로
  pairing하고, 이슈 3건이 각 1회 실행되어 검토 상태가 되는지 확인한다.
- `test/cli.test.ts`, `test/router-check.test.ts`, `test/worker-runtime-ops.test.ts`(실제 git
  worktree prune), `test/example-configs.test.ts`.

검증(2026-09-23):

- [x] `npm run typecheck`·`lint`·`format:check`·`build` 통과.
- [x] 테스트: 파일마다 별도 프로세스로 실행했다(runbook §13). 40개 파일, 324건 중 316 passed / 8 failed.
  실패 8건은 기존 `spawn EFTYPE`(`.sh` fixture, Windows 전용)뿐이다.
- [x] 빌드한 `node dist/cli.js`로 `router serve`를 실제 프로세스로 띄워 확인했다(Jira 주소는 일부러 연결
  불가). 확인 항목: `/health`, `router status`, `workers pair` → `worker setup` → `worker check`,
  `workers list`, 서명된 웹훅 202 / 잘못된 서명 401, `router backup`, Jira 실패 시 sync backoff.
  구형 명령 `run`은 종료 코드 2로 안내한다.
- [ ] `docker compose -f docker-compose.test.yml run --rm --build check`(Linux 전체 check): 이 머신에서
  Docker 엔진이 꺼져 있어 실행하지 못했다.
- [ ] 운영 단계: 실제 배포, Jira 웹훅, AI CLI 로그인, 여러 머신(runbook §16~§19).

**아직 하지 않은 것(운영 단계)**: 실제 서버 배포, Jira 웹훅 연결, AI CLI 로그인, 실제 여러 머신
구성. runbook §16~§19 순서로 진행한다. Compose 기반 Linux 검증(`docker-compose.test.yml`)은 Docker
엔진이 켜진 환경에서 돌려야 한다.

### 4단계: PM·보고·복구 — 완료

`docs/decisions/0021-router-stage4-reporting-recovery.md`에 판단을 기록했다. 사용자가 확정한 두 가지는
실패 시 inProgressStatus 유지 + 라벨, needsDecisionStatus가 없을 때 reviewStatus다. 나머지는
보고 저널 배치 구조, 쓰기 전 재조회 규칙, 생성 불명확 시 보류, 생성 마커 위치, 부모 계획 버전
검사, Jira 재조회 기반 승인 확인, recovery 해제·재시도 경로다.

구현 파일:

- `src/router/db/schema.ts`·`migrate.ts` — migration 3: `jira_writes`를 `report_steps`(배치·순서·
  상태 `pending/applied/skipped/failed/uncertain/recovery_required`)로 교체.
- `src/router/db/report-steps.ts`·`audit.ts` — 저널 저장·조회·재대기, 감사 기록.
- `src/router/report-journal.ts` — 결과·시작·중단 확인을 Jira 단계 목록으로 바꾸는 순수 로직.
  계획 검증이 여기서 이루어진다.
- `src/router/report-processor.ts` — `processReportJournal`. 단계별로 Jira를 다시 읽은 뒤 쓴다.
- `src/router/recovery.ts` — `resolveRecoveryJob`, `retryJob`(Jira 승인 재확인 후 새 attempt),
  `retryReportBatch`.
- `src/router/issue-check.ts` — 승인 읽기(부모 계획 버전 검사 포함), planning context 수집,
  `checkJobAgainstJira`. `src/router/scheduler.ts`의 `verifyActiveJobs`와 후보 밖 job 재확인이 쓴다.
- `src/router/worker-service.ts` — `start`·`submitResult` 트랜잭션에서 저널 생성, 늦은 결과를
  워커 중단 확인으로 처리. `src/router/envelope.ts` — planning context·PM system prompt.
- `src/worker-runtime/planning.ts` — planning envelope 실행(읽기 전용, 계획 반환).
- `src/pm/plan-render.ts`·`decision-render.ts` — 계획·결정 요청 렌더링을 v4와 공유하는 순수 모듈.
  `src/pm/prompt.ts`의 `buildPlanningPrompt`는 구조적 입력을 받는다.
- `src/router/config.ts` — `planning.subtaskIssueType`/`maxTasksPerPlan`, `reporting.failureLabel`.

**의도적으로 아직 없는 것**: `processReportJournal`·`verifyActiveJobs`·`expireLeases`·
`reconcileCandidates`를 주기적으로 부르는 `router serve`, recovery 함수의 관리자 HTTP API·CLI,
`worker run` 진입점(5단계). PM 출력 스키마의 `assigneeAgentId`·Agent Profile 필드는 Router가
무시하며, 제거는 구형 경로 삭제와 함께 5단계에서 한다.

테스트: `test/router-reporting.test.ts`가 다음을 검증한다.
- 시작 전이, 성공·실패 보고, 사람이 바꾼 상태 보존, 불명확한 댓글의 재조회 확정, 명확한 거부 →
  관리자 재시도
- planning context envelope, 계획 적용 전체와 재실행 멱등, 계획 버전 게이트, 불명확한 생성 보류
  → 재시도, 결정 요청, 순환 계획 거부
- Router 자신의 전이·댓글을 철회로 보지 않음, 사람이 옮기면 취소 요청, 조회 실패 시 유지
- 관리자 resolve, retry, 재시도 거부, 재승인 시 새 job

`test/worker-runtime-runner.test.ts`는 planning 실행 end-to-end를, `test/router-worker-api.test.ts`는
늦은 결과의 중단 확인 처리를 검증한다.

검증: typecheck·lint·format 통과. 이 Windows 환경에서는 전체 vitest 실행이 간헐적으로 멈춘다(runbook
§13, HEAD에서도 재현). 그래서 테스트 파일마다 별도 프로세스로 실행했다. 결과는 480건 중 472 passed /
8 failed이고, 실패는 기존 `spawn EFTYPE` 8건뿐이다.

**5단계를 시작하는 세션/모델에게**(완료됨, 5단계 절 참고): `router serve`는 `reconcileCandidates`(60초),
`verifyActiveJobs`(`reconciliation.activeJobPollIntervalMs`), `processReportJournal`, `expireLeases`를
주기적으로 호출한다. 관리자 API는 `src/router/recovery.ts`와 `listBlockedReportSteps`를 감싸면 된다.

### 3단계: Worker 통신·실행 — 완료

`docs/decisions/0020-router-stage3-worker-protocol.md`에 계획만으로 정해지지 않았던 판단
(pairing code가 identity를 정함, 최신 세션만 유효, `cancel_requested → recovery_required`,
결과 적용 규칙, 재시작 시 재실행 금지, envelope에는 id만, planning 실행 보류, 프로세스 트리
종료, migration 2)을 기록했다.

구현 파일 (Router):

- `src/router/db/schema.ts`·`migrate.ts` — migration 2(`WORKER_PROTOCOL_STATEMENTS`, 추가만):
  pairing code의 `worker_id`, 워커 보고 가용성·heartbeat·현재 세션, `worker_sessions`,
  attempt의 `session_id`/`request_id`(워커별 유니크), `jobs.input_hash`, `results.applied`.
- `src/router/db/pairing.ts`·`workers.ts`·`results.ts` — pairing code 발급/소비(10분, 1회),
  워커 등록(token SHA-256 hash만 저장)·세션·heartbeat, 결과 저장(동일 `resultId` 동일 내용은
  `duplicate`, 다른 내용은 `ResultConflictError`).
- `src/router/db/attempts.ts`·`jobs.ts` — requestId 바인딩, 임대 갱신, 만료 조회, 결과 id 기록.
- `src/router/availability.ts` — `buildWorkerAvailability`: ADR 0019 §3이 남겨둔 어댑터.
  heartbeat가 15초 이내이고 활성 세션·설정상 enabled인 워커만 배정 대상이다.
- `src/router/leases.ts` — `expireLeases`: `leased` 만료는 취소 후 job 재대기, `running`/
  `cancel_requested` 만료는 `recovery_required`.
- `src/router/envelope.ts` — job/attempt → `JobEnvelope`(`providerId`·`timeoutMs`는 설정에서).
- `src/router/worker-service.ts` — `/api/v1/*`의 SQLite 측 로직. 모든 변경 요청이
  identity → session → attempt 소유권 → lease token → 임대 신선도를 한 트랜잭션에서 검증한다.
  `jobs/next`는 25초 long polling, 같은 `requestId` 재전송은 같은 예약을 반환한다.
- `src/router/server.ts` — 워커 라우트 8개와 `POST /api/v1/admin/pairing-codes`,
  `WorkerApiError` → HTTP 상태(400/401/403/404/409/426) 매핑.
- `src/router/scheduler.ts` — 배정 시 `input_hash` 고정, 배정 로직을 `assignQueuedJobs`로
  분리해 `jobs/next`가 재사용.
- `src/router/config.ts` — `workers[].providerId`, `execution.timeoutMs` 추가.

구현 파일 (Worker):

- `src/worker-runtime/client.ts` — Router HTTP 클라이언트(`RouterApiError`).
- `src/worker-runtime/spool.ts` — 결과를 임시 파일 → fsync → rename으로 원자 저장, ack 시 삭제.
- `src/worker-runtime/executor.ts` — implementation envelope 실행: worktree → provider →
  (`authorize`) 커밋 → (`authorize`) 검증. 기존 `src/worker/`·`src/implement/validate.ts`를
  재사용하고 Jira를 import하지 않는다.
- `src/worker-runtime/runner.ts` — 세션 → spool 재전송 → 고아 attempt 보고 → 루프 { heartbeat →
  `jobs/next` → start → 실행(5초 job heartbeat, 20초 임대 상실 watchdog) → spool → 제출 → ack }.
- `src/worker/spawn.ts` — `killProcessTree`(Windows `taskkill /T`, POSIX 프로세스 그룹).
  `src/worker/factory.ts` — `createProviderFromConfig`(v5 provider 설정용).

**의도적으로 아직 없는 것**: planning job 실행과 PM 계획 적용, 결과의 Jira 반영 저널과
재시도, `recovery_required` 관리자 해제(4단계). `router serve`/`worker run` 등 CLI 진입점,
주기적 `expireLeases`·`reconcileCandidates` 타이머, Docker Compose(5단계). 현재 Router와
워커는 코드(테스트 하네스)로만 조립된다.

테스트: `test/router-worker-api.test.ts`(Fastify `inject`로 pairing·세션·long polling·
requestId 재전송·403/409·결과 중복/충돌·늦은 결과), `test/router-leases.test.ts`,
`test/router-availability.test.ts`, `test/worker-runtime-{client,spool,runner,no-jira}.test.ts`
(runner는 실제 Router 서비스와 인메모리 SQLite를 붙인 `test/helpers/router-harness.ts`로
검증), `test/worker-spawn-tree-kill.test.ts`(손자 프로세스까지 종료되는지 실제 확인).

검증: `npm run check` — typecheck·lint·format 통과, 테스트 461건 중 453 passed / 8 failed.
실패 8건은 1·2단계와 같은 기존 `spawn EFTYPE`(`.sh` fixture, runbook §13)이며, HEAD의
`src/worker/spawn.ts`로 되돌려 돌려도 같은 8건이 실패함을 확인했다.

**4단계를 시작하는 세션/모델에게**(완료됨, 4단계 절 참고): 결과는 `WorkerService.submitResult`에서 `results`에
저장된다. Jira 반영 작업 생성은 같은 트랜잭션 안(`applyResult` 옆)에 추가한다. planning 실행은
`src/worker-runtime/executor.ts`의 `kind !== "implementation"` 분기를 채우면 되고, envelope의
`planningContext`는 `src/router/envelope.ts`에서 채운다. ADR 0019 Consequences의 "승인 철회
감지가 Router 자신의 Jira 전이에 오작동" 문제도 4단계에서 해결해야 한다.

### 2단계: Router 입력·판단 — 완료

`docs/decisions/0019-router-stage2-decisions.md`에 이번에 확정한 세 가지 설계 판단(의존성
완료 기준, 웹훅 서버 도입 시점, 가용 워커 입력 방식)을 기록했다.

구현 파일:

- `src/jira/types.ts`·`gateway.ts`·`client.ts`·`fake.ts` — `getIssueChangelog`(페이지네이션
  전체 취합) 추가. `FakeJiraGateway`는 `transitionIssue`/`transitionIssueToStatus`가 상태를
  바꿀 때 changelog 항목을 자동 기록하고, `seedChangelogEntry`로 직접 주입도 가능. `project in
  (...)` JQL 절도 추가(기존엔 `project = ...`만 지원).
- `src/router/db/events.ts` — 웹훅 이벤트 repository. `(site_id, webhook_delivery_id)` 유니크
  위반을 `DuplicateEventError`로 표면화.
- `src/router/webhook.ts` — `verifyJiraWebhookSignature`(HMAC-SHA256, 상수 시간 비교),
  `ingestJiraWebhookEvent`(중복 제거, `"accepted" | "duplicate"` 반환).
- `src/router/server.ts` — 최소 Fastify 앱. `POST /webhooks/jira`, `GET /health`만 있음.
  3단계가 `/api/v1/*` 워커 라우트를 같은 인스턴스에 추가한다. `package.json`에 `fastify`
  의존성 추가.
- `src/router/db/approvals.ts` — `approvals` 테이블 repository(issue당 1행, upsert).
- `src/router/approval.ts` — `computeApprovalId`(changelog에서 `requestStatus`로 진입한
  가장 최근 항목의 id, 없으면 `created:{key}` 센티널), `computeInputHash`(설명·capability·
  의존성·planVersion을 SHA-256).
- `src/router/candidates.ts` — workspace별 JQL(`project in (...) AND status in (...)`)과
  GGJIRA meta 라벨 제외 필터.
- `src/router/decision.ts` — `RouteContext`, `DecisionProvider` 인터페이스,
  `RuleDecisionProvider`(§2 "배정 규칙" 1-5를 순서대로 적용하는 유일한 구현체). 스케줄러가
  의존성 해소 여부를 미리 계산해 넘겨주므로 Jira/DB 접근이 없는 순수 함수다.
- `src/router/db/jobs.ts` — `getQueuedJobs`, `getOpenJobs` 추가(기존 `createJob`/
  `getOpenJobForIssue`/`transitionJobState`는 1단계 그대로 재사용).
- `src/router/scheduler.ts` — `reconcileCandidates(deps, availableWorkers)`: workspace별
  후보 조회 → 승인 식별자/입력 해시 계산·기록 → 열린 job이 없으면 `decisionProvider.decide`로
  새 job 생성(dispatch → `queued`, wait → `waiting`, human/ignore → job 없음) → 이번 패스에서
  후보로 보이지 않은 열린 job은 승인 철회로 간주해 취소(`waiting`/`queued`/`leased`는
  `cancelled`, `running`은 `cancel_requested`, 그 외는 사람의 수동 재시도로 남김) → `queued`
  job을 `WorkerAvailability[]`(호출자가 넘기는 순수 입력)와 매칭해 임대. Router는 이 단계에서
  Jira에 아무것도 쓰지 않는다(읽기만) — 그래서 "이슈가 이번 패스의 후보 목록에 없다"는 것만으로
  승인 철회를 판단할 수 있다(4단계에서 Router가 Jira 상태를 직접 전이시키면 이 가정이
  깨지므로, 그때 재검토 필요).

**의도적으로 아직 없는 것** (3단계 이후 책임): pairing/session/long-polling과 `jobs/next`
등 `/api/v1/*` 워커 라우트(3단계), Jira에 대한 실제 쓰기(진행 상태 전이, 결과 댓글, PM 계획
적용)와 그 저널/재시도(4단계), 관리 CLI·Docker Compose·구형 코드 제거(5단계).

테스트: `test/jira-client.test.ts`·`test/jira-fake.test.ts`(changelog),
`test/router-webhook.test.ts`·`test/router-server.test.ts`(웹훅 서명·중복 제거, 정방향/역방향
재전송), `test/router-approval.test.ts`, `test/router-candidates.test.ts`,
`test/router-decision.test.ts`, `test/router-scheduler.test.ts`(중복 생성 방지, capability·
repository·pinned worker 필터링, 워커당 활성 attempt 하나, 의존성 재평가, 잘못된 메타데이터·
assignee 없음의 부분 실패, 승인 철회 시 취소).

검증: `npm run check` 통과(`npx vitest run --pool=forks --poolOptions.forks.singleFork`로 실행,
§13 참고). 388 passed / 8 failed — 실패 8건은 1단계 때와 동일한 기존 `spawn EFTYPE` 문제로,
이번 2단계 작업과 무관함을 재확인했다(원인 조사는 여전히 하지 않음).

**3단계를 시작하는 세션/모델에게**: `src/router/scheduler.ts`의 `WorkerAvailability[]`는
현재 호출자가 직접 구성해서 넘기는 순수 입력이다. 3단계에서 워커 등록(`workers` 테이블)과
heartbeat가 생기면, 그 값들로부터 `WorkerAvailability[]`를 만들어 `reconcileCandidates`에
넘기는 어댑터를 추가하면 된다 — 스케줄러 내부는 손댈 필요 없다. 마찬가지로 `RuleDecisionProvider`
생성자는 `RouterConfig` 전체가 아니라 `executionAgent` 설정만 받으므로, Router 부트스트랩
코드에서 `new RuleDecisionProvider(config.executionAgent)`로 생성해 스케줄러에 주입하면 된다.

### 1단계: 계약·설정·저장소 — 완료

구현 파일:

- `src/contracts/protocol.ts` — `PROTOCOL_VERSION`, `JobKind`
- `src/contracts/job-state.ts` — Job 상태 머신(순수 함수), `isJobStateClosed`,
  `ACTIVE_ATTEMPT_JOB_STATES`
- `src/contracts/attempt-state.ts` — Attempt 상태 머신(순수 함수), `ACTIVE_ATTEMPT_STATES`,
  `isAttemptStateTerminal` — job-state.ts와 대칭이지만 별도 타입으로 분리(잡·attempt는
  개념적으로 다른 엔티티)
- `src/contracts/route.ts` — `RouteResult`(`RouteDispatch` | `RouteHold`), `isRouteDispatch`
- `src/contracts/envelope.ts` — `JobEnvelopeSchema`, `JobResultSchema`, `IssueSnapshotSchema`,
  `PlanningContextSchema`
- `src/contracts/api.ts` — `/api/v1/*` 요청/응답 Zod 스키마 (worker register/session/heartbeat,
  jobs next/start/heartbeat/authorize/result)
- `src/contracts/provider.ts` — `WorkerProviderConfigSchema` (claude-code/codex 옵션)
- `src/router/config.ts` — `RouterConfigSchema`(`configVersion: 5`), `loadRouterConfig`
- `src/router/secrets.ts` — Router 환경변수 비밀정보 로더
- `src/router/db/schema.ts` — SQLite DDL. `attempts`/`jobs`의 상태 목록은
  `contracts/job-state.ts`·`contracts/attempt-state.ts`를 단일 출처로 참조(하드코딩 없음)
- `src/router/db/migrate.ts`, `connection.ts` — append-only migration, WAL/FK 활성화
- `src/router/db/errors.ts` — SQLite UNIQUE 제약 위반 판별 헬퍼
- `src/router/db/jobs.ts` — Job repository: `createJob`(이슈당 비종결 작업 하나 제약을
  `DuplicateOpenJobError`로 표면화), `getJob`, `getOpenJobForIssue`, `transitionJobState`
  (상태 머신 위반 시 `InvalidJobStateTransitionError`)
- `src/router/db/attempts.ts` — Attempt repository: `leaseAttempt`(워커당 활성 attempt
  하나 제약을 `WorkerAlreadyLeasedError`로 표면화, job의 `current_attempt_id`/
  `attempt_count` 부기를 같은 트랜잭션으로 처리), `getAttempt`, `getActiveAttemptForWorker`,
  `transitionAttemptState`
- `src/worker-runtime/config.ts` — `WorkerConfigSchema`(`configVersion: 5`), `loadWorkerConfig`
- `src/worker-runtime/credential.ts` — 로컬 worker token 파일 로더

**의도적으로 아직 없는 것** (2단계 이후 책임): Fastify 서버/라우트, 웹훅 서명 검증,
`DecisionProvider`/`RuleDecisionProvider`, 스케줄러(레포지토리 함수를 호출해 실제 배정
결정을 내리는 로직), job/attempt를 job 상태와 함께 원자적으로 옮기는 오케스트레이션(현재
`transitionJobState`와 `leaseAttempt`는 서로 호출하지 않는 별개의 저장소 primitive다 —
"언제 leased로 옮길지"는 2단계 스케줄러의 판단이라 의도적으로 분리했다).

테스트: `test/contracts-state-machines.test.ts`, `test/contracts-schemas.test.ts`,
`test/router-config.test.ts`, `test/router-secrets.test.ts`, `test/router-db.test.ts`,
`test/worker-runtime-config.test.ts`, `test/worker-runtime-credential.test.ts`.

검증: `npm run check` 통과 확인(단, 이 개발 머신은 vitest 기본 `threads` pool에서
better-sqlite3 로딩이 멈추는 환경 특이 문제가 있다 — `docs/runbook.md` §13 참고. 실제
검증은 `npx vitest run --pool=forks --poolOptions.forks.singleFork`로 했고, 결과는
338 passed / 8 failed였다. 실패 8건은 `test/worker-claude-code-cli.test.ts`·
`test/worker-codex-cli.test.ts`의 `spawn EFTYPE`로, 이번 작업 이전부터 있던 무관한
기존 문제임을 clean HEAD에서 재현해 확인했다 — 이번 1단계 작업과는 관련 없다).

**2단계를 시작하는 세션/모델에게**: `src/router/db/jobs.ts`·`attempts.ts`의 repository
함수를 그대로 재사용해 스케줄러를 구성한다. 새 상태 값이나 전이가 필요하면
`contracts/job-state.ts`·`contracts/attempt-state.ts`를 고치고 `schema.ts`는 그 상수를
계속 참조하게 두면 된다(스키마에 새로 하드코딩하지 않는다).

## 1. 목표와 확정 사항

현재 각 머신이 Jira를 조회하고 작업을 선택·실행·보고하는 구조를 다음과 같이 변경한다.

```text
Jira ──Webhook──▶ Router Service ──▶ SQLite
                     ▲
                     │ HTTPS long polling
              ┌──────┴──────┐
              │             │
          Worker A      Worker B
          Codex CLI     Claude Code CLI
              │             │
           로컬 저장소 / 작업 디렉터리
```

[참조 대화](https://chatgpt.com/share/6ab23fd6-d01c-83e8-b9d4-c9482d82d575)의 책임 분리를 적용한다. Router가 실행 경로와 배정 대상을 결정하고, PM과 구현 워커는 모두 실행 대상이 된다.

사용자와 확정한 사항:

- 단일 Router 서버와 SQLite를 사용한다.
- Jira 웹훅을 기본 입력으로 삼고, **Router만** 시작 시·주기적으로 보완 조회한다.
- 워커는 Jira를 직접 조회하지 않고 Router에 HTTPS long polling으로 작업을 요청한다.
- 규칙 기반 배분을 구현하고 `DecisionProvider` 인터페이스를 둔다. Jev·LLM 판단 연동은 후속 작업이다.
- capability·저장소·가용성으로 자동 배분하되, 기존 Jira 실행-Agent 필드로 특정 워커를 고정할 수 있다.
- 설정과 관리는 CLI·설정 파일로 제공한다. 웹 관리 화면은 제외한다.
- 구형 실행 모드와 v2~v4 설정 호환은 제거한다. 자동 이전 도구 없이 새 설정으로 재구성한다.
- 실행 중 연결이 끊겨 결과가 불명확한 작업은 자동 재실행하지 않는다. 중단 확인 후 수동으로 재시도한다.
- Jira 이슈, 기존 실행 기록, 작업 디렉터리와 Git 브랜치는 삭제하지 않는다.

이번 범위는 Router·Worker·관리 CLI·배포 구성·테스트·운영 문서까지다. 실제 서버 배포, Jira 설정 변경, AI 계정 로그인은 구현과 구분된 운영 단계로 남긴다.

## 2. 컴포넌트와 실행 동작

### Router Service

Router가 다음 책임을 독점한다.

- Jira 인증, 웹훅 수신, 최신 이슈·댓글·계획 메타데이터 조회.
- 승인 상태, 인간 책임자, 의존성, 계획 버전 검증.
- 작업 생성, 워커 선택, 임대, 취소, 복구 판단.
- PM 결과를 Jira 계획·하위 이슈로 적용.
- 실행 결과 댓글·라벨·상태 전이.
- 워커 등록·폐기와 감사 기록.

Jira는 업무 상태와 인간 승인에 대한 기준이고, SQLite는 작업 실행·배정·임대·전송 상태의 기준이다. 실행 정보를 Jira 상태명으로 역추론하지 않는다.

Router는 AI CLI를 직접 실행하지 않는다.

### Worker Runtime

워커는 Router 인증과 로컬 실행 환경만 보유한다.

- 로컬 Codex·Claude Code 인증과 실행 설정.
- `repositoryId → 로컬 절대 경로` 매핑.
- 로컬에서 허용한 provider·backend·검증 명령.
- 작업 수신, 실행, heartbeat, 취소, 결과 재전송.
- 로그·worktree·결과 전송 대기 파일의 로컬 보존.

작업 데이터에 담긴 경로나 명령을 그대로 실행하지 않는다. Router는 `repositoryId`와 `providerId`를 지정하고, 실제 경로·실행 명령은 워커 설정에서 결정한다.

PM 실행도 같은 워커 런타임을 사용한다. PM은 구조화된 계획을 반환하고 Jira에 직접 쓰지 않는다.

### 라우팅과 배정

`RouteResult`는 특정 워커 ID 대신 실행 의도를 표현한다.

```ts
type RouteResult =
  | {
      target: "planning" | "implementation";
      workspaceId: string;
      repositoryId: string;
      requiredCapabilities: string[];
      pinnedWorkerId?: string;
      reason: string;
    }
  | {
      target: "wait" | "human" | "ignore";
      reason: string;
    };
```

`DecisionProvider.decide(context)`가 이를 반환한다. 첫 구현체는 `RuleDecisionProvider` 하나이며, 승인·권한 검증은 provider 호출 전에 적용한다. 향후 판단 모델도 이 검증을 우회하지 못한다.

배정 규칙:

1. 실행 가능한 Jira 요청 상태인지 확인한다.
2. 인간 Assignee 존재, 계획 버전·workspace·의존성을 검증한다.
3. 저장소 접근권한, capability, 사용 가능한 backend·provider를 만족하는 워커를 추린다.
4. 실행-Agent 필드가 있으면 설정된 `optionId → workerId` 매핑으로 대상을 제한한다.
5. 비어 있으면 자동 배분한다. 알 수 없는 지정값은 자동 배분으로 우회하지 않는다.
6. 실행 가능한 작업은 생성 순서대로 처리한다. 워커는 가장 오래 배정받지 않은 순서, 동률이면 `workerId` 순으로 선택한다.

최초 버전은 **워커당 동시 작업 1개**로 고정한다. 일시적인 워커 부재·의존성 미완료는 대기, 잘못된 메타데이터·알 수 없는 capability는 인간 확인 대상으로 기록한다.

관리자가 허용한 capability·저장소와 워커가 보고한 가용성의 교집합만 사용한다. 워커 등록 요청만으로 권한을 확대하지 않는다.

### Jira 업무 흐름

현재 로컬 설정의 기본 흐름을 유지한다.

```text
AI 작업 요청 → 작업 중 → AI 작업 완료
```

- 구현 요청 상태에 진입하는 행위가 해당 이슈의 실행 승인이다.
- 계획은 `planningStatus`를 별도로 설정했을 때만 활성화한다.
- 계획·구현은 진행 및 검토 상태를 공유한다.
- Router가 실행 직전 최신 상태를 재조회하고 진행 상태로 전이한다.
- 성공은 검토 상태로 이동한다. 자동 Done 처리는 추가하지 않는다.
- Assignee는 인간 책임자로 유지한다. 워커 계정으로 교체하지 않는다.
- 새 PM 하위 이슈는 Jira 기본 생성 상태에 둔다. 그 기본 상태가 실행 요청 상태인 프로젝트는 설정 검사에서 거부한다.
- 기존 `ggjira.plan`·`ggjira.plan-task`의 계획 버전·의존성 의미를 유지한다.
- 실행 중 승인 철회, 책임자 제거, 실행 대상 변경, 계획 버전 변경은 취소 사유다.
- 실행 중 작업 설명·요구 capability·의존성 변경도 취소하고 새 승인을 요구한다. 일반 댓글이나 Router의 보고 댓글만으로 취소하지 않는다.
- 실패 후 자동 PM 재계획이나 자동 재실행은 하지 않는다. 사람이 계획 요청 상태로 이동하거나 재시도 명령을 사용한다.

### 웹훅과 보완 조회

- Jira Cloud의 관리자 웹훅을 사용한다.
- 요청 원문으로 `X-Hub-Signature`를 검증한다. SHA-256만 허용하고 상수 시간 비교를 사용한다.
- `X-Atlassian-Webhook-Identifier`를 사이트 ID와 함께 저장해 중복 전달을 제거한다.
- 인증·형식 검사 후 SQLite에 이벤트를 영속화하고 `202`를 반환한다. Jira 조회와 배분은 이후 처리한다.
- 웹훅 내용은 변경 알림으로 사용하고, 실행 판단에는 Jira에서 다시 읽은 데이터를 사용한다.
- 웹훅 필터는 프로젝트 기준으로 설정한다. 요청 상태만 필터링하여 승인 철회 이벤트가 누락되지 않게 한다.

서명과 전달 식별자 처리는 [Atlassian 공식 웹훅 문서](https://developer.atlassian.com/cloud/jira/platform/webhooks/)를 기준으로 구현한다.

Router 시작 시 전체 실행 후보를 재조회하고 이후 60초마다 후보·대기 작업을 보완 조회한다. 활성 작업의 승인은 최대 5초 간격으로 중앙에서 확인한다. 호출은 중복을 합치고 페이지네이션 및 `Retry-After`를 준수한다.

## 3. 데이터·API·장애 처리 계약

### 설정과 저장소

새 설정은 `configVersion: 5`로 분리한다.

| 설정 | 포함 내용 |
|---|---|
| Router | Jira 연결, workspace·프로젝트·저장소 매핑, 상태 매핑, 워커 허용 정책, 실행-Agent 매핑, DB·HTTP 설정 |
| Worker | Router URL, credential 파일 경로, 로컬 저장소 매핑, provider·backend, 검증 명령, 로그 경로 |
| 비밀정보 | Jira token·웹훅 secret·관리자 token은 Router 환경변수, 워커 token은 별도 로컬 파일 |

첫 버전은 Jira 사이트 하나를 지원하고 여러 프로젝트를 workspace에 연결할 수 있게 한다. 프로젝트별 기본 저장소를 설정하며, 기존 계획 메타데이터에 workspace가 있으면 일치 여부를 검증한다.

SQLite에는 다음을 저장한다.

- 수신 이벤트와 처리 상태.
- 이슈별 승인 식별자·작업 입력 스냅샷.
- 작업과 실행 attempt, 워커 배정, 임대·취소 상태.
- 워커·credential hash·일회용 pairing 정보.
- 실행 결과와 Jira 반영 작업 목록.
- 감사 기록 및 schema migration 버전.

WAL·외래키를 활성화하고 배정은 트랜잭션으로 처리한다. 이슈당 비종결 작업 하나, 워커당 활성 attempt 하나를 DB 제약으로 보장한다. 네트워크 호출을 DB 트랜잭션 안에서 기다리지 않는다.

승인 식별자는 요청 상태로 진입한 Jira changelog 항목을 사용한다. 생성부터 요청 상태였던 이슈는 생성 이벤트를 사용한다. 이를 위해 Jira 어댑터에 페이지네이션된 changelog 조회를 추가한다. 단순 `updated` 값은 승인 식별자로 사용하지 않는다.

### 공개 HTTP 인터페이스

모든 Worker API는 `/api/v1` 아래에 두며, 식별자는 서버가 발급한다.

| API | 동작 |
|---|---|
| `POST /webhooks/jira` | 서명 검증 및 이벤트 저장 |
| `GET /health` | 최소 liveness 정보 |
| `POST /api/v1/workers/register` | 일회용 pairing code로 등록 |
| `POST /api/v1/workers/session` | 재접속 세션 시작, 미확정 작업 확인 |
| `POST /api/v1/workers/heartbeat` | 가용성 보고 및 취소 지시 수신 |
| `POST /api/v1/jobs/next` | 최대 25초 대기 후 작업 예약 반환, 없으면 `204` |
| `POST /api/v1/jobs/{id}/start` | 임대·승인 확인 후 실행 허가 |
| `POST /api/v1/jobs/{id}/heartbeat` | 실행 임대 갱신, 취소 여부 반환 |
| `POST /api/v1/jobs/{id}/authorize` | 커밋·검증 직전 실행 권한 재확인 |
| `POST /api/v1/jobs/{id}/result` | 실행 결과 또는 중단 결과 제출 |

`jobs/next`는 예약을 변경하므로 GET 대신 POST를 사용한다. `requestId`를 필수로 받아 응답 유실 후 동일 요청을 재전송하면 동일 예약을 반환한다.

작업 envelope에는 다음을 포함한다.

```text
protocolVersion, jobId, attemptId, leaseToken
workspaceId, repositoryId, kind, providerId
approvalId, inputHash, issueSnapshot, planningContext?
systemPrompt, timeoutMs
```

- `kind`: `planning | implementation`.
- 계획 실행에는 이슈·관련 댓글·기존 하위 이슈를 Router가 모아 전달한다.
- 결과에는 기존 `ExecutionResult` 정보와 `attemptId`, `resultId`, 계획 작업의 `plan`을 포함한다.
- 모든 변경 요청은 워커 identity·session·attempt·lease를 함께 검증한다.
- 같은 결과의 재전송은 성공 처리한다. 동일 `resultId`의 다른 내용은 `409`로 거부한다.
- 다른 워커의 작업 접근은 `403`, 오래되거나 만료된 실행 권한은 `409`로 거부한다.
- 버전 불일치는 실행 전에 명시적인 호환 오류로 처리한다.

### 임대와 작업 상태

```text
waiting → queued → leased → running → succeeded / failed / timed_out
                      │        │
                      │        ├→ cancel_requested → cancelled
                      │        └→ recovery_required
                      └→ queued  (start 허가가 전혀 없었던 경우만)
```

- long polling: 25초.
- heartbeat: 5초.
- 임대: 30초.
- 워커는 마지막 성공한 heartbeat 요청 시작 시점부터 20초 동안 갱신하지 못하면 실행을 중단한다.
- 중단 시 자식 프로세스 종료를 요청하고 5초 후 강제 종료한다.
- Windows와 Linux의 프로세스 트리 종료를 모두 구현·검증한다.
- `start` 승인 이후의 만료·불명확한 연결 종료는 `recovery_required`로 둔다.
- Router 재시작은 임대를 지우거나 실행을 자동 재개하지 않는다.
- 늦게 도착한 결과는 감사 자료로 보존할 수 있지만 완료 처리·Jira 전이에 적용하지 않는다.

수동 재시도는 새로운 attempt를 만든다. `recovery_required`는 워커의 중단 확인 또는 관리자의 중단 확인 기록이 있어야 해제한다. 새 실행 전 Jira 요청 상태의 승인을 다시 확인한다.

분산 임대만으로 로컬 파일 부작용의 정확히 한 번 실행을 보장한다고 주장하지 않는다. 재배정 차단과 작업 격리를 함께 적용한다.

### 실행 결과와 Jira 반영 분리

워커는 결과를 로컬에 원자적으로 저장한 후 전송한다. Router가 수신을 확인하기 전까지 보존하고 재시작 후 재전송한다.

Router는 결과 저장과 Jira 반영 작업 생성을 한 트랜잭션으로 처리한다. Jira 반영 상태는 실행 상태와 별개로 관리한다.

- 댓글에는 작업·attempt 기반 고유 마커를 넣는다.
- 상태 전이 전에 현재 상태와 승인 조건을 재확인한다.
- 이미 반영된 댓글·상태·계획 단계는 재전송하지 않는다.
- 응답 유실로 Jira 쓰기 성공 여부가 불명확하면 재조회로 확인한다.
- 확인할 수 없는 생성·전이 요청은 무작정 재전송하지 않고 `recovery_required`로 보류한다.
- Jira 보고 재시도는 AI 워커를 다시 실행하지 않는다.
- 성공 보고가 늦게 도착하더라도 사람이 바꾼 상태를 덮어쓰지 않는다.

PM 계획 적용은 단계별 저널을 기록한다. 하위 이슈 생성 시 최초 요청에 작업·task 고유 마커를 포함해 응답 유실 후에도 조회할 수 있게 한다. 계획 적용이 일부 완료된 상태에서는 같은 작업을 이어서 복구하며, 계획을 다시 생성하지 않는다.

## 4. 기존 코드 전환과 구현 순서

### 유지·리팩터링·삭제 경계

| 대상 | 변경 |
|---|---|
| Jira client·gateway·retry·fake | Router 전용으로 유지 |
| Codex·Claude provider, prompt, worktree | Worker 실행 구성요소로 유지 |
| capability·requirements·계획 검증 | 공유 순수 로직으로 분리 |
| PM context 수집·계획 적용 | Router로 이동 |
| PM 모델 호출·계획 파싱 | Worker에서 수행하고 구조화 결과 반환 |
| 구현 executor의 Jira 확인 타이머 | Router 임대·취소·authorize 호출로 대체 |
| reporter | Router의 영속 결과 반영 처리로 변경 |
| 로컬 JobStore | 중앙 실행 상태는 SQLite로 대체, 로컬 로그·결과 보존은 분리 |
| 기존 poller·poll cycle·bootstrap·claim 경로 | 새 경로 검증 후 제거 |
| Jira Agent Profile·Workspace Configuration 등록/조회 | 제거 |
| v2/v3/v4 실행 분기와 구형 setup·CLI | 제거 |

기존 profile 계층의 prompt preset·description 렌더링은 사용처를 옮겨 유지한다. 디렉터리 전체 삭제로 공통 유틸리티를 잃지 않게 한다.

PM 출력에서 `assigneeAgentId`, Agent Profile 생성·비활성화 요청을 제거한다. PM은 요구 capability와 작업 계획만 반환한다.

기존 `run`, `once`, `agent:*` 등의 운영 경로는 제거하고 새 명령을 안내한다. 구형 설정을 조용히 해석하지 않는다.

### 관리 CLI

다음 명령군을 제공한다.

```text
ggjira router setup | serve | check
ggjira router workers list | pair | disable | revoke
ggjira router jobs list | show | cancel | retry | resolve
ggjira router reports retry
ggjira router reconcile
ggjira router backup

ggjira worker setup | run | check
ggjira worker results retry
ggjira worker worktrees prune
```

- Router 운영 명령은 관리자 인증 API를 호출한다. 실행 중인 DB를 CLI가 직접 수정하지 않는다.
- 관리자 API는 `/api/v1/admin` 아래에서 워커·작업·보고·동기화·백업 기능을 제공한다.
- 작업 목록은 서버 페이지네이션을 적용한다.
- pairing code는 관리자 생성, 10분 유효, 한 번만 사용 가능하게 한다.
- 발급된 워커 token은 hash만 Router에 저장하고 로그에 노출하지 않는다.
- 워커 권한·저장소·prompt 정책은 Router 설정에서 관리하고 재시작 시 반영한다.
- 워커 비활성화는 신규 배정을 차단하고, credential 폐기는 활성 실행에도 취소를 요청한다.

### 구현 단계

1. **계약·설정·저장소**
   - 공유 Zod 스키마, v5 설정, SQLite migration, 상태 전이와 배정 제약을 구현한다.
   - Router/Worker 구분과 API 계약을 먼저 고정한다.

2. **Router 입력·판단**
   - 웹훅 검증·중복 제거, Jira 보완 조회, 승인 식별, 규칙 기반 route와 scheduler를 구현한다.
   - Fake worker로 작업 생성·배정·대기를 검증한다.

3. **Worker 통신·실행**
   - pairing, 세션, long polling, start, heartbeat, 취소, 결과 spool을 구현한다.
   - 기존 provider·worktree를 연결하고 Jira 의존성을 제거한다.

4. **PM·보고·복구**
   - PM context와 계획 적용을 분리한다.
   - Jira 반영 저널, 결과 재전송, 불명확한 작업 복구를 구현한다.

5. **운영 기능·기존 구조 제거**
   - 관리 CLI, Docker Compose, 백업·복원 절차를 추가한다.
   - 구형 실행·설정·프로필 코드를 제거하고 관련 테스트를 새 구조로 교체한다.
   - README·아키텍처·runbook·CLAUDE.md를 갱신한다.
   - 새 ADR에서 이전 폴링·Jira 프로필·로컬 lease 결정을 대체한다고 명시한다. 과거 ADR은 이력으로 보존한다.

작업 트리의 기존 `.claude/`와 사용자 설정·비밀정보는 임의로 변경하거나 삭제하지 않는다.

## 5. 검증·배포·완료 기준

### 기술 구성과 기본값

- TypeScript ESM, Zod, Pino, Vitest를 유지한다.
- 실행 기준은 Node.js 24로 통일한다.
- HTTP 서버는 Fastify 5, SQLite 접근은 `better-sqlite3`를 사용하고 설치 버전을 lockfile에 고정한다.
- Router와 Caddy HTTPS 프록시를 Docker Compose로 제공한다.
- Router는 단일 인스턴스이며 DB는 로컬 영속 볼륨에 둔다. 공유 네트워크 파일시스템은 사용하지 않는다.
- Worker는 Windows·Linux 네이티브 실행을 지원한다.
- HTTP는 loopback 개발 환경만 허용한다. 운영은 유효한 인증서가 있는 도메인과 HTTPS를 사용한다.

구현 시 참조: [Node.js 릴리스](https://nodejs.org/en/about/previous-releases), [Fastify](https://fastify.dev/docs/latest/Guides/Getting-Started/), [better-sqlite3](https://github.com/WiseLibs/better-sqlite3).

Git 작업은 기존 worktree·로컬 커밋 방식을 유지한다. 자동 push·merge·PR 생성은 추가하지 않는다. 결과에는 worker·repository·branch·commit 식별자를 기록한다. 비Git 작업은 직접 편집을 유지하고 저장소별 동시 실행을 금지한다.

### 필수 테스트

외부 Jira·실제 AI 호출은 자동 테스트에 넣지 않는다. Fake Jira·Fake provider·임시 SQLite·가상 시계·로컬 HTTP 서버를 사용한다.

- 동일 웹훅 반복·역순 수신, Router 자기 댓글 이벤트에서 중복 작업이 생기지 않는다.
- 워커 두 개가 동시에 요청해도 하나의 작업에 실행 허가는 하나만 발급된다.
- long polling 응답 유실·start 응답 유실이 중복 실행으로 이어지지 않는다.
- capability·저장소·고정 워커 조건이 배정에 적용된다.
- 의존성 완료 후 대기 작업이 재평가된다.
- 잘못된 계획 메타데이터는 실행을 차단하되 다른 작업은 계속 처리한다.
- 승인 철회·책임자 제거·계획 변경 시 실행을 중단한다.
- Router·Worker 재시작, lease 만료, 늦은 heartbeat·결과를 처리한다.
- 불명확한 실행은 자동 재배정되지 않는다.
- PM 결과 재전송과 계획 적용 중 장애에서 하위 이슈를 중복 생성하지 않는다.
- Jira 보고 실패 후 보고만 재시도하고 워커 실행 횟수는 증가하지 않는다.
- 잘못된 서명, 폐기 token, 타 워커 작업 접근, 경로 탈출, 임의 provider 지정은 거부한다.
- Windows·Linux에서 provider 실행과 프로세스 트리 취소를 검증한다.
- Worker 실행 경로에 Jira client·credential·직접 네트워크 호출 의존성이 없음을 검사한다.
- SQLite 백업을 복원한 뒤 미완료 이벤트·작업·보고를 올바르게 복구한다.

`npm.cmd run check`와 `npm.cmd run build`를 통과시키고, Docker Compose 환경에서 Router 하나·Fake worker 두 개의 통합 시나리오를 실행한다. 실제 Jira 웹훅과 각 AI CLI 연동은 별도 수동 smoke test로 기록한다.

### 운영 전환

1. 기존 에이전트를 모두 중지하고 진행 중 실행의 종료 여부를 확인한다.
2. 기존 설정·실행 기록·worktree를 보존한다.
3. Router v5 설정과 워커 로컬 설정을 새로 만든다.
4. 실제 Jira 상태와 전이 가능 여부를 `router check`로 확인한다.
5. HTTPS Router를 시작하고 Jira 관리자 웹훅을 연결한다.
6. 워커를 pairing한 뒤 보완 동기화를 실행한다.
7. 테스트 이슈 하나로 승인 → 배정 → 실행 → 검토 상태를 확인한다.
8. 기존 에이전트의 자동 시작 설정을 해제한다.

관측 항목은 큐 대기 시간, 워커 연결 상태, 활성·복구 대기 작업 수, 웹훅 처리 지연, Jira 보고 실패 수로 한정한다. 로그는 이벤트·job·attempt·worker ID로 연결한다.

완료 조건은 **Jira 접근이 Router로 집중되고, 여러 워커가 중앙 배분으로 실행하며, 승인 철회·연결 장애·중복 전달·보고 실패를 재실행 없이 통제할 수 있는 것**이다. 실제 배포나 외부 연동을 검증하지 못했다면 구현 검증과 분리해서 명시한다.
