# 아키텍처 (configVersion 7)

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

HTTPS 앞단은 둘 중 하나다. `docker-compose.yml`은 Caddy가 80/443을 받고 인증서를 발급한다.
`docker-compose.cloudflare.yml`은 `cloudflared` 터널이 밖으로 연결하고 Cloudflare가 TLS를 맡아서, 서버에
여는 포트가 없다(ADR 0033, runbook §16-1).

## 책임 분리

| 구성요소 | 디렉터리 | 하는 일 | 하지 않는 일 |
|---|---|---|---|
| Router | `src/router/` | 웹훅 수신, Jira 조회·쓰기, 승인 식별, 라우팅, 스케줄링, 임대, 보고 저널, 복구, 관리 API | AI CLI 실행 |
| Worker | `src/worker-runtime/` | Router 인증, 작업 수신, 실행, heartbeat, 취소, 결과 spool·재전송 | Jira 호출, Router DB 접근(`test/worker-runtime-no-jira.test.ts`) |
| 실행 구성요소 | `src/worker/` | provider(Claude Code·Codex), 프로세스 트리 종료, worktree, 검증 명령 | |
| 계약 | `src/contracts/` | envelope·결과·API 스키마, job/attempt 상태 머신 | |
| 공유 순수 로직 | `src/pm/`, `src/issue/` | 계획 스키마·메타데이터·렌더링·프롬프트, 실행 계약·입력 해시 | I/O |

Jira는 업무 상태와 인간 승인의 기준이다. SQLite는 job·attempt·임대·보고 상태의 기준이다.
Assignee는 인간 책임자이며, Router는 이를 워커 계정으로 바꾸지 않는다.

## Router 프로세스 (`router serve`, `src/router/daemon.ts`)

HTTP 서버 하나와 주기 루프 네 개로 이뤄진다.

| 루프 | 주기 | 호출 | 비고 |
|---|---|---|---|
| sync | 1초마다 점검. 부팅 시, `backgroundIntervalMs`(60초)마다, 미처리 웹훅이 있을 때 실행 | `reconcileCandidates` | 웹훅은 변경 알림일 뿐이고, 판단은 Jira 재조회로 한다. 웹훅은 이벤트 종류·이슈·프로젝트·바뀐 필드만 저장하고, 댓글 이벤트와 workspace 밖 프로젝트 이벤트는 깨우지 않는다(ADR 0038). 실패 후 10초 backoff |
| verify | `activeJobPollIntervalMs`(5초) | `verifyActiveJobs` | leased/running job의 승인을 Jira에서 재확인. sync와 같은 lane |
| reports | 2초 | `processReportJournal` | `report_steps` 저널을 진행 |
| leases | 5초 | `expireLeases` | 워커 API 호출 시에도 정리 |

재시작해도 아무것도 재개하지 않는다. 임대는 SQLite에 있고, 만료되면 시작 전이면 재대기,
시작 후면 `recovery_required`다(ADR 0020).

## 승인과 배정

워크플로는 하나다(ADR 0044, 0047). 사람이 상태를 옮겨 위임하고, 모든 위임은 계획부터 하며, 사람이 승인한 계획만
실행한다. 라벨은 위임·승인·철회에 쓰이지 않는다(ADR 0046). 예전 `workflow.mode`·`planningStatus`·
`needsDecisionStatus`·`planReviewStatus` 설정은 검증 오류다.

1. 후보: workspace의 요청 상태만 조회한다. 승인된 계획의 구현은 Router의 계획·배포 기록으로 찾는다
   (아래 "위임과 계획 승인"). v4 메타 이슈 라벨은 제외한다.
2. 승인 id: 영속 계획 요청 ID(상태 진입·입력 수정·유효한 답변·명시적 재시도), 또는 계획 승인 전이 사건(구현)이다.
   입력 hash(v2, ADR 0035)는 job 종류·제목·설명·실행 계약·plan-task 위치로 만든다. 댓글·라벨·상태·Assignee는
   포함하지 않는다. 계획은 GGJIRA 관리 블록을 제외한다. 번호 답변은 해시 대신 별도 새 요청으로 식별한다.
   v1 해시로 찍힌 job은 입력이 바뀐 것으로 본다. 구현 중 입력 변경은 취소·승인 보류(`admin_holds`)이며,
   AI 검토 중 입력 변경은 이전 계획 작업을 취소한 뒤 새 요청으로 다시 계획한다.
