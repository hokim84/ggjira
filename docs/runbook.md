# Runbook

GGJIRA v5(Router + Worker) 운영·진단 절차다. §1~§12(v4 폴링 에이전트)는 그 코드와 함께 5단계에서
삭제했다(ADR 0022). 이력은 git에 있다. 번호는 다른 문서가 참조하므로 그대로 둔다.

먼저 볼 곳:

- `ggjira router status`는 큐 대기, 워커 연결, recovery 대기, 웹훅 지연, 막힌 보고, 확인 필요 항목 수를 보여 준다.
  사람이 봐야 할 것은 `ggjira router attention`(§29)에 모인다.
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
mkdir -p deploy/config && sudo chown 1000:1000 deploy/config    # 컨테이너의 node 사용자가 씀
export GGJIRA_DOMAIN=router.example.com
docker compose up -d --build
docker compose logs router | grep -A1 "setup token"             # 웹 셋업(§20): 이 token으로 진행
# 또는 수동 설정:
#   cp deploy/router.config.example.json deploy/config/router.config.json
#   cp deploy/router.env.example deploy/config/router.env
docker compose exec router node dist/cli.js router check         # Jira 상태·전이 확인
docker compose logs -f router
```

- ADR 0023 이전 배포에서 옮겨 올 때: `deploy/router.config.json` → `deploy/config/router.config.json`,
  `deploy/router.env` → `deploy/config/router.env`로 옮기고 `docker compose up -d --build`한다.

- `router.config.json`의 `db.path`는 `/data/router.sqlite3`(volume), `http.host`는 `0.0.0.0`으로
  둔다. 컨테이너 밖에 포트를 열지 않고 Caddy만 443으로 받는다.
- webhook secret·admin token은 `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
  로 만든다(16자 이상).
- Jira 관리자 웹훅은 URL `https://<도메인>/webhooks/jira`, secret은 `GGJIRA_WEBHOOK_SECRET`로
  만든다. 이벤트는 이슈 생성·수정·삭제와 댓글, 필터는 프로젝트 기준이다. 요청 상태로 거르지 않는다.
  그래야 승인 철회도 들어온다.
- 관리 명령은 컨테이너 안에서 `docker compose exec router node dist/cli.js router <명령>`으로
  실행한다(admin token은 `/config/router.env`에서 읽는다). 밖에서 실행하려면
  `--url https://<도메인>`과 `GGJIRA_ADMIN_TOKEN`을 준다. 같은 일을 웹 UI `https://<도메인>/ui/`에서도 할 수 있다.
- 웹훅이 안 들어오면 `router status`의 webhook delay가 `-`로 남는다. 이 경우에도 60초 보완 조회로는
  계속 진행된다. Caddy 로그와 Jira 웹훅 화면의 전달 기록을 본다. `401 invalid signature`면 secret이
  서로 다르다.

## 16-1. Router 배포 (Cloudflare Tunnel)

`docker-compose.cloudflare.yml`은 Router와 `cloudflared`만 띄운다. 서버에 여는 포트가 없고, TLS는
Cloudflare가 맡는다. Caddy 구성(§16) 대신 쓴다. 준비물: Cloudflare에 연결된 도메인, Docker Engine + Compose.

**1. 터널 만들기** (Cloudflare 대시보드)
1. Zero Trust > Networks > Tunnels > Create a tunnel(Cloudflared)에서 이름을 정하고 토큰을 복사한다.
2. Public Hostname을 추가한다. 예: `router.example.com`, Service `HTTP` / `router:8787`.

**2. 서버에서 띄우기**
```bash
git clone https://github.com/hokim84/ggjira.git && cd ggjira
mkdir -p deploy/config deploy/data && sudo chown 1000:1000 deploy/config deploy/data
printf 'TUNNEL_TOKEN=%s\n' '<터널 토큰>' > deploy/config/cloudflared.env && chmod 600 deploy/config/cloudflared.env
# 설정: DB를 옮겨 올 거면 아래 4번을 먼저 한다. 새로 시작하면 웹 셋업(§20)이나 예시 파일 복사:
#   cp deploy/router.config.example.json deploy/config/router.config.json   # db.path "/data/router.sqlite3"
#   cp deploy/router.env.example deploy/config/router.env && chmod 600 deploy/config/router.env
docker compose -f docker-compose.cloudflare.yml up -d --build
docker compose -f docker-compose.cloudflare.yml logs -f router cloudflared
curl -s https://router.example.com/health                          # {"status":"ok","mode":"router"}
```
관리 명령은 `docker compose -f docker-compose.cloudflare.yml exec router node dist/cli.js router <명령>`로 실행한다.

**3. Cloudflare 설정** (빠뜨리면 웹훅과 워커가 막힌다)
- **봇 차단 예외**: Bot Fight Mode나 Browser Integrity Check는 브라우저가 아닌 요청을 막거나 확인
  페이지(HTML)를 돌려준다. 이 호스트에서 끄거나, Security > WAF > Custom rules에 다음 경로에 대해
  *Skip*(Bot Fight Mode, Browser Integrity Check, Security Level) 규칙을 둔다.
  `/webhooks/`, `/api/v1/workers/`, `/api/v1/jobs/`, `/health`.
  - 증상: 워커 로그에 403이나 `Router … answered 403`이 찍히고, Jira 웹훅 전달 기록이 403이다.
- **Access(권장)**: Zero Trust > Access > Applications에서 같은 호스트의 `/ui/*`와 `/api/v1/admin/*`에만
  로그인 정책을 건다. `/webhooks/*`, `/api/v1/workers/*`, `/api/v1/jobs/*`, `/health`에는 걸지 않는다(서명과
  토큰으로 따로 보호된다). Access를 걸면 서버 밖에서 관리 CLI(`--url`)를 쓸 수 없고, 서버 안의
  `docker compose exec`는 그대로 된다.
