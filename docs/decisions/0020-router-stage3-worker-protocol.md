# 0020. Router 3단계(Worker 통신·실행) 구현 판단

## Context

`docs/router-service-implementation-plan.md`의 3단계(pairing, 세션, long polling, start,
heartbeat, 취소, 결과 spool, 기존 provider·worktree 연결)를 구현하면서, 계획 §3의 계약만으로는
정해지지 않는 지점이 생겼다. 모두 4단계 이후 구현과 운영 진단에 영향을 주므로 근거를 남긴다.
[`0018-router-centric-architecture.md`](./0018-router-centric-architecture.md)와
[`0019-router-stage2-decisions.md`](./0019-router-stage2-decisions.md)를 구체화하며, 어느 것도
대체하지 않는다.

## Decision

1. **Pairing code가 워커 identity를 정한다.** 관리자는 Router 설정 `workers[]`에 선언된
   `workerId`에 대해서만 pairing code를 발급한다(`POST /api/v1/admin/pairing-codes`,
   10분 유효·1회용). 등록하는 워커는 자기 id를 주장하지 않고, code에 묶인 id를 받는다. 등록
   시점에 그 id가 설정에서 빠졌으면 `403`. 알 수 없음·만료·사용됨은 구분 없이 하나의 `401`로
   응답한다. 발급한 token은 SHA-256 hash만 저장한다(`src/router/db/pairing.ts`, `workers.ts`).

2. **세션은 최신 하나만 유효하다.** `workers/session`은 새 세션을 열고 이전 세션을 대체한다
   (`workers.current_session_id`, `worker_sessions.superseded_at`). heartbeat·`jobs/next`·
   `start`·job heartbeat·`authorize`는 현재 세션이 아니면 `409 stale_session`으로 거부하므로,
   중복 실행된 옛 워커 프로세스는 권한을 잃는다. 반면 `result`는 세션을 요구하지 않는다 —
   재시작한 워커가 spool을 새 세션으로 재전송해야 하고, token과 attempt 소유권만으로 충분하다.

3. **`cancel_requested` → `recovery_required` 전이를 허용한다.** 취소 요청은 프로세스가
   멈췄다는 증거가 아니다. 취소 요청 중 임대가 만료되면 attempt·job 모두 `recovery_required`로
   가고 자동 재배정하지 않는다(`src/contracts/attempt-state.ts`, `job-state.ts`,
   `src/router/leases.ts`). 임대 만료 판정은 별도 타이머 없이 모든 워커 API 호출 시작 시
   `expireLeases`로 수행한다(멱등, DB 기반).

4. **결과 적용 규칙.** 결과는 항상 `results`에 저장하되, 그 attempt가 job의 현재 attempt이고
   `running`/`cancel_requested`일 때만 상태를 바꾼다(`applied = 1`). 그 외(늦게 도착, 대체된
   attempt, 이미 닫힌 job)는 `applied = 0` 감사 기록으로만 남는다. 취소 요청이 있었으면 성공
   결과도 `cancelled`로 닫는다. `planned`/`needs_decision`은 실행 자체는 끝났으므로
   `succeeded`로 닫고, Jira에 무엇을 보일지는 4단계 보고 단계가 정한다. 워커가 스스로 멈춘
   `cancelled` 결과는 `running → cancel_requested → cancelled`로 기록한다.

5. **워커 재시작 시 실행 중이던 attempt는 재실행하지 않는다.** 세션 응답의 `pendingAttempts`
   중 `running` 상태이고 spool에 결과가 없는 것은 `failed`("worker restarted mid-run")로
   보고해 Router에 중단 확인을 준다. `leased`(시작 전)는 `jobs/next`가 그대로 다시 넘긴다.

6. **Envelope에는 id만 담는다.** Router 설정 `workers[].providerId`(기본 `"default"`)와
   `execution.timeoutMs`(기본 30분)가 envelope의 `providerId`·`timeoutMs`가 된다. 워커는
   `repositoryId`·`providerId`를 자기 로컬 설정에서 찾고, 모르는 id는 실행하지 않고 거부한다.

7. **Planning job은 아직 실행하지 않는다.** 3단계 워커(`src/worker-runtime/executor.ts`)는
   `kind: "implementation"`만 실행하고 `planning`은 `failed`로 돌려준다. PM context 수집과 계획
   적용 분리는 4단계 범위다.

8. **프로세스 트리 종료.** POSIX는 `detached` 프로세스 그룹에 `-pid` 시그널(SIGTERM → 5초 후
   SIGKILL), Windows는 `taskkill /T`(→ 5초 후 `/T /F`)를 쓴다(`killProcessTree`,
   `src/worker/spawn.ts`). 임대 상실(마지막 성공 heartbeat 요청 시작부터 20초), Router 취소,
   `authorize` 거부·실패(fail closed)가 모두 같은 경로로 중단한다.

9. **스키마 변경은 migration 2로 추가만 한다.** 1단계 `SCHEMA_STATEMENTS`는 수정하지 않고
   `WORKER_PROTOCOL_STATEMENTS`로 컬럼·테이블을 더한다. `jobs.input_hash`는 배정 시점의 입력
   hash를 고정해, 실행 중 설명·capability·의존성·계획 버전 변경을 감지해 취소를 요청하게 한다.

## Consequences

- `recovery_required`를 해제하는 관리자 경로(`jobs resolve`)는 5단계 관리 CLI 전까지 없다.
  그동안은 워커의 결과 제출(중단 확인)만이 attempt를 닫는 경로다.
- 임대 만료가 API 호출 때만 판정되므로, 워커가 하나도 접속하지 않으면 만료가 DB에 반영되지
  않는다. 동작에는 영향이 없지만(다음 호출 때 일괄 반영), 관측 시점과 실제 만료 시점이 다를 수
  있다. 주기 실행이 필요하면 5단계 `router serve`에서 타이머로 `expireLeases`를 호출한다.
- 결과 수신이 Jira 반영 작업을 만들지 않는다. 결과 저장과 Jira 반영 작업 생성을 한
  트랜잭션으로 묶는 것은 4단계에서 `submitResult`에 추가한다.
- Windows에서 `.sh` fixture를 쓰는 기존 CLI provider 테스트 8건은 여전히 `spawn EFTYPE`로
  실패한다(3단계 이전과 동일, runbook §13). 트리 종료 자체는 `node` fixture를 쓰는
  `test/worker-spawn-tree-kill.test.ts`가 두 플랫폼에서 검증한다.