3. 실행 계약(ADR 0047): 구현이 따르는 완료 조건·검증·범위·허용 경로·의존성은 사람이 승인한 계획에서
   온다(`src/pm/contract.ts`). Router가 저장한 계획 결과(`plan_reviews` → `results`)를 읽고, 설명에 렌더링한 절은
   다시 파싱하지 않는다. 하위 작업은 그 작업을 정의한 계획에서, 의존성은 Router가 생성 시 기록한
   `ggjira.plan-task`의 이슈 키에서 읽는다. 계획 요청에는 계약이 없다.
4. `RuleDecisionProvider`: 인간 Assignee, 계획 버전(부모의 현재 계획일 때만), 의존성, 실행-Agent
   필드 고정을 본다. 결과는 `planning | implementation | wait | human | ignore`다. 완료 조건이나 검증이 빈 계획은
   애초에 적용되지 않으므로 구현 단계의 계약 보류는 없다.
5. 배정: queued job을 생성 순서대로 처리한다. 조건은 관리자 정책(`workers[]`)과 워커가 보고한
   저장소의 교집합이다. 워커당 동시 1개다. 후보는 LLM 플랜 여유가 많은 순, 그다음 가장 오래
   배정받지 않은 순이다. 리셋 전 100%인 한도 창이 있는 워커는 건너뛴다(ADR 0029,
   `scheduling.usage`). `jobs/next`에서는 요청한 워커만 받을 수 있고, 여유가 더 많은 유휴 워커가
   있으면 양보한다.
6. 관리자 hold: `jobs cancel`을 한 승인은 다시 배정하지 않는다(`admin_holds`, ADR 0022).
7. Jev 관찰 평가(ADR 0030): `TYPESAFE_API_KEY`가 있으면 `assess` 루프가 새 job마다 모델 등급과
   준비 상태를 Jev에 묻고 `job_assessments`에 기록한다. 아직 어떤 결정에도 쓰지 않는다.

### 자식 승인과 부모 통합 PR (ADR 0056)

자식은 각각 수동 승인하고 격리된 worktree에서 구현·자체 검증한 뒤 결과 커밋을 원격에 보존한다.
자식별 PR은 생성하지 않으며, 선행 의존 작업의 완료 커밋을 합친 불변 SHA에서 후행 구현을 시작한다.
모든 현재 자식의 최신 승인·검증 결과가 준비되면 일반 Worker 큐에 `assemble_pr`를 예약한다.
이 작업은 AI 호출이나 통합 검증 없이 의존 순서로 커밋을 모아 부모 PR 하나를 게시한다.
`assembly_runs`와 `job_inputs`에 계획·결과 ID·커밋 목록을 고정한다. 충돌은 보고 후 승인된 수정 작업으로 해결한다.
자식은 구현 완료, 부모는 PR 게시 후 통합 대기다. 실제 병합 SHA에서 신뢰된 통합 검증이 통과해야
부모를 구현 완료로 옮긴다. 선택적 FCI는 병합 후 독립적으로 실행하며 Done은 수동이다.
Router/Worker protocol 8과 migration 23를 함께 적용한다. 구 정책 설명은 ADR 0056으로 대체한다.

### 기존 v1 위임과 계획 승인 (ADR 0044, `src/router/delegation.ts`)

1. 위임: `requestStatus`(AI 검토) 진입, 제목·설명 변경, 담당자의 선택지 번호 답변 또는 실패 후 `재시도` 댓글이
   새 계획 요청이다(ADR 0050). migration 16의 `planning_requests`에 진입 ID·입력 해시·원문 스냅샷·답변·소스 댓글을
   영속화하고 동일 요청을 한 번만 실행한다. 계획·질문·승인 대기는 모두 요청 상태에 남는다. `plan_reviews`에
   계획 버전·요청 승인 id·outcome·task id를 남긴다(migration 14). 실행 단위(하위 작업, 없으면 부모)마다 완료
   조건과 검증이 없는 계획은 적용하지 않고 실패로 보고한다(ADR 0047).