- **처음 띄울 때**: 설정이 없으면 셋업 마법사가 공개 주소로 열린다. Access를 먼저 걸거나, 설정 파일을
  넣고 시작한다.

**4. 로컬 Router에서 옮겨 오기**
두 Router를 동시에 켜 두지 않는다. 같은 Jira에 쓰므로 같은 이슈를 두 번 배정하고 댓글도 두 번 단다.
1. 로컬: `npm run dev -- router backup`을 실행하고 로컬 Router를 멈춘다. 백업은 `data/backups/`에 생긴다.
2. 서버로 복사한다. `deploy/data/router.sqlite3`(백업 파일), `deploy/config/router.config.json`,
   `deploy/config/router.env`. 설정의 `db.path`는 `/data/router.sqlite3`, `http.host`는 `0.0.0.0`으로
   고친다. 복사한 뒤 `sudo chown 1000:1000 deploy/data/* deploy/config/*`, `chmod 600 deploy/config/router.env`.
3. `docker compose -f docker-compose.cloudflare.yml up -d --build`. migration은 시작할 때 자동으로 된다.
4. 각 워커의 `worker.config.json`에서 `routerUrl`을 `https://router.example.com`으로 바꾸고 재시작한다.
   DB를 옮겼으면 워커 토큰이 그대로라 다시 페어링하지 않아도 된다. 새 DB로 시작했으면 웹 UI > 워커에서
   재페어링 코드를 받아 `worker setup --pairing-code … --force`를 실행한다.
5. 확인: 웹 UI의 워커가 "온라인"인지, 설정 > GitHub의 추적 중인 PR이 "확인 실패" 없이 보이는지.

**5. 웹훅 켜기** (공개 주소가 생겼으므로)
- Jira: URL `https://router.example.com/webhooks/jira`, secret은 `GGJIRA_WEBHOOK_SECRET`(§16과 같음).
- GitHub: `router.env`에 `GGJIRA_GITHUB_WEBHOOK_SECRET`을 넣고 재시작한 뒤 저장소 Webhooks에 등록한다(§21).
  폴링만으로도 5분 안에 반영된다.

**6. 운영**
- 백업: `router backup`은 `deploy/data/backups/`에 쓴다. 서버 밖으로 주기적으로 복사한다
  (예: `rsync`, cron). 이 디렉터리가 서버에만 있으면 서버와 함께 잃는다.
- 업데이트: `git pull && docker compose -f docker-compose.cloudflare.yml up -d --build`. 화면이 이상하면
  Cloudflare 캐시를 비운다(UI는 `cache-control: no-cache`라 보통 필요 없다).
- 비밀정보 파일(`router.env`, `cloudflared.env`)은 0600을 유지한다. 웹 UI에서 Jev 키나 GitHub 토큰을
  저장하려면 컨테이너 사용자(uid 1000)가 `router.env`를 쓸 수 있어야 한다.

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

가장 간단한 방법(ADR 0025):

```bash
# Router 웹 UI > 워커 > 워커 추가 → 코드 발급
cd <ggjira 폴더>
npm run dev -- worker start      # 처음: Router 주소, LLM, 페어링 코드, (필요하면) 저장소 폴더를 묻는다
npm run dev -- worker start      # 이후: 바로 실행
```

- **`command not found: ggjira`**: 전역 설치 전에는 `npm run dev -- …`로 실행한다. `--` 뒤에 한 칸 띄우고
  `ggjira`라는 단어는 넣지 않는다. 설치하려면 `npm run build && npm link`.
- **`LLM CLI를 찾지 못했습니다`**: `claude` 또는 `codex`를 설치하고 로그인한 뒤 다시 실행한다. 코드는 LLM을
  고른 뒤에야 쓰므로 같은 코드를 다시 쓸 수 있다(10분 안).
- **`페어링 코드가 맞지 않거나 만료됐습니다`**: 웹 UI에서 새 코드를 받아 입력한다(같은 질문을 다시 한다).
- **`터미널에서 실행하면 설정을 차례로 묻습니다`**: 서비스나 CI처럼 물을 수 없는 곳이다.
  `--router`, `--pairing-code`, `--provider claude-code|codex`를 주고, 저장소는 `cloneUrl`로 받는다.
- **`clone 실패`**: 워커 머신의 git 권한(SSH 키, credential helper)을 확인하고 다시 실행한다. 이미 받은
  저장소는 건너뛴다.
- **`로컬 폴더(…)가 없습니다`**: 터미널에서 `worker start`를 다시 실행하면 폴더를 묻고 설정에 저장한다.
  또는 Router 설정 > 저장소에 `cloneUrl`을 넣는다.
- **작업 결과 보기**: 워커는 작업마다 `ggjira/<이슈>-<번호>` 브랜치에 커밋하고, 저장소에 `pushRemote`
  (기본 `origin`)가 있으면 그 원격에 push한다(ADR 0026). Jira 완료 댓글의 `pushed:`와 `pull request:` 줄을
  보고 원격에서 검토하고 합친다. `push failed`면 워커 머신의 git 권한(SSH 키, `gh auth login`, credential
  helper)을 확인한 뒤, 댓글에 적힌 `git push` 명령을 워커 clone 폴더에서 실행한다. push를 끄려면 워커 설정에서
  `pushRemote`를 지운다.
