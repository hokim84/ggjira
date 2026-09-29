# 아키텍처 (configVersion 5)

Router가 Jira 접근과 배정 판단을 모두 맡는다. 워커는 Router에만 연결한다. 배경과 단계별 기록은
[`router-service-implementation-plan.md`](./router-service-implementation-plan.md)와 ADR
[0018](./decisions/0018-router-centric-architecture.md)~[0022](./decisions/0022-router-stage5-operations-and-legacy-removal.md)에
있다. v2~v4(각 머신이 Jira를 폴링·claim하던 구조)는 5단계에서 삭제했다. 그 설명은 git 이력과
ADR 0001~0017에 남아 있다.

```text
Jira ──Webhook──▶ Caddy (HTTPS) ──▶ Router (ggjira router serve) ──▶ SQLite (/data)
                                        ▲
                                        │ HTTPS long polling (/api/v1)
                               ┌────────┴────────┐
                               │                 │
                          Worker A           Worker B      (ggjira worker run)
                          Codex CLI          Claude Code CLI
                               │                 │
                         로컬 저장소 · worktree · 결과 spool
```

## 책임 분리

| 구성요소 | 디렉터리 | 하는 일 | 하지 않는 일 |
|---|---|---|---|
| Router | `src/router/` | 웹훅 수신, Jira 조회·쓰기, 승인 식별, 라우팅, 스케줄링, 임대, 보고 저널, 복구, 관리 API | AI CLI 실행 |
| Worker | `src/worker-runtime/` | Router 인증, 작업 수신, 실행, heartbeat, 취소, 결과 spool·재전송 | Jira 호출, Router DB 접근(`test/worker-runtime-no-jira.test.ts`) |
| 실행 구성요소 | `src/worker/` | provider(Claude Code·Codex), 프로세스 트리 종료, worktree, 검증 명령 | |
| 계약 | `src/contracts/` | envelope·결과·API 스키마, job/attempt 상태 머신 | |
| 공유 순수 로직 | `src/pm/`, `src/issue/` | 계획 스키마·메타데이터·렌더링·프롬프트, 요구 capability 파싱·매칭 | I/O |

Jira는 업무 상태와 인간 승인의 기준이다. SQLite는 job·attempt·임대·보고 상태의 기준이다.
Assignee는 인간 책임자이며, Router는 이를 워커 계정으로 바꾸지 않는다.

## Router 프로세스 (`router serve`, `src/router/daemon.ts`)

HTTP 서버 하나와 주기 루프 네 개로 이뤄진다.

| 루프 | 주기 | 호출 | 비고 |
|---|---|---|---|
| sync | 1초마다 점검. 부팅 시, `backgroundIntervalMs`(60초)마다, 미처리 웹훅이 있을 때 실행 | `reconcileCandidates` | 웹훅은 변경 알림일 뿐이고, 판단은 Jira 재조회로 한다. 실패 후 10초 backoff |
| verify | `activeJobPollIntervalMs`(5초) | `verifyActiveJobs` | leased/running job의 승인을 Jira에서 재확인. sync와 같은 lane |
| reports | 2초 | `processReportJournal` | `report_steps` 저널을 진행 |
| leases | 5초 | `expireLeases` | 워커 API 호출 시에도 정리 |

재시작해도 아무것도 재개하지 않는다. 임대는 SQLite에 있고, 만료되면 시작 전이면 재대기,
시작 후면 `recovery_required`다(ADR 0020).

## 승인과 배정

1. 후보: workspace별 JQL(`project in (...) AND status in (request, planning)`)이다. v4 메타 이슈
   라벨은 제외한다.
2. 승인 id: 요청 상태에 진입한 changelog 항목(`src/router/approval.ts`)이다. 입력 hash는 설명·
   capability·의존성·계획 버전으로 만든다.
3. `RuleDecisionProvider`: 인간 Assignee, 계획 버전(부모의 현재 계획일 때만), 의존성, 실행-Agent
   필드 고정을 본다. 결과는 `planning | implementation | wait | human | ignore`다.
4. 배정: queued job을 생성 순서대로 처리한다. 조건은 관리자 정책(`workers[]`)과 워커가 보고한
   capability·저장소의 교집합이다. 워커당 동시 1개다. 후보는 LLM 플랜 여유가 많은 순, 그다음 가장 오래
   배정받지 않은 순이다. 리셋 전 100%인 한도 창이 있는 워커는 건너뛴다(ADR 0029,
   `scheduling.usage`). `jobs/next`에서는 요청한 워커만 받을 수 있고, 여유가 더 많은 유휴 워커가
   있으면 양보한다.
5. 관리자 hold: `jobs cancel`을 한 승인은 다시 배정하지 않는다(`admin_holds`, ADR 0022).
6. Jev 관찰 평가(ADR 0030): `TYPESAFE_API_KEY`가 있으면 `assess` 루프가 새 job마다 모델 등급과
   준비 상태를 Jev에 묻고 `job_assessments`에 기록한다. 아직 어떤 결정에도 쓰지 않는다.