2. 승인: reconcile이 Router가 아는 열린 계획의 이슈만 다시 읽는다. 공용 '작업 중'을 검색하지 않는다. 최신 요청
   이후의 마지막 `requestStatus → inProgressStatus` 이동이 최신 `planned` 계획에 대한 것이고, 관리자 hold가
   없으며, 이동 전에 계획 반영이 완료됐고 입력·버전이 같으면 `plan_deployments`에 한 번 기록한다. 반영 완료 시
   관찰한 changelog ID를 보존해 조기 이동이 나중에 도착한 계획의 승인이 되는 것을 차단한다. 댓글은 구현을 승인하지 않는다.
   승인이 아닌 이동은 댓글 1회와 `plan_approval_refused` 주의 항목만 남긴다.
   담당자가 없는 이슈는 요청이든 승인이든 실행하지 않는다. 승인 id마다 한 번 댓글을 달고 `unassigned` 주의
   항목을 남기며, 담당자가 생겨 job이 만들어지면 해소한다(`src/router/scheduler.ts` `holdUnassigned`).
3. 실행:
   - 하위 작업이 없는 계획: 부모가 implementation job이다(승인 id = 배포 승인).
   - 하위 작업이 있는 계획: 활성화 저널이 하위 작업을 '작업 중'으로 옮긴다. 하위 작업은
     `<배포 승인>#<taskId>@<작업 중 진입>` 승인으로 구현된다. 계획을 다시 하지 않는다.
   - 의존성은 done 또는 F01 확인으로만 풀린다. 모든 하위 작업이 완료되면 부모가 결과 검토로 간다.
4. 철회: 부모가 '작업 중'을 벗어나면 배포가 철회된다. 열린 job은 verify·reverify에서 취소되거나 중단 요청을
   받는다. Worker API는 배포가 `active`인지 DB에서 본다. 저널의 전이 단계는 `approvalRule`(`plan-approval`·
   `plan-task`)로 같은 승인을 다시 계산한다.

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

프로토콜 4(ADR 0051, 0052)는 기존 구현 계약에 `integration`, `qualityContext`, `quality`와 `quality_review`를 추가한다.
Router와 Worker는 버전 불일치를 실행 전에 거절한다. 구현 envelope는 승인된 범위 계약(`executionContract`)을 담는다. 구현 워커는
provider의 최종 구조화 응답(`ImplementationReport`: outcome, 이탈, 결정, acceptance별 검증)을 받고, 커밋
전에 변경 경로를 `allowedPaths`와 대조한다. 결정 필요·의미상 이탈·경로 이탈이면 commit·push·PR 없이
patch와 worktree를 남기고 `needs_decision`으로 보고한다. 보고를 읽을 수 없거나 검증 근거가 없거나 실패한
검증이 있으면 `failed`다.

결과는 `git {base/head, committed}`와 에이전트의 의미상 위험(`risks`)도 담는다(ADR 0040). Router는 적용한
결과마다 검토 대상(`review_targets`: issue·job·attempt·승인 id·입력 해시·base/head·분류와 근거)을 결과 저장과
같은 트랜잭션에서 남기고, 같은 이슈의 이전 대상은 이력으로 돌린다(`src/router/review-gate.ts`). 분류는
`immediate`(실패·결정·이탈·고위험·`not_verified`·커밋 없음·커밋 미보고) 또는 `standard`다. 고위험은 workspace
`review.highRiskPaths`와 실제 변경 경로의 대조, 그리고 에이전트 보고로 판단하고, 규칙 해시를 설정 버전으로 남긴다.
PR 머지는 그 머지의 head가 최신 대상의 head와 같을 때만(또는 head를 비교할 수 없을 때) 완료로 옮기고,
`review_records`에 actor·인증·head·일치 여부를 남긴다. 사람의 판단(확인·보류·재작업 요청)도 검토 화면·CLI에서
현재 대상에만 `review_records`로 남는다. 판단은 기록일 뿐이며 상태 이동·머지·승인을 만들지 않고, 보류와 재작업
요청만 Jira 댓글 하나를 남긴다(ADR 0043, `src/router/review-judgment.ts`).