- 워커 설정은 페어링 시점의 Router 정책으로 만들어진다. 나중에 capabilities나 저장소를 넓히면 워커의
  `worker.config.json`도 고친다.

수동 구성:

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

## 20. 웹 UI와 셋업 모드 (ADR 0023, 0024)

- **최초 설치**: 설정 파일 없이 `ggjira router serve --config router.config.json`을 실행하면 셋업
  모드로 뜨고, 콘솔에 `GGJIRA Router setup: open …/ui/`와 일회용 setup token이 찍힌다. 마법사가
  `router.config.json`과 같은 폴더의 `router.env`(0600)를 쓴다. 결과 화면의 admin token과 webhook
  secret은 한 번만 보이지만 `router.env`에도 남아 있다. 끝나면 Router를 재시작한다.
- **셋업 모드로 뜨는 조건**: 설정 파일이 없거나, 환경변수와 secrets 파일을 합쳐도 비밀정보가
  부족할 때다. 파일은 있는데 검증에 실패하면 셋업 모드로 가지 않고 `failed validation`으로 종료한다.
  고친 뒤 다시 실행한다.
- **setup token을 잃어버림**: Router를 재시작하면 새 token이 나온다. 이전 token은 프로세스 메모리에만
  있다.
- **로그인 실패(401)**: 웹 UI는 `GGJIRA_ADMIN_TOKEN`을 쓴다. 환경변수가 secrets 파일보다 우선하니, 둘이
  다르면 환경변수 값이 맞다.
- **설정 적용**: 웹에서 저장하면 바로 적용된다(로그 `config applied`). "재시작 필요" 배너가 뜨면
  `http`, `db.path`, `jira.baseUrl`, `executionAgent.fieldId` 중 하나를 바꾼 것이니 Router를 재시작한다.
  파일을 직접 고쳤으면 "적용 대기" 배너의 "지금 적용"(`POST /api/v1/admin/config/apply`)을 누른다.
  직전 파일은 `router.config.json.bak`에 있다. 기록은 `audit_log`의 `config.updated`/`config.applied`다.
- **워커 정책을 뺐는데 그 워커가 작업 중이었음**: 새 세션과 새 배정만 막힌다. 실행 중이던 작업은 임대가
  만료되어 `recovery_required`가 된다(§14). 워커 머신에서 멈췄는지 확인하고 `jobs resolve`/`retry`를 한다. Docker에서
  저장이 `EACCES`/`EBUSY`로 실패하면 `deploy/config`가 디렉터리 마운트인지, uid 1000이 쓸 수 있는지 본다.
- **상태 흐름 바꾸기**: Jira 워크플로를 먼저 바꾸고, 설정 > Workspace에서 "Jira에서 상태 불러오기" 후
  드롭다운으로 고른다. 아래 "Router가 하는 전이"가 모두 "연결됨"이면 저장한다. "전이 없음"은 Jira 워크플로에
  그 전이를 추가해야 한다는 뜻이다(갈 수 있는 상태가 함께 표시된다). "확인 불가"는 그 출발 상태에 이슈가
  하나도 없어서다. Jira는 전이를 이슈 단위로만 알려주므로, 이슈 하나를 그 상태로 옮겨 두면 확인된다.
  같은 결과가 `router check`에도 나온다.
- **점검 화면**: 저장된(아직 미적용일 수 있는) 설정 파일로 `router check`를 돌린다. `jira.baseUrl`을
  바꿨다면 실행 중인 연결로 점검했다는 경고가 붙는다. 이 경우는 재시작한 뒤 다시 점검한다.
- 셋업 모드와 웹 UI 모두 HTTP만 서빙한다. 원격에서는 반드시 Caddy HTTPS 뒤에서 연다.

## 21. GitHub PR 머지 → Jira 완료 (ADR 0027)

흐름: 워커가 브랜치를 push하고 PR을 연다 → 이슈는 검토 상태 → 사람이 GitHub에서 머지 → Router가 이슈를
`완료`(workspace `doneStatus`)로 옮기고 댓글을 단다.

설정:
1. 설정 > Workspace > 상태 흐름에서 **완료 상태**를 고르고, "PR 머지 후 완료" 전이가 "연결됨"인지 본다.
2. 워커 설정의 저장소에 `"pushRemote": "origin"`, `"createPullRequest": true`를 둔다. `worker start`로 만든
   설정은 기본값이 이렇다. 워커 머신에서 `gh auth login`을 해 둔다.
3. 머지 알림은 둘 중 하나 또는 둘 다 쓴다.
   - **폴링(설정 불필요)**: Router가 5분마다(`github.pollIntervalMs`) 열린 PR을 GitHub에 묻는다. 비공개
     저장소면 `router.env`에 `GITHUB_TOKEN=<읽기 권한 토큰>`을 넣는다. 로컬에서는 `gh auth token`의 값을 써도
     된다.
   - **웹훅(즉시)**: `router.env`에 `GGJIRA_GITHUB_WEBHOOK_SECRET=<16자 이상>`을 넣고 Router를 재시작한다.
     GitHub 저장소 Settings > Webhooks에 URL `https://<Router 도메인>/webhooks/github`, Content type
     `application/json`, 같은 secret, 이벤트 "Pull requests"로 등록한다.
   - **로컬 Router**: GitHub이 127.0.0.1에 닿지 않는다. 폴링만 써도 되고, 즉시 받으려면
     `gh extension install cli/gh-webhook` 후 다음 명령을 켜 둔다.
     `gh webhook forward --repo <owner>/<repo> --events pull_request --url http://127.0.0.1:8787/webhooks/github --secret <같은 secret>`

