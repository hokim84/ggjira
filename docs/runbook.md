# Runbook

GGJIRA v5(Router + Worker) 운영·진단 절차다. §1~§12(v4 폴링 에이전트)는 그 코드와 함께 5단계에서
삭제했다(ADR 0022). 이력은 git에 있다. 번호는 다른 문서가 참조하므로 그대로 둔다.

먼저 볼 곳:

- `ggjira router status`는 큐 대기, 워커 연결, recovery 대기, 웹훅 지연, 막힌 보고를 보여 준다.
- `ggjira router jobs show <jobId>`는 attempt, 보고 단계, 감사 기록을 보여 준다.
- Router 로그의 `layer:"router"`에서 `pass:"reconcile"`의 `held`/`skipped`는 job이 생기지 않은
  이유이고, `report journal pass`의 `blocked`는 Jira 반영이 막힌 곳이다.
- 워커 로그는 `layer:"worker-runtime"`, 결과 spool은 `<dataDir>/spool/*.json`이다.

## 13. Windows에서 `npm run test`/`npm run check`가 멈출 때

일부 Windows 개발 환경(특히 백신 실시간 검사가 활성화된 경우)에서는 vitest의 기본
`threads` pool이 `better-sqlite3` 네이티브 애드온을 여러 worker thread에서 동시에 로드하며
멈춘다 — CPU 사용량이 0으로 고정된 채 아무 진행도 없는 것이 특징이다(프로세스가 죽지도,
진행하지도 않는다). CI(`ubuntu-latest`, `.github/workflows/ci.yml`)와 Linux 컨테이너(§16의 `docker-compose.test.yml`)에서는 재현되지 않으므로
`vitest.config.ts`는 건드리지 않는다.

이 증상을 보이면 로컬에서만 다음처럼 실행한다:

```bash
npx vitest run --pool=forks --poolOptions.forks.singleFork
```

병렬성이 없어 전체 스위트가 조금 느려지지만(로컬 기준 약 20-30초), 안정적으로 끝까지
실행된다. `test/worker-claude-code-cli.test.ts`, `test/worker-codex-cli.test.ts`의
`spawn EFTYPE` 실패 8건은 이 워크어라운드와 무관한, 이 환경에서 `.sh` fixture를 직접
spawn하지 못하는 별개의 기존 문제다(아직 원인 조사 전이다). Linux에서는 이 fixture가 그대로 실행된다.

`singleFork`로도 멈추는 경우가 있다(2026-09-23, 변경 전 HEAD에서도 재현). 그때는 파일마다 별도
프로세스로 실행하고, 제한 시간에 걸린 파일만 다시 돌린다. 한 파일씩은 안정적으로 끝난다.

```bash
for f in test/*.test.ts; do timeout 60 npx vitest run "$f" || echo "FAILED/TIMEOUT $f"; done
```

## 14. Router Worker API 진단 (ADR 0020)

- **워커 등록이 `401 invalid_pairing_code`** — code가 없음·만료(10분)·이미 사용됨 중 하나다.
  응답은 일부러 구분하지 않으므로 `pairing_codes` 테이블의 `expires_at`·`used_at`을 본다.
  `403 unknown_worker`면 code 발급 뒤 Router 설정 `workers[]`에서 그 `workerId`가 빠졌다.
- **워커가 작업을 받지 못함(`jobs/next`가 계속 204)** — `workers` 행에서 `current_session_id`,
  `last_heartbeat_at`(15초 이내여야 함), `revoked_at`, 설정의 `workers[].enabled`를 확인한다.
  `router workers list`의 STATE·DECLARED·ENABLED 열이 이 값들이다. `ENABLED no`는 관리자가
  `workers disable`한 것이다(`workers enable`로 해제).
  배정은 설정의 허용 capability·저장소와 워커가 보고한 값(`reported_*`)의 교집합으로만 한다.
- **`409 stale_session`** — 같은 워커 credential로 다른 프로세스가 세션을 새로 열었다.
  최신 세션만 유효하다. 워커 runner는 이 응답을 받으면 세션을 다시 연다.
- **`409 stale_lease`/`lease_expired`** — 임대(30초)가 갱신되지 않았다. 시작 전이면 job이
  `queued`로 돌아가고, 시작 후면 attempt·job이 `recovery_required`로 멈춘다.
- **`recovery_required`에서 멈춘 job** — 자동 재배정하지 않는다(ADR 0021). 워커가 그 attempt의
  결과를 늦게라도 제출하면 중단 확인으로 보고, 결과는 적용하지 않은 채(`applied = 0`) job을
  `cancelled`로 닫는다. 이때 Jira에 "적용된 것 없음" 댓글이 달린다. 워커가 돌아오지 않으면 작업
  폴더와 프로세스가 실제로 멈췄는지 워커 머신에서 확인한다. 그다음 `ggjira router jobs resolve <jobId>`
  (닫기) 또는 `ggjira router jobs retry <jobId>`(Jira 승인 재확인 후 새 attempt)를 실행한다. 둘 다
  `audit_log`에 남는다. `jobs cancel`은 `recovery_required`를 거부한다(중단 확인이 먼저다).