결과의 `execution`은 provider 호출 하나를 기록한다(ADR 0042). Router는 저장한 결과마다(늦게 와 적용하지 않은
결과 포함) `execution_records`에 결과 id 기준으로 한 번 남긴다.

모든 변경 요청은 identity, session, attempt 소유, lease token, 임대 신선도를 한 트랜잭션에서
검증한다. 오류는 다른 워커 403, 만료·오래된 권한 409, 프로토콜 불일치 426이다.

## Jira 보고 저널 (ADR 0021)

결과의 사건은 같은 트랜잭션에서 `attention_items`에 기록된다(ADR 0041). 같은 미해결 사건의 반복이면 그 결과의
댓글 단계는 저널에 넣지 않는다. 막힌 단계는 보고 처리 뒤 주의 항목이 되고, 재시도로 반영되면 해소된다.

```
start 허가 ──▶ [start:<attempt>]   계획: "계획 시작" 댓글 (상태는 옮기지 않는다)
result 저장 ─▶ [<resultId>]         구현 성공: 댓글 → 실패 라벨 제거 → reviewStatus
                                    실패: 댓글 + ggjira-failed (실행하던 상태 유지)
                                    결정 요청: 계획은 댓글만(AI 검토 유지), 구현은 댓글만(작업 중 유지)
                                      (계획: plan.decision / 구현: 이탈·결정·증거 위치, ADR 0036)
                                    계획: 부모 계획 블록 → 하위 이슈 생성(마커) → plan-task
                                          → ggjira.plan → superseded → 댓글(AI 검토 유지)
계획 승인 ───▶ [deploy:<id>]        승인 댓글 → 하위 작업을 inProgressStatus로
하위 작업 완료 ▶ [deploy-done:<id>]  부모 → reviewStatus
중단 확인 ───▶ [recovered:<attempt>] "적용된 것 없음" 댓글
```

상태 전이 단계는 승인 상태·approvalId와 승인 규칙을 기록하고 실행 직전 재검증한다.
폐기된 라벨 승인 필드가 있는 과거 전이는 skipped로 남기고 자동 재실행하지 않는다. 각 단계는 쓰기 전에 Jira를 다시 읽는다. 결과가 불명확한 쓰기는 `uncertain`으로 두고 재조회로
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
| `router usage` | `GET /executions` | 결과마다 provider 호출(모델·호출 id·종료 사유·토큰·비용)과 원래 요구사항·실행 유형·원인 분류. 미보고는 NULL(ADR 0042) |
| `router attention` | `GET /attention` | 주의 항목(실패·결정·범위 이탈·개별 검토·계약 보완·막힌 보고). 같은 사건은 횟수로 묶고 해소·재발 이력을 남긴다(ADR 0041) |
| `router issue reviews` | `GET /issues/:key/reviews` | 검토 대상(최신·대체됨)과 PR 머지·판단 기록. 읽기 전용(ADR 0040) |
| `router issue show` (웹 UI 이슈) | `GET /issues/:key` | 현재 상태·보류 이유·위임 단계의 읽기 전용 조회 |
| `router reviews` (웹 UI 검토) | `GET /reviews` | 판단을 기다리는 현재 검토 대상(`pending`·`held`). 분류·상태·책임자·부모로 거름(ADR 0043) |
| `router reviews judge` | `POST /reviews/:targetId/judgments` | 확인·보류·재작업 요청 기록. 오래된 대상은 409. 상태 이동·머지·승인 없음(ADR 0043) |
| `router reconcile` | `POST /reconcile` | sync lane에서 즉시 1회 실행 |
| `router backup` | `POST /backup` | SQLite online backup을 `<db dir>/backups/`에 저장 |
| (웹 UI) | `GET/PUT /config`, `POST /config/apply`, `POST /check` | 설정 파일 조회, 검증 후 저장(`.bak`)과 즉시 적용, 손으로 고친 파일 적용, 저장된 설정으로 `router check` |

## 워커 시작 (`worker start`, ADR 0025)