토큰은 웹 UI > 설정 > GitHub 영역의 "GitHub 토큰"에 넣어도 된다. `router.env`에 저장되고 재시작 없이
적용되며, 저장하면 곧바로 열린 PR을 다시 확인한다(ADR 0032).

진단:
- 먼저 설정 > GitHub 영역의 **추적 중인 PR** 목록을 본다. "지금 확인"으로 바로 다시 확인할 수 있다.
  - "확인 실패 — private repository needs GITHUB_TOKEN": 비공개 저장소인데 토큰이 없다. 토큰을 넣는다.
  - "token cannot see this repository": 토큰에 그 저장소의 Pull requests 읽기 권한이 없다.
  - "invalid or expired": 토큰을 새로 발급해 교체한다.
  - 목록에 PR이 없다: 워커가 PR을 만들지 못했거나(Jira 댓글의 `pull request failed`) 결과에 PR이 없었다.
- 머지했는데 완료로 안 감: `router reports list`에 막힌 단계가 있는지 본다. 댓글에 "a human moved it"이면
  이슈가 이미 검토 상태가 아니었다(의도된 동작). 전이 실패면 설정 화면의 "PR 머지 후 완료" 전이를 확인한다.
- Jira 댓글에 `pull request failed`가 있으면 워커 머신의 `gh auth status`를 확인한다. 이 경우 PR은 추적되지
  않는다. 사람이 직접 PR을 만들어 머지한 뒤 이슈를 손으로 완료 처리한다.
- 웹훅 401: secret이 서로 다르다. GitHub 웹훅 화면의 Recent Deliveries에서 응답을 볼 수 있다.

### 검토 대상과 머지 (ADR 0040)

Router는 결과마다 검토할 커밋(head)을 고정한다. 머지가 완료로 이어지지 않으면 이슈 댓글과
`ggjira router issue reviews KEY`를 본다.

- `stale`, "is not the reviewed commit": 결과 뒤에 PR에 커밋이 더해졌다. 무엇이 머지됐는지 확인하고 이슈를 직접
  완료로 옮긴다.
- `stale`, "a newer result exists": 같은 이슈의 재작업이 그 뒤에 결과를 냈다. 이전 PR이 머지된 것이다. 새 결과와
  비교해 정리한다.
- `unverified`, "Head commit not compared": 워커가 커밋을 보고하지 않았다(이전 버전 워커). 기존처럼 완료로
  옮긴다. 워커를 업그레이드하면 비교된다.
- 고위험 규칙: workspace 설정에 다음을 넣는다. 설정 > 파일 편집 또는 `router.config.json`.

```json
"review": {
  "highRiskPaths": [
    { "name": "migrations", "paths": ["src/router/db/**", "db/migrations/**"] },
    { "name": "public contract", "paths": ["src/contracts/**"] }
  ]
}
```

  규칙이 없으면 고위험 판정은 "unknown"으로 보인다. 일치한 결과는 "Needs your individual review"로 보고된다.
  GGJIRA는 머지를 막지 않는다. 고위험 PR의 필수 리뷰는 GitHub branch protection(CODEOWNERS·required reviews)으로
  설정하고, 테스트 저장소에서 실제로 막히는지 직접 확인한다.

## 22. 워커 LLM 사용량 (ADR 0028)

웹 UI > 워커 카드의 "LLM 사용량"은 워커가 **연결할 때**와 **작업을 마친 직후**에만 갱신된다. 주기적으로
조회하지 않으니, 최신 값이 필요하면 워커를 재시작한다.

- **"보고 없음"**: 새 워커가 아직 연결하지 않았거나 Router가 이 기능 이전 버전이다(워커 로그
  `usage report failed`, 404). Router를 업데이트하고 워커를 재시작한다.
- **Claude Code에 "reported no plan usage"**: API 키 과금이라 플랜 한도가 없다. 구독 계정이면 워커
  머신에서 `claude auth status`로 `authMethod: "claude.ai"`인지 확인한다.
- **Claude Code에 "usage probe exited/timed out"**: 워커 머신에서 직접 확인한다.
  `claude -p "Reply with OK." --output-format stream-json --verbose --model haiku --tools "" | grep rate_limit_event`
- **Codex에 "app-server ... without an answer"/"did not answer in time"**: `codex --version`이 app-server를
  지원하는지(0.158 이상에서 확인), `codex login status`가 로그인 상태인지 본다.

### 사용량에 따른 배정 (ADR 0029)

- 워커 카드의 **"LLM 한도 — 배정 제외"**: 해당 워커 provider의 한도 창 하나가 100%다. 표시된 리셋 시각까지
  새 작업을 받지 않는다. 한도를 늘렸거나 값이 틀렸다고 보면 워커를 재시작해 다시 보고하게 한다.
- **"LLM 한도 임박 — 후순위"**: 창 하나가 `scheduling.usage.deprioritizeAtPercent`(기본 90%) 이상이다.
  여유 있는 다른 유휴 워커가 있으면 그쪽이 먼저 받고, 없으면 이 워커가 받는다.
- 모든 워커가 배정 제외면 작업은 `queued`로 남는다. 대시보드 큐 대기 시간이 늘어나면 워커 카드를 확인한다.
- 끄려면 설정 > 고급 JSON에 `"scheduling": {"usage": {"skipExhausted": false, "deprioritizeAtPercent": 100}}`를
  넣는다.

## 23. Jev 관찰 평가 (ADR 0030)

켜기: 웹 UI > 설정 > "Jev 평가 (TypeSafe)"에 키를 넣고 저장한다. `router.env`에 저장되고 재시작 없이
바로 켜진다(ADR 0031). `router.env`에 `TYPESAFE_API_KEY=<키>`를 직접 넣고 재시작해도 된다. 로그에
`jev assessment pass`가 보이면 동작 중이다. 끄려면 같은 화면에서 삭제하거나, 설정 고급 JSON에
`"jev": {"enabled": false}`를 넣는다.