## Worker API (`/api/v1`, `src/router/worker-service.ts`)

```
Worker                                   Router (SQLite)
  workers/register (pairing code) ───▶   token 발급(hash만 저장)
  workers/session ───────────────────▶   현재 세션 교체, 미확정 attempt 반환, 로컬 저장소 경로 기록(표시용)
  workers/heartbeat (5s) ────────────▶   가용성 기록, 취소 지시
  workers/usage (연결 시·작업 직후) ───▶   provider별 LLM 플랜 사용량 저장(ADR 0028)
  jobs/next (≤25s) ──────────────────▶   queued job 임대(30s) → envelope
  jobs/{id}/start ───────────────────▶   승인 재확인 → running, start 보고 단계 기록
  jobs/{id}/heartbeat (5s) ──────────▶   임대 갱신, 승인 변경 시 cancel
  jobs/{id}/authorize (커밋·검증 직전) ▶   실행 권한 재확인
  spool → jobs/{id}/result ──────────▶   결과 저장 + 보고 단계 기록(한 트랜잭션)
```

모든 변경 요청은 identity, session, attempt 소유, lease token, 임대 신선도를 한 트랜잭션에서
검증한다. 오류는 다른 워커 403, 만료·오래된 권한 409, 프로토콜 불일치 426이다.

## Jira 보고 저널 (ADR 0021)

```
start 허가 ──▶ [start:<attempt>]   승인 상태 → inProgressStatus
result 저장 ─▶ [<resultId>]         성공: 댓글 → 실패 라벨 제거 → reviewStatus
                                    실패: 댓글 + ggjira-failed (inProgressStatus 유지)
                                    결정 요청: 댓글 → needsDecisionStatus ?? reviewStatus
                                    계획: 부모 계획 블록 → 하위 이슈 생성(마커) → plan-task
                                          → ggjira.plan → superseded → 댓글 → reviewStatus
중단 확인 ───▶ [recovered:<attempt>] "적용된 것 없음" 댓글
```

각 단계는 쓰기 전에 Jira를 다시 읽는다. 결과가 불명확한 쓰기는 `uncertain`으로 두고 재조회로
확정한다. 확정할 수 없는 하위 이슈 생성은 `recovery_required`로 둔다. 명확한 거부는 `failed`다.
`failed`와 `recovery_required`는 관리자의 `reports retry`로만 풀린다. 이 재시도는 워커를 다시
실행하지 않는다.

## 관리 (`/api/v1/admin`, `src/router/admin-service.ts`)

관리 API는 admin token(bearer)으로 인증하고, 모든 변경을 `audit_log`에 actor와 함께 남긴다. CLI는
이 API만 쓰고 DB를 직접 열지 않는다.

| CLI | API | 동작 |
|---|---|---|
| `router status` | `GET /status` | job 상태별 수, 큐 대기, 워커 연결, recovery 대기, 웹훅 지연, 막힌 보고 |
| `router workers list/pair/disable/enable/revoke` | `/workers…`, `/pairing-codes` | pairing code는 10분, 1회. disable은 새 배정만 막고, revoke는 token 무효화와 함께 활성 실행에 취소를 건다 |
| (웹 UI 워커 추가) | `POST /workers` | 정책을 설정에 추가, 적용, 첫 pairing code 발급(ADR 0025) |
| (웹 UI 설정) | `POST /jira/project`, `POST /jira/workflow-check` | 프로젝트 상태·하위 이슈 유형 목록, 저장 전 상태 매핑으로 Router가 하는 전이(시작·완료·결정 요청)가 워크플로에 있는지 확인(읽기 전용, `src/router/workflow-check.ts`) |
| `router jobs list/show/cancel/retry/resolve` | `/jobs…` | list는 keyset 페이지네이션. retry는 Jira 승인을 재확인한 뒤 새 attempt를 만든다. resolve는 중단 확인 |
| `router reports list/retry` | `/reports…` | 막힌 보고 배치 재대기 |
| `router reconcile` | `POST /reconcile` | sync lane에서 즉시 1회 실행 |
| `router backup` | `POST /backup` | SQLite online backup을 `<db dir>/backups/`에 저장 |
| (웹 UI) | `GET/PUT /config`, `POST /config/apply`, `POST /check` | 설정 파일 조회, 검증 후 저장(`.bak`)과 즉시 적용, 손으로 고친 파일 적용, 저장된 설정으로 `router check` |

## 워커 시작 (`worker start`, ADR 0025)