- **결과가 반영되지 않음** — `results.applied = 0`이면 늦게 도착한 결과다(대체된 attempt,
  이미 닫힌 job). 워커 쪽에 결과가 남아 있으면 spool 디렉터리의 `<resultId>.json`이며, 다음
  시작 때 재전송된다. `409 result_conflict`는 같은 `resultId`에 다른 내용을 보낸 것이다.

## 15. Router Jira 반영이 멈추거나 이상할 때 (ADR 0021)

Router의 Jira 쓰기는 `report_steps` 저널을 `router serve`의 reports 루프(2초)가 실행해야 일어난다.

- **이슈가 요청 상태에서 `inProgressStatus`로 안 넘어감 / 결과가 Jira에 안 보임** —
  `report_steps`에서 그 job의 행을 본다. `pending`/`uncertain`이면 아직 실행되지 않았거나 Jira가
  응답하지 않은 것이다(`last_error`, `tries`). 다음 패스에서 이어진다.
- **`skipped`** — 정상적인 보류다. 사람이 이미 상태를 바꿨거나(`a human moved it`) 재승인된
  이슈다. Router는 사람이 바꾼 상태를 덮어쓰지 않는다.
- **`failed`** — Jira가 명확히 거부했다(4xx, 도달할 수 없는 상태 전이 등). workflow나 권한을
  고친 뒤 `ggjira router reports list`로 배치 id를 찾고 `ggjira router reports retry <batchId>`로
  그 배치의 막힌 단계만 다시 대기시킨다. 워커는 다시 실행되지 않는다.
- **`recovery_required`인 `create-subtask`** — 하위 이슈 생성 응답을 잃었고 마커로 찾지도
  못했다. 부모의 하위 이슈에서 설명 첫 줄이 `[GGJIRA:REPORT:<단계 id>]`인 이슈가 있는지 확인한다.
  확인 후 배치를 재시도하면 단계가 마커를 먼저 찾으므로, 이미 생성된 이슈는 다시 만들지 않는다.
- **실패한 이슈** — `inProgressStatus`에 `ggjira-failed` 라벨과 실패 댓글이 남는다. 다시 돌리려면
  요청 상태로 옮긴다. 이전 job은 닫히고 새 job이 만들어진다.
- **계획이 적용되지 않음** — 적용할 수 없는 계획(작업 수 초과, taskId 중복, 의존성 순환·미해결)은
  실패 댓글로 보고한다. 하위 이슈가 실행되지 않으면 `ggjira.plan-task`의 `planVersion`이 부모
  `ggjira.plan`의 `version`과 같은지 본다. 재계획 뒤의 옛 작업은 승인되지 않는다.

## 16. Router 배포 (Docker Compose, ADR 0022)

준비물은 공인 DNS가 이 서버를 가리키는 도메인, 80/443 포트, Docker Engine + Compose다.

```bash
cp deploy/router.config.example.json deploy/router.config.json   # Jira URL, workspaces, 상태, workers
cp deploy/router.env.example deploy/router.env                   # JIRA_*, GGJIRA_* 비밀정보
export GGJIRA_DOMAIN=router.example.com
docker compose up -d --build
docker compose exec router node dist/cli.js router check         # Jira 상태·전이 확인
docker compose logs -f router
```

- `router.config.json`의 `db.path`는 `/data/router.sqlite3`(volume), `http.host`는 `0.0.0.0`으로
  둔다. 컨테이너 밖에 포트를 열지 않고 Caddy만 443으로 받는다.
- webhook secret·admin token은 `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
  로 만든다(16자 이상).
- Jira 관리자 웹훅은 URL `https://<도메인>/webhooks/jira`, secret은 `GGJIRA_WEBHOOK_SECRET`로
  만든다. 이벤트는 이슈 생성·수정·삭제와 댓글, 필터는 프로젝트 기준이다. 요청 상태로 거르지 않는다.
  그래야 승인 철회도 들어온다.
- 관리 명령은 컨테이너 안에서 `docker compose exec router node dist/cli.js router <명령>`으로
  실행한다. 밖에서 실행하려면 `--url https://<도메인>`과 `GGJIRA_ADMIN_TOKEN`을 준다.
- 웹훅이 안 들어오면 `router status`의 webhook delay가 `-`로 남는다. 이 경우에도 60초 보완 조회로는
  계속 진행된다. Caddy 로그와 Jira 웹훅 화면의 전달 기록을 본다. `401 invalid signature`면 secret이
  서로 다르다.