- 화면에 "설정됨 (환경변수)"로 나오고 바꿀 수 없음: Router 환경변수 `TYPESAFE_API_KEY`가 파일보다 우선한다.
  환경변수를 바꾸고 재시작한다.
- 저장 시 400: 키에 공백, 따옴표, `#`, 줄바꿈이 들어 있다. 복사할 때 앞뒤 공백이 붙었는지 확인한다.

평가 결과 보기(관리 API·CLI가 생기기 전까지는 DB를 직접 읽는다):

```
sqlite3 data/router.sqlite3 "SELECT j.issue_key, j.kind, j.state, j.attempt_count,
  json_extract(a.answers_json,'$.modelTier.choice') AS tier,
  round(json_extract(a.answers_json,'$.modelTier.confidence'),2) AS tier_conf,
  json_extract(a.answers_json,'$.readiness.choice') AS readiness,
  round(json_extract(a.answers_json,'$.readiness.confidence'),2) AS readiness_conf,
  a.latency_ms, a.error
  FROM job_assessments a JOIN jobs j ON j.id = a.job_id ORDER BY j.created_at DESC LIMIT 30;"
```

진단:
- `error`에 `401`: 키가 틀렸다. `429`: 요청 한도 초과다(3번 재시도 후 기록). `did not answer within`:
  `jev.timeoutMs`를 늘린다.
- 한 job은 최대 3번까지만 시도한다. 다시 평가하려면 그 job의 `job_assessments` 행을 지운다.

## 24. 구현 요청 준비 보류 (ADR 0034)

구현 요청(요청 상태의 이슈)은 설명에 `h2. Acceptance Criteria`와 `h2. Verification` 절이 있고 각각
목록 항목이 한 줄 이상 있어야 시작한다. 계획 요청은 이 조건 없이 시작한다.

증상: 이슈가 요청 상태에 머물고 job이 생기지 않는다. 댓글에 "GGJIRA has not started this implementation
request"가 한 번 달린다. Router 로그의 reconcile `held`에 `not ready to implement: missing …`가 보인다.

확인:

```
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" https://<router>/api/v1/admin/holds/readiness
```

`noticeStatus`가 `pending`이면 안내 댓글을 아직 못 쓴 것(Jira 응답 없음·429, 다음 패스에서 재시도)이고,
`failed`면 Jira가 명확히 거부한 것이다(`noticeError`). `failed`여도 보류는 그대로 유효하다. 댓글만 빠졌다.

보완(기존 티켓 포함):

1. 설명에 아래 절을 추가한다. 위키 마크업 목록(`* 항목`)으로 쓴다.
   ```
   h2. Acceptance Criteria
   * 저장 버튼 문구가 "저장"으로 보인다
   h2. Verification
   * npm run test -- settings
   * 설정 화면을 열어 버튼 문구를 확인한다
   ```
   필요하면 `In Scope`, `Out of Scope`, `Affected Areas`(참고용), `Allowed Paths`(glob, 적으면 워커가
   그 밖의 변경을 막는다, ADR 0036)도 같은 방식으로 쓴다.
2. 이슈를 옮길 필요는 없다. 다음 조회(웹훅 또는 보완 조회)에서 보류가 풀리고 job이 생긴다. 설명을 고쳤지만
   여전히 빠진 절이 있으면 새 안내 댓글이 한 번 더 달린다.

대표 사례 수동 검토(프롬프트 품질은 자동 테스트가 입증하지 않는다):

- 문구 변경 요청을 계획 상태로 보낸다. 하위 이슈 없이 부모 설명의 계획 블록에 Acceptance Criteria와
  Verification이 채워지는지 본다.
- API와 UI 변경이 섞인 요청을 계획 상태로 보낸다. 독립 결과별로 하위 이슈가 나뉘거나 결정 요청이 오는지,
  각 하위 이슈에 계약 절이 모두 있는지 본다.

## 25. 입력 해시 v2와 재승인 (ADR 0035)

승인은 승인 당시의 제목·설명 전체·계약을 승인한다. 승인 뒤 이를 고치면:

- 큐·임대 중인 job은 취소되고, 실행 중인 job은 다음 heartbeat에서 멈춤 지시를 받는다. commit·validate·push
  직전 권한 확인(`authorize`)도 거부된다.
- 같은 승인으로는 다시 실행하지 않는다. reconcile `held`에 `the request was edited after it was approved`가
  보인다. 고친 내용을 실행하려면 이슈를 요청 상태 밖으로 옮겼다가 다시 요청 상태로 옮긴다.
- 댓글·라벨 추가, 줄 끝 공백이나 줄바꿈 형식만 바뀐 편집은 변경이 아니다.

업그레이드 전환: migration이나 수동 작업이 필요 없다. 업그레이드 전에 만든 job(해시에 `v2:` 접두가 없음)은
닫힐 때까지 이전 규칙으로 비교한다. 관리자 `jobs retry`만 그 job을 새 해시로 다시 찍고, audit의
`job.retried`에 `inputHash.from/to`를 남긴다.

```
sqlite3 data/router.sqlite3 "SELECT id, issue_key, state, substr(input_hash,1,3) AS v FROM jobs
  WHERE state NOT IN ('succeeded','cancelled');"
sqlite3 data/router.sqlite3 "SELECT * FROM admin_holds WHERE actor = 'router:inputs-changed';"
```