`workers/register` 응답에는 워커 프로필(providerId, 저장소 id·`cloneUrl`·`baseBranch`)이
함께 온다. `worker start`(`src/worker-runtime/start.ts`)는 처음 실행될 때 터미널에서 Router 주소, LLM CLI,
페어링 코드, 저장소 폴더를 차례로 묻고 이 프로필로 워커 설정을 쓴다. `cloneUrl`이 있는 저장소는
`<dataDir>/repos/<id>`에 clone하고 바로 실행한다. Router는 URL만 주고, 로컬 경로와 검증 명령은 워커가 정한다. 성공한 작업 브랜치는 워커 설정의 `pushRemote`(기본 `origin`)에 push하고,
push 직전에 `authorize`(stage `push`)로 권한을 다시 확인한다(ADR 0026). GitHub 원격이고 `createPullRequest`면 워커가
`gh`로 PR을 열어 결과에 담는다. Router는 이를 `pull_requests`에 기록하고, `/webhooks/github`(HMAC 검증) 또는
5분 폴링으로 병합을 알게 되면 고정된 병합 SHA의 통합 검증을 예약한다. 자식 변경은 모두 완료된 뒤
`assemble_pr`에서 부모 PR 하나로 게시한다. `doneStatus`로 자동 이동하지 않는다(ADR 0056).
폴링이 실패한 PR은 `pull_request_unchecked` 주의 항목이 되고(PR마다 하나, 다음 성공이나 PR 종료 때 해소),
`router check`는 config의 GitHub `cloneUrl`과 이미 기록된 PR의 저장소마다 PR 목록을 읽을 수 있는지 확인한다.
워커가 쓰는 PR 본문은 Router 설정을 모르므로 "머지하면 완료"라고 단정하지 않는다.

## 웹 UI와 셋업 모드 (ADR 0023)

`router serve`는 `web/router-ui/`(빌드 없는 정적 HTML/JS)를 `/ui/`에서 서빙한다(`src/router/web-ui.ts`).
화면은 대시보드(`/status`), 워커(5초 폴링, 페어링 코드, enable/disable/revoke, LLM 플랜 사용량),
이슈(AI 참여 확인·켜기/끄기, ADR 0039), 설정 편집, Jira 점검이다.
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
| router (reports) | `report_steps.status`·`last_error`, `router reports list`, 댓글 문장 `src/router/comment-text.ts`(`reporting.language`, 기본 ko), 실패 코드 `GGJ-xxx`(`src/router/failure-codes.ts`, runbook §35)와 실패 전문 `data/failure-logs/<이슈>-<attemptId>.log`(ADR 0048) |
| router (leases) | 로그 `leases expired`, job `recovery_required` |
| jira | `JiraApiError`(status, endpoint), 429는 `Retry-After` 준수 |
| worker-runtime | 로그 `layer:"worker-runtime"`, spool 파일, 결과의 `failureReason` |
| worker | provider `exitReason`(completed/nonzero/timeout/crashed), 검증 명령 결과 |

## Provider 경계

`WorkerProvider`(`src/worker/provider.ts`)에 구현이 두 개 있다. 워커 설정 `providers[]`의 id로
고르고, Router는 envelope에 `providerId`만 담는다.

- `ClaudeCodeCliProvider`: `claude -p --output-format stream-json`을 쓴다. 구조화 출력은
  `--json-schema`로 요청하고 result 이벤트의 `structured_output`을 우선 읽는다. 시스템 프롬프트는
  `--append-system-prompt`로 넘긴다.
- `CodexCliProvider`: `codex exec --json --output-last-message <file>`을 쓴다. 시스템 프롬프트와
  스키마는 프롬프트 본문에 넣는다. 실제 `codex` CLI로는 아직 검증하지 않았다(ADR 0010).
  `providers[].model`이 없으면 `-m`을 넘기지 않아 Codex 자신의 설정(`~/.codex/config.toml`)이 고른 모델을
  쓴다. ChatGPT 계정 로그인은 제공하지 않는 모델을 거절하기 때문이다. Claude Code의 기본 모델은 `sonnet`이다.

프로세스 제어는 `src/worker/spawn.ts`가 한다. timeout이 나면 트리 종료를 요청하고 5초 뒤 강제
종료한다. Windows는 `taskkill /T`, POSIX는 프로세스 그룹을 쓴다. Windows에서는 명령 이름을
PATH·PATHEXT로 찾고, npm `.cmd` 셰임이면 그 Node 스크립트를 직접 실행한다(셸을 거치지 않는다).
`FakeWorkerProvider`는 테스트 전용이다.