## 17. 백업과 복원

백업은 Router가 도는 중에 한다. 결과는 볼륨 안 `/data/backups/router-<UTC시각>.sqlite3`다.

```bash
docker compose exec router node dist/cli.js router backup
docker compose cp router:/data/backups ./router-backups      # 서버 밖으로 옮겨 보관
```

복원 순서:

1. `docker compose stop router`로 Router를 멈춘다. 워커는 그대로 둬도 된다. 연결 실패를 재시도하다가
   다시 붙는다.
2. 볼륨의 `/data/router.sqlite3`를 백업 파일로 교체하고, 같은 이름의 `-wal`·`-shm` 파일을 지운다.
   예시는 아래와 같다.
   `docker compose run --rm --entrypoint sh router -c "cp /data/backups/<파일> /data/router.sqlite3 && rm -f /data/router.sqlite3-wal /data/router.sqlite3-shm"`
3. `docker compose start router`로 다시 띄운다.

복원 후 동작은 다음과 같다(`test/router-daemon.test.ts` "backup and restore").

- 백업 시점에 미처리였던 웹훅은 다음 sync에서 처리된다. 그 사이의 변경은 부팅 시 전체 조회가 잡는다.
- 실행 중이던 attempt는 임대가 만료되어 `recovery_required`가 된다. 자동으로 다시 실행하지 않는다.
  워커 머신에서 실제로 멈췄는지 확인하고 `jobs resolve` 또는 `jobs retry`를 한다.
- 백업 이후 발급된 워커 token은 복원된 DB에 없으므로 401이 난다. 그 워커는 `router workers pair`와
  `worker setup --force`로 다시 연결한다.
- 미완료 보고 단계는 이어서 진행된다. 백업 이후에 이미 Jira에 반영된 댓글·하위 이슈는 마커 재조회로
  찾으므로 중복되지 않는다.

## 18. 워커 운영

```bash
ggjira router workers pair worker-1                      # Router 쪽: 1회용 code(10분)
ggjira worker setup --router https://router.example.com --pairing-code <code> --config worker.config.json
ggjira worker check --config worker.config.json          # credential, 저장소, provider CLI, Router 연결
ggjira worker run --config worker.config.json            # Ctrl+C 1회: 현재 작업 후 종료, 2회: 즉시 종료
```

- `worker setup`은 token을 `credentialPath`(기본 `data/worker-credential.json`)에만 쓴다. 설정
  파일·출력에는 남기지 않는다. 이미 있으면 `--force`가 필요하다.
- Router URL은 `https://`만 쓴다. `http://`는 `localhost`/`127.0.0.1` 개발용에만 허용한다.
- **spool에 결과가 남음**(`worker check`가 경고): `worker run`을 멈춘 상태에서
  `ggjira worker results retry`로 보낸다. 세션을 새로 열기 때문에 실행 중인 `worker run`의 세션을
  빼앗는다.
- **worktree 정리**: `ggjira worker worktrees prune --older-than-days 7 --dry-run`으로 먼저 본다.
  브랜치와 커밋은 지우지 않고 작업 폴더만 지운다. 자동 정리는 없다.
- **워커 교체·폐기**: `router workers revoke <id>`는 token을 바로 무효화한다. 실행 중이던 job은 임대
  만료 후 `recovery_required`가 된다(§14). 같은 id로 다시 쓰려면 `workers pair`와
  `worker setup --force`를 한다.

## 19. v4에서 전환

계획 §5 "운영 전환" 순서를 따른다. v4 설정(`ggjira.config.json`)과 `data/` 실행 기록은 지우지 않지만
v5는 읽지 않는다. `ggjira run` 같은 구형 명령은 대체 명령을 안내하고 종료한다.

1. 기존 에이전트(`ggjira run`)를 모두 멈추고, 진행 중이던 작업이 끝났는지 Jira와 `data/runs/`에서
   확인한다.
2. Router 설정을 새로 만든다. 상태 이름은 v4 설정의 `workflow`에서 옮긴다(`implementationStatus`는
   `requestStatus`가 된다). 실행-Agent 필드를 쓰면 `executionAgent.optionWorkerMap`에 옵션 id별
   workerId를 적는다.
3. `router check --issue <테스트 이슈>`로 상태·전이를 확인한다.
4. §16대로 Router를 올리고 웹훅을 연결한다.
5. 워커를 §18대로 pairing한 뒤 `router reconcile`을 실행한다.
6. 테스트 이슈 하나로 요청 → 작업 중 → 완료 상태를 확인한다.
7. 기존 에이전트의 자동 시작(작업 스케줄러 등)을 해제한다.