## 26. 구현 결정 요청과 범위 이탈 (ADR 0036)

증상: 구현 이슈가 `needsDecisionStatus`(없으면 검토 상태)로 옮겨지고 "GGJIRA stopped this implementation
before commit and push" 댓글이 달린다. PR은 열리지 않고 브랜치도 push되지 않는다.

댓글의 원인 줄로 종류를 구별한다.

- `Out of scope: …`: 구현 에이전트가 계약 밖 변경이 필요하다고 보고했다(의미상 이탈).
- `Changed paths outside Allowed Paths:`: 실제 변경 경로가 `Allowed Paths` 밖이다(경로 이탈). rename은
  `옛 경로 -> 새 경로`로 보이며, 양쪽 모두 허용돼야 한다.
- `Question: …`: 에이전트가 선택지를 두고 결정을 요청했다.

증거(워커 머신):

- patch: `<logPath>/<jobId>-<attemptId>.patch`. 커밋하지 않은 변경 전체이고(바이너리 포함), 기준
  브랜치에서 갈라진 지점 대비다. 검토하려면 `git apply --check <patch>` 후 다른 브랜치에 적용한다.
- worktree: `<dataDir>/worktrees/ggjira-<KEY>-<attempt>`. 변경이 stage된 상태로 남아 있다.
- 정리: 댓글의 `cleanup` 줄을 따른다(`git worktree remove --force <path> && git branch -D <branch>`).
  또는 기간이 지난 뒤 `ggjira worker worktrees prune`.

재개(재승인):

1. 결정을 이슈 설명의 계약에 반영한다. 예: 범위를 넓히면 `In Scope`와 `Allowed Paths`에 추가하고,
   하지 않기로 하면 `Out of Scope`에 적는다. 필요하면 Acceptance Criteria·Verification도 고친다.
2. 이슈를 요청 상태로 옮긴다. 새 승인 id와 새 입력 해시로 새 job·attempt가 만들어진다. 이전 attempt의 늦은
   결과는 적용되지 않는다. 댓글만 달고 옮기지 않으면 아무 일도 일어나지 않는다. 댓글은 승인 입력이 아니다.

실패로 보고되는 경우(커밋 없음, patch 보존, `ggjira-failed` 라벨):

- `final report could not be read`: provider의 최종 응답에 보고 JSON이 없거나 스키마에 맞지 않는다.
  워커 로그 `<logPath>/<jobId>-<attemptId>.jsonl`의 마지막 result 이벤트를 본다.
- `without any verification evidence`: `completed`인데 acceptance별 검증이 비어 있다.
- `Verification failed: …`: 에이전트가 직접 `fail`로 판정한 acceptance가 있다.

### 프로토콜 2 업그레이드 순서

Router와 워커는 `protocolVersion`이 같아야 한다. 다르면 426 `protocol_mismatch`로 거절되고 실행되지 않는다.

1. `ggjira router status`로 running/leased job이 없는지 확인한다. 있으면 끝나기를 기다리거나
   `ggjira router jobs cancel`.
2. 각 워커에서 `ggjira worker results retry`로 spool을 비운다(`still waiting 0`). 남은 결과가 있으면 먼저
   Router가 받아야 한다. 업그레이드 뒤에는 이전 형식 결과를 다시 보낼 수 없다.
3. 워커를 멈추고, Router를 업그레이드·재시작한 뒤, 워커를 업그레이드·시작한다.
4. 업그레이드 뒤 워커 로그에 `spooled result does not match this protocol version`이 보이면 2단계에서
   빠진 결과다. 파일은 spool에 그대로 있다. 내용을 확인한 뒤 해당 이슈를 다시 요청 상태로 옮긴다.

## 27. label 모드: opt-in 라벨과 일반 상태 흐름 (ADR 0037)

label 모드 workspace에서는 AI 전용 상태 없이 일반 상태 흐름을 쓴다. 담당자가 있는 이슈가 할 일
(`requestStatus`)에 있고 `optInLabel`이 붙어 있으면 Router가 맡는다. 설정 예:

```json
"workflow": {
  "mode": "label",
  "optInLabel": "ai-enabled",
  "requestStatus": "해야 할 일",
  "inProgressStatus": "진행 중",
  "reviewStatus": "검토",
  "doneStatus": "완료"
}
```

`planningStatus`·`needsDecisionStatus`는 쓰지 않는다(있으면 설정 오류). opt-in 라벨은 대소문자를 구분하지
않으며, `reporting.failureLabel`·`ggjira-superseded` 같은 GGJIRA 라벨과 같을 수 없다.

### 동작

- 시작: Acceptance Criteria·Verification이 있으면 구현, 없으면 PM 계획이 먼저 돈다. PM이 결과 하나로
  보면 상위 이슈 설명에 계약을 채우고 검토 상태로 옮긴다. 계약을 확인한 뒤 할 일로 옮기면 구현이
  시작된다. 여러 결과로 나누면 하위 이슈가 생기는데, 라벨은 붙지 않는다. 실행할 하위 이슈에 사람이
  라벨을 붙인다. 하위 작업이 있는 상위 이슈를 다시 할 일로 옮기면 재계획한다.
- 결정 요청·범위 이탈: 이슈는 진행 상태에 남고 댓글로 안내된다. 결정을 설명에 반영하고 할 일로 옮기면
  새 승인으로 다시 시작된다.
- 실패: 진행 상태에 남고 `ggjira-failed` 라벨이 붙는다. 같은 승인으로는 다시 돌지 않는다.
- 라벨 제거: 대기 중이면 취소, 실행 중이면 중단을 요청한다(최대 5초 안에 확인). 이슈 상태는 그대로다.
  다시 붙이면 새 승인이다.