## 배포

- Router는 `Dockerfile`(Node 24) + `docker-compose.yml`(router + Caddy)로 배포한다. DB는 named
  volume `/data`, 설정과 secrets 파일은 쓰기 가능한 `./deploy/config:/config`, TLS는 Caddy가 맡는다. 운영 절차는 [runbook](./runbook.md) §16~§18에 있다.
- Worker는 Windows·Linux 네이티브로 `ggjira worker run`을 실행한다. Router URL은 HTTPS여야 하고,
  loopback만 예외다.
- `docker compose -f docker-compose.test.yml run --rm --build check`는 Linux에서 check 전체를
  돌린다. 여기에는 Router 하나와 Fake 워커 둘의 통합 시나리오가 포함된다.

## 계획 결정 답변 (ADR 0049)

계획의 결정 요청은 선택지를 1부터 번호로 표시한다(ADR 0049, 0050). 담당자는 번호만 댓글로 남긴다.
Router는 최신 미응답 질문의 `decisionOptions:` 매핑으로 원래 optionId를 복원하고, 범위 밖 번호는 무시한다.
현재 담당자의 첫 유효 답변만 자동 재계획을 시작한다. 일반 댓글은 자동 실행 신호가 아니다. 댓글 이벤트는
재평가를 깨우며, 누락은 polling으로 복구한다. Router 댓글은 보고 마커로 제외해 공유 Jira 계정에서도 반복 실행을 막는다.
PM 입력에는 답과 함께 최신 질문·선택지를 전달한다. 이전 ID 답과 자유 서술 답은 유지한다.

## 기능별 AI 프롬프트

관리자 API `GET /api/v1/admin/prompts`와 `설정 → 프롬프트`는 플랜·구현·기술부채 변화 설명의 기본 지침, 추가 지침, 합성 입력 예시, 출력 스키마를 제공한다. `PUT /api/v1/admin/prompts/:role`은 역할별 추가 지침만 Router 설정에 저장하고 실시간 반영한다. 실행과 화면은 같은 builder를 사용하며, 최초 전달한 시스템 지침은 `attempt_prompts`에 고정하여 재전송이나 재시작 후에도 유지한다. 통합 검증은 AI를 호출하지 않는다(ADR 0054, 기존 읽기 전용 정책 ADR 0045 대체).

## 상태 기반 위임만 지원 (ADR 0046, 0047)

라벨 기반 참여·승인·철회와 라벨 이관 경로, legacy 워크플로와 legacy → delegation 이관 도구는 제거했다.
폐기된 `mode`·opt-in·계획 요청·결정 상태 설정은 검증 오류이고, 자동으로 다른 설정으로 바꾸지 않는다(runbook §34).
이슈 진단은 `GET /api/v1/admin/issues/:key`로 위임 단계만 읽는다. 과거 opt-in 승인 정보가 포함된 미완료 상태
전이는 재실행하지 않고 skipped로 남겨 운영자가 대조한다. 구현 요청 준비 보류(ADR 0034의 보류)는 없어졌고,
migration 15가 열려 있던 보류와 그 주의 항목을 닫는다. 일반 실패·대체·메타 라벨은 위임 기능과 별개로 유지한다.


## FCI 분석과 시계열

FCI는 일반 Jira job과 분리된 큐·attempt·커밋 캐시·보고 outbox를 사용한다. Worker가 정적 구조를 계산하고 Router가 이력과 보고를 관리한다. 시작 커밋부터 대상 브랜치 first-parent 이력을 수동 보충하고 새 커밋은 자동 평가한다. AI는 사용자가 선택한 커밋의 설명만 담당한다. 정적 점수·단일 그래프·범위 실행은 ADR 0057을 따른다. 자세한 데이터·계산·언어 범위·실패 정책은 [FCI 문서](./fci.md)와 [ADR 0056](./decisions/0056-parent-aggregate-pr.md)을 따른다. 과거 리뷰 생명주기 설명보다 ADR 0056이 우선한다.
