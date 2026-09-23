# 0022. Router 5단계: 운영 기능과 구형 구조 제거

## Context

`docs/router-service-implementation-plan.md` 5단계는 관리 CLI, Docker Compose, 백업·복원 절차를
추가하고 v2~v4 실행·설정·프로필 코드를 제거하는 단계다. 4단계까지 Router와 워커는 코드(테스트
하네스)로만 조립됐고, 주기 작업(`reconcileCandidates`·`verifyActiveJobs`·`processReportJournal`·
`expireLeases`)을 부르는 프로세스가 없었다. 계획 §4·§5만으로 정해지지 않는 지점을 여기 기록한다.

이 ADR은 다음 과거 결정을 **대체(superseded)**한다. 과거 ADR 파일은 이력으로 남긴다.

- [0001](./0001-polling-over-webhook.md) JQL 폴링 우선 → Jira 웹훅이 기본 입력이고, 보완 조회는
  Router만 한다.
- [0004](./0004-file-based-persistence.md) 파일 기반 저장 → 중앙 실행 상태는 Router SQLite다. 워커는
  결과 spool·worktree·로그만 로컬에 둔다.
- [0007](./0007-single-agent-runtime-with-roles.md) 역할(pm/implement)별 Agent Runtime → Router가
  planning/implementation job을 만들고, 워커는 kind와 무관하게 같은 runner로 실행한다.
- [0008](./0008-assignee-dispatch-and-transition-claim.md) Assignee dispatch·전이 claim, 로컬
  lease 파일 → Router의 SQLite 임대(`attempts`)와 워커 API의 start/heartbeat/authorize다.
  Assignee는 인간 책임자로만 남는다.
- [0011](./0011-config-v2-and-credentials.md) config v2~v4 → `configVersion: 5`(Router/Worker 분리)만
  읽는다. 구형 설정은 해석하지 않고 거부한다.
- [0012](./0012-agent-profile-in-jira.md) Jira Agent Profile·Workspace Configuration 이슈 → 워커
  정책은 Router 설정 `workers[]`, 등록은 pairing code, 식별은 Router가 발급한 token이다.
- [0013](./0013-prompt-layer-composition.md)의 Agent Profile preset·프로젝트 정책 레이어 → Router가
  envelope에 담는 system prompt만 남는다.
- [0014](./0014-capability-runtime-and-human-assignee.md)의 runtime claim·Assignee 매칭 → capability
  매칭은 Router 스케줄러의 워커 선택으로 옮겼다. "Assignee는 인간 책임자"는 유지한다.

## Decision

1. **구형 코드를 삭제한다(사용자 확인).** `src/agent/`, `src/implement/executor.ts`, `src/job/`,
   `src/poller/`, `src/profile/`, `src/reporter/`, `src/setup/`, `src/pm/apply.ts`·`executor.ts`,
   `src/config.ts`와 그 테스트를 지운다. Router·워커가 쓰는 순수 로직은 옮겨서 유지한다.
   - `src/issue/`: `capability.ts`·`requirements.ts`·`description.ts`. 이슈 설명의 GGJIRA 절 파싱과
     capability 매칭이다.
   - `src/worker/validate.ts`
   - `src/pm/`: 계획 스키마·메타데이터·렌더링·프롬프트·결정 답변 파싱

   PM 계획 스키마에서 `assigneeAgentId`·`agentProfiles`·`disableAgentIds`를 뺐다. 예전 출력에 이
   필드가 있어도 Zod가 버리므로 파싱은 실패하지 않는다. 후보 조회는 v4 메타 이슈 라벨(`ggjira-agent`,
   `ggjira-workspace`)을 계속 제외한다. 이 이슈들은 기존 프로젝트에 남아 있기 때문이다.

2. **CLI는 `ggjira router …`와 `ggjira worker …` 두 명령군이다.** 구형 명령(`run`, `once`, `setup`,
   `agent:*` 등)은 대체 명령을 안내하고 종료 코드 2로 끝난다. `setup` 명령들은 대화형 위저드가 아니다.
   - `router setup`: 시작용 설정 파일을 쓰고 새 webhook secret·admin token을 출력한다.
   - `worker setup`: pairing code로 token을 받아 credential 파일(0600)에 쓰고, 설정이 없으면 시작용
     설정도 쓴다.

   계획 §4 목록에 없는 명령 세 가지를 더했다.
   - `router status`: §5 관측 항목(큐 대기, 워커 연결, recovery 대기, 웹훅 지연, 보고 실패)
   - `router workers enable`: `disable`의 역
   - `router reports list`: `reports retry`에 넘길 배치 id를 찾는 용도

3. **관리 CLI는 항상 `/api/v1/admin/*`를 거친다.** 실행 중인 DB를 직접 열지 않는다(§4). 주소는
   `--url`, `GGJIRA_ROUTER_URL`, Router 설정의 `http` 순으로 정한다. 인증은 `GGJIRA_ADMIN_TOKEN`
   bearer다. CLI는 OS 사용자 이름을 `x-ggjira-actor`로 보내고, 감사 기록 actor는 `admin:<이름>`이다.