- 재작업: 검토 → 할 일로 옮기면 새 job이다.
- 승인 뒤 요청 수정(제목·설명·계약): 대기 중이면 취소하고, 실행 중이면 중단을 요청한다. 늦게 온 결과는
  반영하지 않는다. 같은 승인으로는 다시 돌지 않으며 로그 `held`에 "edited after it was approved"가 남는다.
  고친 내용으로 실행하려면 할 일로 다시 옮기거나 라벨을 뗐다 다시 붙인다(새 승인, 새 입력 해시).

### 이슈별 AI 참여 켜고 끄기 (ADR 0039)

웹 UI 이슈 화면 또는 `ggjira router issue show KEY` / `ggjira router issue opt-in KEY on|off`. opt-in 라벨만
바꾸고 다른 라벨은 그대로 둔다. 응답은 Jira를 다시 읽어 확인한 결과다.

- `blocked:` 줄(웹 UI의 Router 항목)이 시작되지 않는 이유다. `not_requested`는 상태를, `no_assignee`는
  담당자를, `readiness_hold`는 빠진 절을, `approval_held`·`inputs_changed`는 새 승인(라벨을 껐다 켜기)을 요구한다.
- `409 not_label_mode`: legacy workspace다. 상태로 요청한다.
- `502 unconfirmed`: 쓰기 결과를 확인하지 못했다. Jira에서 이슈의 라벨을 직접 보고 다시 조회한다.
- `502 jira_forbidden`: Router의 Jira 계정에 그 이슈 편집 권한이 없다.
- 누가 언제 바꿨는지: `audit_log`의 `issue.opt_in.*`(성공·변경 없음·실패 모두). actor는 호출자가 선언한
  이름이고 인증은 공유 admin token이다.

시작되지 않을 때: `ggjira router check --issue KEY`가 opt-in 라벨 유무와 전이 가능 여부를 보여 준다. Router
로그 `pass:"reconcile"`의 `held`/`skipped`에 이유가 있다(담당자 없음, 하위 이슈의 계약 누락 등).

### legacy → label 전환

1. 기준선: `ggjira router backup`과 설정·비밀 파일 사본을 저장소 밖에 둔다. Git 태그만으로는 DB와 Jira가
   복구되지 않는다.
2. 제안(Jira를 바꾸지 않음):
   `ggjira router migrate-labels plan --workspace <id> --label ai-enabled --to-do "<할 일>" --review "<검토>" --out plan.json`
   - `add-label-and-request`: 요청·계획 요청 이슈. 라벨을 붙이고 할 일로 옮긴다.
   - `move-to-review`: AI 작업 완료 이슈. 검토로 옮긴다.
   - `manual`: 결정 대기, 진행 중, 계약이 이미 있는 계획 요청(label 모드에서는 구현으로 바뀜). 사람이 정한다.
   - `blocked`: 아직 실행될 수 있는 job이 있다. 끝나기를 기다리거나 `jobs cancel`.
3. `plan.json`을 검토하고 옮길 항목에만 `"approved": true`를 쓴다.
4. 적용(workspace가 아직 legacy일 때): `ggjira router migrate-labels apply plan.json`. 이슈마다 결과를 출력하고
   `audit_log`에 남긴다(`migration.label.*`). 계획 이후 바뀐 이슈는 건너뛰고, 실패한 이슈가 있어도 나머지는
   계속한다. legacy는 라벨을 보지 않으므로 이 단계에서는 아무것도 시작되지 않는다. 실패한 항목은 원인을
   고친 뒤 같은 파일로 다시 apply한다. 이미 옮긴 항목은 `skipped`로 나온다.
5. 설정 전환: 웹 UI 설정에서 AI 참여 방식을 label로 바꾸고 opt-in 라벨과 일반 상태를 지정해 저장한다.
   아직 실행될 수 있는 job(대기·임대·실행·중단 요청·복구 필요)이 그 workspace에 있으면
   409 `workspace_busy`로 거절된다. 실패·시간 초과 job은 막지 않는다.
6. 관찰: `ggjira router status`와 Router 로그로 새 job과 댓글이 한 번씩만 생기는지 확인한다.
7. 되돌리기: 설정을 legacy로 되돌린다(같은 `workspace_busy` 규칙). 옮긴 이슈는 `audit_log`의 `migration.label.applied`
   기록을 보고 골라서 되돌린다. 일괄 되돌리기는 없다.

AI 전용 상태를 Jira 워크플로에서 지우는 것은 전환 조건이 아니다. 충분히 관찰한 뒤 따로 한다.

## 28. Jira 웹훅 진단 (ADR 0038)

Router는 서명이 맞는 웹훅의 이벤트 종류·이슈 키·프로젝트·바뀐 필드만 `events`에 저장한다. 이슈 본문·댓글·
사용자 정보는 저장하지 않는다. 판단은 늘 Jira 재조회로 한다.

- `202 {"status":"ignored"}`: 댓글 이벤트이거나 workspace 밖 프로젝트다. 기록만 하고 reconcile을 깨우지
  않는다. 결정 답변 댓글은 사람이 이슈를 다시 요청할 때 반영된다.
- `401`: 서명 불일치. 처리하지 않는다. Jira 웹훅 secret과 `GGJIRA_WEBHOOK_SECRET`을 맞춘다.
- `400 missing x-atlassian-webhook-identifier`: delivery id가 없는 요청. Jira Cloud 웹훅이 아니다.
- `413`: 본문이 1 MiB를 넘는다.
- `500`: 저장 실패. Jira가 재전송한다. Router 로그와 DB 디스크를 확인한다.
- 웹훅이 오지 않아도 `reconciliation.backgroundIntervalMs`(기본 60초)마다 보완 조회가 돈다.
  `ggjira router status`의 `webhooks` 지연이 계속 늘면 sync 루프가 실패하고 있는 것이다.