`workers/register` 응답에는 워커 프로필(허용 capabilities, providerId, 저장소 id·`cloneUrl`·`baseBranch`)이
함께 온다. `worker start`(`src/worker-runtime/start.ts`)는 처음 실행될 때 터미널에서 Router 주소, LLM CLI,
페어링 코드, 저장소 폴더를 차례로 묻고 이 프로필로 워커 설정을 쓴다. `cloneUrl`이 있는 저장소는
`<dataDir>/repos/<id>`에 clone하고 바로 실행한다. Router는 URL만 주고, 로컬 경로와 검증 명령은 워커가 정한다. 성공한 작업 브랜치는 워커 설정의 `pushRemote`(기본 `origin`)에 push하고,
push 직전에 `authorize`(stage `push`)로 권한을 다시 확인한다(ADR 0026). GitHub 원격이고 `createPullRequest`면 워커가
`gh`로 PR을 열어 결과에 담는다. Router는 이를 `pull_requests`에 기록하고, `/webhooks/github`(HMAC 검증) 또는
5분 폴링으로 머지를 알게 되면 이슈를 검토 상태에서 `doneStatus`로 옮긴다(ADR 0027, `src/router/github.ts`).

## 웹 UI와 셋업 모드 (ADR 0023)

`router serve`는 `web/router-ui/`(빌드 없는 정적 HTML/JS)를 `/ui/`에서 서빙한다(`src/router/web-ui.ts`).
화면은 대시보드(`/status`), 워커(5초 폴링, 페어링 코드, enable/disable/revoke, LLM 플랜 사용량),
설정 편집, Jira 점검이다.
모두 admin token으로 위 관리 API만 호출한다. Jev API 키는 입력만 받고 되돌려주지 않는 칸으로 설정한다
(`PUT /secrets/jev`, `router.env`에 기록, ADR 0031). GitHub 토큰도 같은 방식이고(`PUT /secrets/github-token`),
GitHub 영역은 추적 중인 PR과 마지막 확인 결과, "지금 확인"(`POST /github/poll`)을 보여 준다(ADR 0032). 설정은 저장 즉시 `RouterDaemon.applyConfig`로 적용된다
(sync/verify lane에서 직렬, ADR 0024). `http`, `db.path`, `jira.baseUrl`, `executionAgent.fieldId`만
재시작해야 반영된다.

설정 파일이 없거나 비밀정보가 불완전하면 `router serve`는 셋업 모드로 뜬다(`src/router/setup-server.ts`).
DB와 루프 없이 `/ui/`와 `/api/v1/setup/*`만 제공하고, 콘솔에 찍힌 일회용 setup token으로 인증한다.
마법사가 설정 파일과 secrets 파일(`router.env`, 0600)을 쓰면 token은 무효가 된다. 비밀정보는
환경변수가 우선이고, 없는 키만 secrets 파일에서 읽는다(`loadRouterSecrets`).

## 실패 추적

| 계층 | 신호 |
|---|---|
| router (sync/verify) | 로그 `layer:"router" pass:"reconcile"/"verify"`, `skipped`/`held` 사유 |
| router (reports) | `report_steps.status`·`last_error`, `router reports list` |
| router (leases) | 로그 `leases expired`, job `recovery_required` |
| jira | `JiraApiError`(status, endpoint), 429는 `Retry-After` 준수 |
| worker-runtime | 로그 `layer:"worker-runtime"`, spool 파일, 결과의 `failureReason` |
| worker | provider `exitReason`(completed/nonzero/timeout/crashed), 검증 명령 결과 |

## Provider 경계

`WorkerProvider`(`src/worker/provider.ts`)에 구현이 두 개 있다. 워커 설정 `providers[]`의 id로
고르고, Router는 envelope에 `providerId`만 담는다.

- `ClaudeCodeCliProvider`: `claude -p --output-format stream-json`을 쓴다. 구조화 출력은
  `--json-schema`, 시스템 프롬프트는 `--append-system-prompt`로 넘긴다.
- `CodexCliProvider`: `codex exec --json --output-last-message <file>`을 쓴다. 시스템 프롬프트와
  스키마는 프롬프트 본문에 넣는다. 실제 `codex` CLI로는 아직 검증하지 않았다(ADR 0010).

프로세스 제어는 `src/worker/spawn.ts`가 한다. timeout이 나면 트리 종료를 요청하고 5초 뒤 강제
종료한다. Windows는 `taskkill /T`, POSIX는 프로세스 그룹을 쓴다. `FakeWorkerProvider`는 테스트
전용이다.

## 배포

- Router는 `Dockerfile`(Node 24) + `docker-compose.yml`(router + Caddy)로 배포한다. DB는 named
  volume `/data`, 설정과 secrets 파일은 쓰기 가능한 `./deploy/config:/config`, TLS는 Caddy가 맡는다. 운영 절차는 [runbook](./runbook.md) §16~§18에 있다.
- Worker는 Windows·Linux 네이티브로 `ggjira worker run`을 실행한다. Router URL은 HTTPS여야 하고,
  loopback만 예외다.
- `docker compose -f docker-compose.test.yml run --rm --build check`는 Linux에서 check 전체를
  돌린다. 여기에는 Router 하나와 Fake 워커 둘의 통합 시나리오가 포함된다.