4. **`jobs cancel`은 그 승인에 대한 hold를 남긴다(migration 4, `admin_holds`).** 요청 상태에 있는
   이슈의 job을 취소해도 다음 reconcile이 같은 승인으로 바로 새 job을 만들면 취소가 무의미하다. 그래서
   `(issue, approvalId)`를 보류하고 reconcile은 사람 확인 대상으로 둔다. 사람이 Jira에서 다시 요청
   상태로 옮기면 approvalId가 바뀌어 실행된다. `recovery_required` job은 취소를 거부하고 `jobs resolve`를
   안내한다. 중단 확인이 필요하기 때문이다.

5. **워커 비활성화·폐기의 범위.**
   - `disable`: `workers.enabled` 플래그로 새 배정만 막는다. 설정의 `workers[].enabled`와는 별개이고
     둘 다 참이어야 배정된다.
   - `revoke`: token을 즉시 무효화하고 활성 attempt를 정리한다. 시작 전 임대는 대기열로 되돌리고,
     실행 중이면 `cancel_requested`로 둔다. 폐기된 워커는 heartbeat로 취소를 들을 수 없다. 워커는
     20초 임대 상실 watchdog으로 스스로 멈추고, Router에서는 임대 만료로 `recovery_required`가 된다.
     관리자가 확인 후 `resolve`한다.

6. **`router serve`는 한 프로세스에 HTTP 서버와 네 개의 주기 루프를 둔다**(`src/router/daemon.ts`).
   - sync: 부팅 시 전체 조회, `backgroundIntervalMs`마다, 그리고 미처리 웹훅이 있을 때 전체
     reconcile을 한다. 웹훅은 변경 알림일 뿐이고 판단은 Jira 재조회로 한다. 그래서 이슈 단위가 아니라
     전체 조회 한 번으로 여러 웹훅을 합친다. 이벤트는 그 뒤에 시작한 패스가 성공해야 처리 완료로 표시한다.
     실패 후 10초는 다시 시도하지 않는다.
   - verify: `activeJobPollIntervalMs`마다 실행한다. sync와 같은 lane에서 직렬로 돈다.
   - reports: 2초마다 보고 저널을 진행한다.
   - leases: 5초마다 만료 임대를 정리한다.

   서버는 평문 HTTP로 listen한다. TLS는 Compose의 Caddy가 종료한다.

7. **HTTP는 loopback에서만 허용한다(§5).** 워커 설정의 `routerUrl`은 `https://`여야 한다.
   `http://`는 `localhost`·`127.0.0.1`·`[::1]`에서만 허용하고, `worker setup`도 같은 규칙을 적용한다.
   Router가 loopback이 아닌 주소로 평문 listen하면 경고 로그를 남긴다.

8. **백업은 SQLite online backup API를 쓴다.** `router backup`이 관리 API를 거쳐 `db.backup()`으로
   `<db 디렉터리>/backups/router-<시각>.sqlite3`를 만든다. WAL 모드에서도 서비스 중에 일관된 사본이
   나온다. 복원은 Router를 멈추고 파일을 교체하는 운영 절차다(runbook). 복원 후 동작은 다음과 같다.
   - 미처리 웹훅은 다음 sync가 처리한다.
   - 실행 중이던 임대는 만료되어 `recovery_required`가 되고, 자동 재실행하지 않는다.
   - 미완료 보고 단계는 이어서 진행된다.

   이 순서를 테스트로 확인한다.

9. **Docker Compose는 Router와 Caddy 두 서비스다.** 이미지는 Node 24(`node:24-bookworm-slim`)
   멀티스테이지 빌드이고, DB는 named volume `/data`에 둔다. `Dockerfile`의 `test` 단계와
   `docker-compose.test.yml`은 Linux에서 `npm run check` 전체를 돌린다. 여기에는 Router 하나와
   Fake 워커 둘의 통합 시나리오(`test/router-integration.test.ts`)와 POSIX 프로세스 트리 종료
   테스트가 포함된다. 실제 Jira 없이 Router 컨테이너 하나와 워커 컨테이너 둘로 나눠 돌리려면 Fake
   Jira HTTP 서버가 필요하다. 그 비용 대신 같은 시나리오를 실제 HTTP(loopback)로 한 프로세스에서
   검증한다. `package.json`의 `engines.node`를 `>=24`로 올렸다.

## Consequences

- 실행 경로가 하나가 되었다. v4 설정(`ggjira.config.json`)과 로컬 `data/` 실행 기록은 삭제하지
  않지만 더 이상 읽지 않는다. 운영 전환은 계획 §5 "운영 전환" 순서로 새로 구성한다.
- 웹훅 한 건마다 전체 후보 조회를 한 번 한다. 이벤트가 몰리면 1초 단위로 합쳐지지만, 후보가 매우
  많은 프로젝트에서는 이슈 단위 reconcile이 필요해질 수 있다.
- sync와 verify가 같은 lane이라 긴 전체 조회 중에는 활성 job 확인이 그만큼 늦어진다.
- `jobs cancel`의 hold는 approvalId 단위라서, 같은 승인에서 설명만 바뀐 경우에도 보류가 유지된다.
  사람이 요청 상태로 다시 옮겨야 한다.
- Compose 통합 검증은 Docker 엔진이 켜진 환경에서만 돌릴 수 있다. 실제 Jira 웹훅·AI CLI 연동은
  계속 수동 smoke(`router check`, `worker check`, 테스트 이슈 1건)로 확인한다.