## 29. 확인 필요 항목 (ADR 0041)

웹 UI 대시보드의 "확인 필요", `ggjira router status`의 `needs attention`, `ggjira router attention`이 사람이
지금 봐야 할 것이다. 같은 사건은 하나로 묶이고 횟수(`x3`)가 늘어난다.

| 종류 | 뜻 | 할 일 | 해소 시점 |
|---|---|---|---|
| `failed` | 실행 실패·시간 초과 | 이슈 댓글의 이유를 고치고 다시 요청 | 같은 이슈의 성공, 또는 새 승인 |
| `decision_needed` | 결정 대기 | 설명에 결정을 반영하고 다시 요청 | 새 승인 |
| `scope_deviation` | 범위 이탈로 커밋 전 중단 | 계약을 고치거나 범위를 줄여 다시 요청 | 새 승인 |
| `review_required` | 고위험·미검증·커밋 없음 등 개별 검토 | 결과를 직접 확인 | 검토 커밋과 같은 PR 머지, 새 결과, 새 승인 |
| `readiness_hold` | 계약 절이 빠져 시작 안 함 | 설명에 Acceptance Criteria·Verification 추가 | 계약이 채워짐 |
| `report_blocked` | Jira 반영이 막힘 | 원인(워크플로·권한)을 고치고 `router reports retry` | 재시도가 반영됨 |

- 해소는 기록일 뿐이다. 해소됐다고 실행이 시작되지 않는다. 실행은 Jira의 새 요청(승인)만 시작한다.
- `--all`이나 `--resolved`로 해소 이력을 본다. "recurred after"는 해소된 같은 사건의 재발이다.
- 같은 이유의 반복 실패는 Jira 댓글을 다시 달지 않는다. 이유가 바뀌면 새 댓글이 달린다.

## 30. 실행·사용량 기록 (ADR 0042)

`ggjira router usage --issue KAN-12 --children`은 그 요구사항과 하위 작업의 모든 실행을 보여 준다.
`--json`이 내보내기 형식이다.

- `usage not reported`/`?`: CLI가 토큰을 주지 않았다(이전 워커, 오래된 CLI). 0이 아니라 모름이다. 합계의
  `usage not reported for N`이 그 건수다.
- `(inside in)`: Codex는 캐시 입력을 입력 토큰 안에 센다. 합계에서 `in … (of which cache …)`로 보인다.
  Claude Code의 캐시 읽기는 입력과 별도(`cache-read on top`)다. 둘을 더하지 않는다.
- `(configured)`: CLI가 모델을 알려 주지 않아 워커 설정의 모델을 적었다(Codex).
- `retry`는 관리자 `jobs retry`, `rework`는 같은 이슈의 새 요청이다. `not applied`는 늦게 와서 반영하지 않은
  결과다(사용량은 남긴다).
- `cause`: `environment`(시간 초과·비정상 종료), `requirements_change`(승인 뒤 요청 수정으로 취소)는 Router 판단이다.
  `unknown`은 원인을 판단하지 않았다는 뜻이다. 코드 구조 문제인지는 사람이 본다.

## 31. M4 업그레이드·되돌리기 (M4-07, M4-10)

M4는 DB migration 11~13(`review_targets`·`review_records`, `attention_items`, `execution_records`)을 더하고
워커 결과에 선택 필드(`git`, `execution`, 구현 보고의 `risks`)를 더한다. 프로토콜 버전은 2 그대로다.

업그레이드:
1. `ggjira router backup`과 `router.config.json`·`router.env` 사본을 저장소 밖에 둔다. 기준선 태그
   `m3-baseline-2026-10-18`은 코드만 되돌린다. DB와 Jira는 되돌리지 않는다.
2. `ggjira router status`로 실행 중인 job이 없는지 본다(필수는 아니다. 결과 형식이 호환된다).
3. Router를 새 버전으로 바꾸고 시작한다. migration은 시작할 때 한 번 돈다(재시작해도 다시 돌지 않는다).
   이전 결과에는 검토 대상·주의 항목·사용량 행을 소급해 만들지 않는다.
4. 워커를 업그레이드한다. 순서는 상관없다. 이전 워커의 결과는 커밋·사용량이 "미보고"로 기록되고, PR 머지는
   ADR 0027대로 완료로 옮긴다(댓글에 "Head commit not compared"). 새 워커가 이전 Router에 보내는 결과의 새 필드는
   무시된다.
5. 확인: `ggjira router status`의 `needs attention`, `ggjira router attention`, 새 결과에 대한
   `ggjira router issue reviews KEY`·`ggjira router usage --issue KEY`.

되돌리기:
- 코드만 이전 버전으로 되돌려도 된다. 이전 Router는 schema 버전을 검사하지 않고 새 테이블을 쓰지 않는다.
  그동안의 검토 대상·주의 항목·사용량 기록은 남지만 갱신되지 않는다. PR 머지 → 완료는 ADR 0027 동작으로 돌아간다.
- DB 백업을 복원하는 것은 마지막 수단이다. 백업 이후의 job·결과·보고 저널이 사라지므로, 복원 전에 그 사이 Jira
  댓글·전이와 push된 브랜치를 `audit_log`와 Jira에서 대조해 둔다.
- label 모드 전환 자체의 되돌리기는 §27 "legacy → label 전환" 7단계를 따른다.
