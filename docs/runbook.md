# Runbook

현재 워크플로우는 설정 버전 6 / protocol 5의 **§39**를 따른다. 이전 절의 단일 AI 검토·부모 승인·필수 평가·머지 후 자동 Done 규칙은 §39로 대체되었다.

GGJIRA v5(Router + Worker) 운영·진단 절차다. §1~§12(v4 폴링 에이전트)는 그 코드와 함께 5단계에서
삭제했다(ADR 0022). 이력은 git에 있다. 번호는 다른 문서가 참조하므로 그대로 둔다.

먼저 볼 곳:

- `ggjira router status`는 큐 대기, 워커 연결, recovery 대기, 웹훅 지연, 막힌 보고, 확인 필요 항목 수를 보여 준다.
  사람이 봐야 할 것은 `ggjira router attention`(§29)에 모인다.
- `ggjira router jobs show <jobId>`는 attempt, 보고 단계, 감사 기록을 보여 준다.
- Router 로그의 `layer:"router"`에서 `pass:"reconcile"`의 `held`/`skipped`는 job이 생기지 않은
  이유이고, `report journal pass`의 `blocked`는 Jira 반영이 막힌 곳이다.
- 워커 로그는 `layer:"worker-runtime"`, 결과 spool은 `<워커 홈>/spool/*.json`이다(ADR 0060).

## 13. Windows에서 `npm run test`/`npm run check`가 멈출 때

일부 Windows 개발 환경(특히 백신 실시간 검사가 활성화된 경우)에서는 vitest의 기본
`threads` pool이 `better-sqlite3` 네이티브 애드온을 여러 worker thread에서 동시에 로드하며
멈췄다 — CPU 사용량이 0으로 고정된 채 아무 진행도 없는 것이 특징이다(프로세스가 죽지도,
진행하지도 않는다). ADR 0063으로 네이티브 애드온이 없어진 뒤 2026-10-27에는 같은 머신에서 전체 실행이
멈추지 않고 75초 만에 끝났다. 다시 멈추면 아래 방법을 쓴다.

멈추지 않아도 Windows에서만 실패하는 테스트가 있다. `.sh` fixture를 쓰는 `worker-claude-code-cli`·
`worker-codex-cli`(아래 `spawn EFTYPE`)와, git을 많이 실행해 5초 제한 근처에서 끝나는 `fci-static`의
일부 테스트(변경 전 HEAD에서도 같다)다. 이런 테스트는 Linux 컨테이너에서 확인한다. CI(`ubuntu-latest`, `.github/workflows/ci.yml`)와 Linux 컨테이너(§16의 `docker-compose.test.yml`)에서는 재현되지 않으므로
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
  배정은 설정의 허용 저장소와 워커가 보고한 값(`reported_*`)의 교집합으로만 한다.
- **`409 stale_session`** — 같은 워커 credential로 다른 프로세스가 세션을 새로 열었다.
  최신 세션만 유효하다. 워커 runner는 이 응답을 받으면 세션을 다시 연다.
- **`409 stale_lease`/`lease_expired`** — 임대(30초)가 갱신되지 않았다. 시작 전이면 job이
  `queued`로 돌아가고, 시작 후면 attempt·job이 `recovery_required`로 멈춘다.
- **`recovery_required`에서 멈춘 job** — 자동 재배정하지 않는다(ADR 0021). 워커가 그 attempt의
  결과를 늦게라도 제출하면 중단 확인으로 보고, 결과는 적용하지 않은 채(`applied = 0`) job을
  `cancelled`로 닫는다. 이때 Jira에 "적용된 것 없음" 댓글이 달린다. 워커가 돌아오지 않으면 작업
  폴더와 프로세스가 실제로 멈췄는지 워커 머신에서 확인한다. 그다음 담당자가 Jira에 "재시도" 댓글을 남기면
  새 승인으로 다시 실행한다(ADR 0062, 보완 조회가 그 이슈에 안내 댓글을 한 번 단다). 관리자는
  `ggjira router jobs resolve <jobId>`(닫기) 또는 `ggjira router jobs retry <jobId>`(Jira 승인 재확인 후 새
  attempt)를 쓸 수 있다. 모두 `audit_log`의 `job.resolved`·`job.retried`에 남는다(댓글이면 actor
  `jira:<accountId>`). `jobs cancel`은 `recovery_required`를 거부한다(중단 확인이 먼저다).
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
- **실패 댓글이 짧다(ADR 0048)** — 댓글에는 실패 코드, 한 줄 원인, 다음 행동만 있다(코드는 §35). 실패
  이유·요약·stderr·보존된 변경 위치는 댓글의 `자세한 내용:` 경로에 있다. 기본은 Router 머신의
  `data/failure-logs/<이슈>-<attemptId>.log`이다. 파일이 없으면 `router reports list`에서 그 배치의
  `failure-log` 단계가 skipped인 이유(쓰기 권한 등)를 본다.
- **계획이 적용되지 않음** — 적용할 수 없는 계획(작업 수 초과, taskId 중복, 의존성 순환·미해결)은
  실패 댓글로 보고한다. 하위 이슈가 실행되지 않으면 `ggjira.plan-task`의 `planVersion`이 부모
  `ggjira.plan`의 `version`과 같은지 본다. 재계획 뒤의 옛 작업은 승인되지 않는다.

## 16. Router 배포 (Docker Compose, ADR 0022)

준비물은 공인 DNS가 이 서버를 가리키는 도메인, 80/443 포트, Docker Engine + Compose다.

```bash
mkdir -p deploy/config && sudo chown 1000:1000 deploy/config    # 컨테이너의 node 사용자가 씀
export GGJIRA_DOMAIN=router.example.com
docker compose up -d                                             # 릴리스 이미지를 받는다(ADR 0064)
docker compose logs router | grep -A1 "setup token"             # 웹 셋업(§20): 이 token으로 진행
# 또는 수동 설정:
#   cp deploy/router.config.example.json deploy/config/router.config.json
#   cp deploy/router.env.example deploy/config/router.env
docker compose exec router node dist/cli.js router check         # Jira 상태·전이 확인
docker compose logs -f router
```

- 이미지: `ghcr.io/hokim84/ggjira-router:latest`를 받는다. `GGJIRA_VERSION=0.2.0`처럼 버전을 고정할 수 있고,
  워커의 `ggjira` 패키지와 같은 버전을 쓴다. 이미지를 받을 수 없거나 `docker compose up -d --build`로 실행하면
  현재 checkout을 직접 빌드한다(코드를 고쳐 띄울 때).
- ADR 0023 이전 배포에서 옮겨 올 때: `deploy/router.config.json` → `deploy/config/router.config.json`,
  `deploy/router.env` → `deploy/config/router.env`로 옮기고 `docker compose up -d`한다.

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
docker compose -f docker-compose.cloudflare.yml up -d
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
3. `docker compose -f docker-compose.cloudflare.yml up -d`. migration은 시작할 때 자동으로 된다.
4. 각 워커 홈의 `worker.config.json`에서 `routerUrl`을 `https://router.example.com`으로 바꾸고 재시작한다.
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
- 업데이트: `git pull && docker compose -f docker-compose.cloudflare.yml pull && docker compose -f docker-compose.cloudflare.yml up -d`.
  워커도 같은 버전으로 올린다(§18). 화면이 이상하면
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
npm install -g ggjira            # Node.js 24 이상. Router와 같은 버전(ADR 0064)
ggjira worker start              # 처음: Router 주소, LLM, 페어링 코드, (필요하면) 저장소 폴더를 묻는다
ggjira worker start              # 이후: 바로 실행
```

설치하지 않고 `npx ggjira@<버전> worker start`로도 실행할 수 있다. GGJIRA를 고쳐 가며 쓸 때는 checkout에서
`npm run dev -- worker start`(Windows는 `run-worker.bat`)로 실행한다. 업데이트는 `npm install -g ggjira@<버전>` 뒤 재시작이다.

워커의 설정·credential·clone·worktree·로그·spool은 모두 워커 홈 한 곳에 있다(ADR 0060). 기본은
`%LOCALAPPDATA%\ggjira\worker`(Windows), `~/.ggjira/worker`(그 밖)이고 `--home <폴더>` 또는
`GGJIRA_WORKER_HOME`으로 바꾼다. 한 머신에서 워커를 여럿 띄우려면 홈을 따로 준다.

```text
<워커 홈>/worker.config.json  credential.json  spool/  fci-spool/  logs/
<워커 홈>/repositories/<저장소 id>/repo/        clone(설정에 path가 없을 때)
<워커 홈>/repositories/<저장소 id>/worktrees/   작업별 worktree
```

- **`worker start`·`check`가 `… is above the worker home …`로 멈춤**: 워커 홈이나 그 상위 폴더에 `CLAUDE.md`·`AGENTS.md`·`.git`이
  있다. 그대로 두면 작업 중인 AI가 그 파일을 자기 지침으로 읽는다(KAN-47에서 Codex가 GGJIRA의 `AGENTS.md`를 읽고
  GGJIRA 검사를 다른 저장소의 완료 조건처럼 보고했다). GGJIRA 폴더 안을 홈으로 쓰지 말고 기본 위치나 다른
  프로젝트 밖의 폴더를 `--home`으로 준다.

- **`command not found: ggjira`**: `npm install -g ggjira`로 설치하거나, checkout에서는 `npm run dev -- …`로
  실행한다. `--` 뒤에 한 칸 띄우고 `ggjira`라는 단어는 넣지 않는다.
- **`LLM CLI를 찾지 못했습니다`**: `claude` 또는 `codex`를 설치하고 로그인한 뒤 다시 실행한다. 코드는 LLM을
  고른 뒤에야 쓰므로 같은 코드를 다시 쓸 수 있다(10분 안).
- **실행 실패 `Failed to spawn worker: spawn codex ENOENT`(Windows)**: npm으로 설치한 `codex`는
  `codex.cmd` 셰임이라 셸 없는 `spawn`이 찾지 못한다. 워커는 PATH·PATHEXT로 찾고 npm 셰임이면 그 Node
  스크립트를 직접 실행한다(`src/worker/spawn.ts` `resolveCommand`). 이 메시지가 계속 나오면 `where codex`로
  워커를 띄운 터미널의 PATH에 있는지 보고, 없으면 워커 설정 `providers[].command`에 실행 파일 경로를 적는다.
  워커를 재시작한 뒤 이슈를 요청 상태 밖으로 옮겼다가 다시 요청 상태로 옮긴다(실패한 승인으로는 다시
  실행하지 않는다).
- **Codex 실행 실패 `The '<model>' model is not supported when using Codex with a ChatGPT account`**: 워커
  설정 `providers[].model`에 계정이 쓸 수 없는 모델이 적혀 있다. 지우면 Codex 설정(`~/.codex/config.toml`의
  `model`)을 따른다. 예전 버전은 Codex에도 Claude 기본값 `sonnet`을 넘겼다. 원인은 워커 로그
  `<워커 홈>\logs\<jobId>-<attemptId>.jsonl`의 `turn.failed`에 있고, 이제 실패 요약 첫 줄에도 올라와 댓글에
  "the AI CLI rejected the model"로 나온다(ADR 0048). 실패 로그의 `rmcp ... /mcp` 오류는 Codex 설정의 다른
  MCP 서버가 꺼져 있다는 경고일 뿐이다.
- **워커 로그에 `Router is not reachable; retrying in 5s`**: 워커가 시작할 때나 Router가 다시 시작되는 동안
  Router에 연결하지 못했다. 워커는 끝나지 않고 연결될 때까지 5초마다 다시 시도한다(예전에는 `fetch failed`로
  바로 끝났다). 계속되면 Router가 떠 있는지(`run-router.bat` 창, `http://127.0.0.1:8787/ui/`)와 워커 설정의
  `routerUrl`을 확인한다. Router가 4xx로 거절하면(예: 토큰 폐기) 재시도하지 않고 끝난다.
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
- 워커 설정은 페어링 시점의 Router 정책으로 만들어진다. 나중에 저장소를 넓히면 워커 홈의
  `worker.config.json`도 고친다. 저장소 id는 폴더 이름으로 쓰이므로 영문·숫자·`.`·`_`·`-`만 쓴다.

수동 구성:

```bash
ggjira router workers pair worker-1                      # Router 쪽: 1회용 code(10분)
ggjira worker setup --router https://router.example.com --pairing-code <code> [--home <폴더>]
ggjira worker check [--home <폴더>]   # 홈 위치, credential, 저장소, provider CLI, Router 연결
ggjira worker run [--home <폴더>]     # Ctrl+C 1회: 현재 작업 후 종료, 2회: 즉시 종료
```

- `worker setup`은 token을 `<워커 홈>/credential.json`에만 쓴다. 설정 파일·출력에는 남기지 않는다. 이미 있으면
  `--force`가 필요하다. 홈에 설정이 없으면 시작용 `worker.config.json`도 쓴다.
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
  만료되어 `recovery_required`가 된다(§14). 워커 머신에서 멈췄는지 확인하고 담당자의 "재시도" 댓글이나 `jobs resolve`/`retry`로 푼다. Docker에서
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
- `router check`의 `GitHub <owner>/<repo>` 줄이 PR을 읽을 수 있는지 미리 알려 준다. 대상은 config 저장소의 GitHub
  `cloneUrl`과 이미 기록된 PR의 저장소다. 확인에 실패한 PR은 확인 필요 항목 `pull_request_unchecked`로도 뜬다.
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

## 24. 실행 계약은 승인된 계획이다 (ADR 0047)

구현이 따르는 완료 조건·검증·범위·허용 경로·의존성은 사람이 승인한 계획에서 온다. Router는 이슈
설명의 `h2. Acceptance Criteria` 같은 절을 읽지 않는다. 설명에 렌더링된 계획 블록과 하위 이슈 설명은 사람이 읽는
용도다. 거기를 고쳐도 계약은 바뀌지 않고, 입력이 바뀐 것으로만 본다(§25).

증상: 계획 job이 "Plan has no definition of done: …"로 실패한다(`ggjira-failed`, 요청 상태 유지).
실행 단위(하위 작업, 없으면 부모)에 완료 조건이나 검증이 비어 있어 Router가 계획을 적용하지 않은 것이다. 이 계획은
승인할 수 없다. 설명에 기대 결과와 확인 방법을 적어 다시 `AI 계획 요청`으로 옮긴다.

계약 확인: 구현 job이 받는 계약은 이슈의 승인 snapshot(`approvals.input_snapshot`의 `requirements`)이고,
승인된 계획의 해당 단위와 같다. 계획 원문은 계획 결과(`results.payload`의 `plan`)에 있다.

```
sqlite3 data/router.sqlite3 "SELECT json_extract(input_snapshot, '$.requirements') FROM approvals
  WHERE issue_key = 'KAN-1';"
sqlite3 data/router.sqlite3 "SELECT id, plan_version, outcome, task_ids FROM plan_reviews
  WHERE issue_key = 'KAN-1' ORDER BY created_at DESC;"
```

예전 "구현 요청 준비 보류" 안내 댓글(`[GGJIRA:HOLD:<id>]`)은 더 이상 달리지 않는다. migration 15가 열려 있던
보류와 그 주의 항목을 닫았다. Jira에 남은 예전 댓글은 지우지 않아도 된다.

대표 사례 수동 검토(프롬프트 품질은 자동 테스트가 입증하지 않는다):

- 문구 변경 요청을 계획 요청으로 보낸다. 하위 이슈 없이 부모 설명의 계획 블록에 Acceptance Criteria와
  Verification이 채워지는지 본다.
- API와 UI 변경이 섞인 요청을 계획 요청으로 보낸다. 독립 결과별로 하위 이슈가 나뉘거나 결정 요청이 오는지,
  각 하위 이슈에 계약이 모두 있는지 본다.

## 25. 입력 해시 v2와 재승인 (ADR 0035)

승인은 승인 당시의 제목·설명 전체·계약을 승인한다. 승인 뒤 이를 고치면:

- 큐·임대 중인 job은 취소되고, 실행 중인 job은 다음 heartbeat에서 멈춤 지시를 받는다. commit·validate·push
  직전 권한 확인(`authorize`)도 거부된다.
- 같은 승인으로는 다시 실행하지 않는다. reconcile `held`에 `the request was edited after it was approved`가
  보인다. 같은 계획으로 다시 실행하려면 `계획 검토 대기 → 작업 중`으로 다시 옮기고, 바뀐 요청을 반영하려면
  `AI 계획 요청`으로 옮겨 다시 계획한다.
- 댓글·라벨 추가, 줄 끝 공백이나 줄바꿈 형식만 바뀐 편집은 변경이 아니다.

v1 해시(`v2:` 접두가 없음)로 찍힌 job은 입력이 바뀐 것으로 보고 취소·보류한다(ADR 0047). 관리자 `jobs retry`는
job을 새 해시로 다시 찍고, audit의 `job.retried`에 `inputHash.from/to`를 남긴다.

```
sqlite3 data/router.sqlite3 "SELECT id, issue_key, state, substr(input_hash,1,3) AS v FROM jobs
  WHERE state NOT IN ('succeeded','cancelled');"
sqlite3 data/router.sqlite3 "SELECT * FROM admin_holds WHERE actor = 'router:inputs-changed';"
```

## 26. 구현 결정 요청과 범위 이탈 (ADR 0036)

증상: 구현 이슈가 작업 중에 머물고 "GGJIRA stopped this implementation before commit and push" 댓글이
달린다. PR은 열리지 않고 브랜치도 push되지 않는다.

댓글의 원인 줄로 종류를 구별한다.

- `Out of scope: …`: 구현 에이전트가 계약 밖 변경이 필요하다고 보고했다(의미상 이탈).
- `Changed paths outside Allowed Paths:`: 실제 변경 경로가 `Allowed Paths` 밖이다(경로 이탈). rename은
  `옛 경로 -> 새 경로`로 보이며, 양쪽 모두 허용돼야 한다.
- `Question: …`: 에이전트가 선택지를 두고 결정을 요청했다.

증거(워커 머신):

- patch: `<워커 홈>/logs/<jobId>-<attemptId>.patch`. 커밋하지 않은 변경 전체이고(바이너리 포함), 기준
  브랜치에서 갈라진 지점 대비다. 검토하려면 `git apply --check <patch>` 후 다른 브랜치에 적용한다.
- worktree: `<워커 홈>/repositories/<저장소 id>/worktrees/ggjira-<KEY>-<attempt>`. 변경이 stage된 상태로 남아 있다.
- 정리: 댓글의 `cleanup` 줄을 따른다(`git worktree remove --force <path> && git branch -D <branch>`).
  또는 기간이 지난 뒤 `ggjira worker worktrees prune`.

재개(다시 계획):

1. 결정을 이슈 설명에 적는다. 예: 범위를 넓히기로 했으면 무엇을 어디까지 바꿔도 되는지, 하지 않기로 했으면
   무엇을 빼는지 쓴다. 계약은 승인된 계획에서 오므로(§24) 설명만 고쳐서는 실행 범위가 바뀌지 않는다.
2. 이슈를 `AI 계획 요청`으로 옮긴다. 새 계획을 검토하고 `계획 검토 대기 → 작업 중`으로 승인하면 새 승인 id로
   새 job·attempt가 만들어진다. 이전 attempt의 늦은 결과는 적용되지 않는다. 댓글만 달고 옮기지 않으면 아무 일도
   일어나지 않는다. 댓글은 승인 입력이 아니다.

실패로 보고되는 경우(커밋 없음, patch 보존, `ggjira-failed` 라벨):

- `final report could not be read`: provider의 최종 응답에 보고 JSON이 없거나 스키마에 맞지 않는다.
  워커 로그 `<워커 홈>/logs/<jobId>-<attemptId>.jsonl`의 마지막 result 이벤트를 본다.
- `without any verification evidence`: `completed`인데 acceptance별 검증이 비어 있다.
- `Verification failed: …`: 에이전트가 직접 `fail`로 판정한 acceptance가 있다. 하위 작업(자식)도 같다.
  `not_verified`만 있는 자식은 실패가 아니다(§45).

### 프로토콜 2 업그레이드 순서

Router와 워커는 `protocolVersion`이 같아야 한다. 다르면 426 `protocol_mismatch`로 거절되고 실행되지 않는다.

1. `ggjira router status`로 running/leased job이 없는지 확인한다. 있으면 끝나기를 기다리거나
   `ggjira router jobs cancel`.
2. 각 워커에서 `ggjira worker results retry`로 spool을 비운다(`still waiting 0`). 남은 결과가 있으면 먼저
   Router가 받아야 한다. 업그레이드 뒤에는 이전 형식 결과를 다시 보낼 수 없다.
3. 워커를 멈추고, Router를 업그레이드·재시작한 뒤, 워커를 업그레이드·시작한다.
4. 업그레이드 뒤 워커 로그에 `spooled result does not match this protocol version`이 보이면 2단계에서
   빠진 결과다. 파일은 spool에 그대로 있다. 내용을 확인한 뒤 해당 이슈를 다시 승인하거나 다시 계획한다.

## 27. 라벨 기반 AI 참여 제거 (ADR 0046)

라벨 참여 모드, opt-in 토글/API/CLI, label 이관 명령은 제거됐다. 상태 기반 위임은 §34를 따른다.
기존 label 설정은 유효하지 않으며 자동으로 다른 설정으로 바꾸지 않는다. §34의 "이전 설정에서 전환"을 따른다.

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
| `unassigned` | 담당자 없는 이슈를 위임해 시작 안 함(댓글 1회) | 이슈에 담당자를 지정 | 다음 패스에서 job이 생김 |
| `pull_request_unchecked` | Router가 GitHub에서 PR을 확인하지 못함. 머지해도 Jira에 반영되지 않음 | 증거의 오류대로 `GITHUB_TOKEN`을 넣거나 권한을 고침(§21 진단) | 다음 확인 성공, 또는 PR 종료 |

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
- 라벨 방식으로 되돌리는 기능은 제거됐다. 버전 복구 시 Jira·DB·이후 실행 결과를 함께 대조한다(§27).

## 32. 검토 대기와 판단 (ADR 0043)

웹 UI "검토" 화면, `ggjira router reviews`, `ggjira router status`의 `reviews waiting`이 사람의 판단을 기다리는
결과다. "개별 검토 필요"(`!`)는 고위험·미검증·커밋 없음·실패·결정·이탈, "일반 검토 대기"(`-`)는 그 밖의 결과다.

- 판단: `ggjira router reviews judge <targetId> confirm|hold|rework [--note "사유"]`. 보류·재작업 요청은 사유가
  필요하고 Jira에 댓글 하나가 달린다. 확인은 Router에만 남고 `review_required` 주의 항목을 해소한다.
- 판단은 아무것도 실행하지 않는다. 재작업 요청 뒤에도 상태 기반으로 다시 요청해야 새 실행이 시작된다. 확인했다고 완료로 가지 않는다.
  예외: "사람 확인 대기" 댓글이 달린 하위 작업의 결과를 확인하면 그 하위 작업을 구현 완료로 옮긴다(§45, ADR 0061).
  Jira에서 그 이슈를 직접 구현 완료로 옮겨도 같은 확인으로 기록된다.
- 판단자 이름은 웹 UI에 적은 이름 또는 CLI의 OS 사용자 이름이다(`admin:<이름>`, `admin-token`). 공유 token 뒤의
  자기 신고다.
- 409 `stale_review_target`: 그 사이 같은 이슈의 새 결과가 나왔거나(`currentTargetId`가 새 대상), 이슈가 다시
  승인됐다. 목록을 다시 보고 새 대상에 판단한다. 거절도 감사 기록(`review.judgment.refused`)에 남는다.
- 지난 판단은 `ggjira router issue reviews KEY`와 이슈 화면의 검토 대상에서 본다. `router reviews --all`은
  확인·재작업 요청·머지·새 승인으로 빠진 대상까지 보여 준다.

## 33. Docker·VM 없이 이 PC에서 띄우기 (Windows 배치 파일)

레포 루트의 배치 파일을 더블클릭하거나 명령 프롬프트에서 실행한다. 빌드 없이 `node --import tsx src\cli.ts …`로
돈다(처음 한 번 `npm install`). Node.js 24 이상이 필요하다.

| 파일 | 하는 일 |
|---|---|
| `run-router.bat` | `router serve`. 설정은 `router.config.json`(또는 `GGJIRA_ROUTER_CONFIG`). 없으면 셋업 모드(§20). 뒤에 붙인 인자는 그대로 넘긴다(예: `run-router.bat --port 8788`) |
| `run-worker.bat` | `worker start`. 워커 홈은 `GGJIRA_WORKER_HOME`, 없으면 `%LOCALAPPDATA%\ggjira\worker`. 처음에는 Router 주소·LLM·페어링 코드를 묻는다(§18) |
| `run-all.bat` | Router 창을 열고 `/health`가 응답하면 Worker 창을 연다. 이미 응답하는 Router가 있으면 Worker만 연다 |

- 멈추기: 각 창에서 Ctrl+C(워커는 1회: 현재 작업 후 종료, 2회: 즉시) 또는 창 닫기. 에러로 끝나면 창이 멈춰
  메시지를 보여 준다.
- 같은 PC면 워커 설정의 `routerUrl`은 `http://127.0.0.1:8787`이다(`http://`는 localhost만 허용).
- 이 PC의 Router는 Jira 웹훅을 받을 수 없다(외부에서 127.0.0.1로 못 들어온다). 60초마다 하는 보완 조회로 요청을
  찾으므로 반영이 최대 1분 늦다. 바로 보려면 `ggjira router reconcile`을 쓴다.
- `run-all.bat`의 포트는 Router 설정의 `http.port`(없으면 8787)에서 읽는다. 두 번 실행하면 워커가 하나 더 뜬다.
- 실제 Jira·LLM CLI를 쓰는 실행이다. 시험만 하려면 `GGJIRA_ROUTER_CONFIG`를 없는 경로로, `GGJIRA_WORKER_HOME`을
  빈 폴더로 두고 띄우면 셋업 모드와 워커 첫 실행 질문까지만 간다.

## 34. 이전 두 상태 흐름 (ADR 0044, 0047, 과거 기록)

이 절은 ADR 0050 이전 버전의 운영 기록이다. **현재 설정·실행·전환 절차는 §36을 따른다.**
아래 `planReviewStatus` 설정과 답변 뒤 상태 이동은 현재 버전에서 지원하지 않는다.

라벨은 아무것도 시작하거나 멈추지 않는다. 사람이 보드에서 이슈를 옮겨 위임하고, 승인하고, 철회한다.
워크플로는 하나다. 설정 예:

```json
"workflow": {
  "requestStatus": "AI 계획 요청",
  "planReviewStatus": "계획 검토 대기",
  "inProgressStatus": "작업 중",
  "reviewStatus": "결과 검토",
  "doneStatus": "완료"
}
```

상태는 서로 달라야 한다. `doneStatus`만 선택이다. 예전 `mode`·`planningStatus`·`needsDecisionStatus`·
`optInLabel`은 `Unrecognized key` 오류로 거절한다.
`AI 계획 요청`·`계획 검토 대기`는 Jira 워크플로에 새로 만든다. 보드에서는 각 상태를 다른 컬럼에 매핑해 서로 다른
단계가 한 컬럼에 숨지 않게 한다. `ggjira router check`와 웹 UI 설정의 "Router가 하는 전이"는 다음 전이를 확인한다.

- 요청 → 계획 검토
- 계획 검토 → 작업 중(사람이 하는 승인)
- 작업 중 → 결과 검토
- 결과 검토 → 완료

새 하위 작업이 작업 중으로 갈 수 있는지는 사람이 직접 확인한다(경고로 나온다).

### 흐름

1. **위임**: 담당자가 있는 이슈를 `AI 계획 요청`으로 옮긴다. 설명 형식과 상관없이 계획 job 하나가 생긴다.
   담당자가 없으면 시작하지 않고 "has no assignee" 댓글을 한 번 달고 확인 필요 항목 `unassigned`를 남긴다.
   담당자를 지정하면 다음 패스(최대 1분)에서 시작한다.
   계획하는 동안 이슈는 요청 상태에 있고 "GGJIRA started planning" 댓글이 달린다.
2. **계획 검토**: 계획이 끝나면 `계획 검토 대기`로 옮겨지고 "Plan applied." 댓글이 달린다. 하위 작업으로 나눈
   계획이면 하위 이슈도 이때 생기지만, 승인 전에는 아무것도 실행되지 않는다. 결정이 필요한 계획도 여기에 온다.
   결정 요청의 선택지 번호만 댓글로 남기고(예: `2`) `AI 계획 요청`으로 다시 옮긴다.
3. **승인**: 계획을 읽고 `계획 검토 대기 → 작업 중`으로 옮긴다. 승인 댓글("Plan … approved")이 달린다.
   - 하위 작업이 없는 계획: 이슈 자신이 구현된다.
   - 하위 작업이 있는 계획: Router가 하위 작업을 작업 중으로 옮긴다. 각각 구현되고, 의존성은 앞 작업이 `완료`이거나
     검토 화면에서 확인됐을 때 풀린다(결과 검토 도착만으로는 안 풀린다). 모두 완료되면 부모가 `결과 검토`로 간다.
4. **결과 검토·완료**: ADR 0040~0043·0027 그대로다(검토 화면, PR 머지 → 완료).

실행은 승인된 계획의 계약을 따른다(§24). 설명을 고쳐 범위를 바꾸려면 다시 계획한다.

할 일 → 작업 중처럼 사람이 자기 이슈를 옮기는 것은 AI와 무관하다. 계획 없이 작업 중에 있는 이슈는 가져가지 않는다.
사람이 만든 하위 이슈(`ggjira.plan-task` 없음)도 가져가지 않는다.

### 철회·재시도·범위 변경

- **철회**: 부모를 작업 중 밖으로(할 일 등) 옮긴다. 승인(배포)이 철회되고, 대기 중인 job은 취소되며, 실행 중인 job은
  몇 초 안에 중단 요청을 받는다. 늦게 온 결과는 반영하지 않는다. 다시 작업 중으로 옮기는 것만으로는 승인이 아니다.
  승인은 계획 검토 → 작업 중 이동뿐이다. 하위 작업 하나만 멈추려면 그 하위 작업을 작업 중 밖으로 옮기거나
  `jobs cancel`을 쓴다.
- **같은 계획으로 다시**: 실패한 이슈는 작업 중에 `ggjira-failed` 라벨과 함께 남는다. 라벨을 떼도 다시 돌지 않는다.
  - 부모: `계획 검토 대기 → 작업 중`으로 다시 옮긴다(새 승인).
  - 하위 작업: 작업 중 밖으로 옮겼다가 되돌리거나 `ggjira router jobs retry <jobId>`를 쓴다.
- **범위 변경**: 설명을 고쳐 `AI 계획 요청`으로 옮긴다. 새 계획이 이전 계획과 그 승인을 대신한다.

### 시작되지 않을 때

- 웹 UI 이슈 화면 또는 `ggjira router issue show KEY`의 `stage`가 위임 단계와 다음 이동을 알려 준다.
  `plan`은 최신 계획(버전·outcome·하위 작업), `approval`은 승인 기록과 상태다.
  - `waiting_plan_apply`: 계획이 Jira에 다 반영되기를 기다린다. `ggjira router reports list`로 막힌 단계를 본다.
  - `revoked`: 승인이 철회됐다. 이유가 함께 나온다.
- "did not take the move … as approval" 댓글과 `계획 승인 아님` 주의 항목: 그 이동은 승인이 아니다.
  - 결정 대기 계획: 결정에 답하고 요청 상태로 옮긴다.
  - 이전 요청의 계획: 새 계획이 나올 때까지 기다리거나 다시 요청한다.
  - Jira의 계획 버전이 다름: 다시 요청한다.
- 이슈 화면은 읽기 전용이다. `GET /api/v1/admin/issues/:key`로 조회하며 라벨 변경 토글과 opt-in 엔드포인트는 없다.

### 이전 설정(legacy·label)에서 전환

이전 버전의 `requestStatus`(구현 요청)·`planningStatus`·`needsDecisionStatus`·`mode`·`optInLabel` 설정은 이
버전에서 읽히지 않는다. Router가 설정 오류로 시작하지 않으므로, 업그레이드 전에 이전 버전에서 정리한다. 이관 도구는
없다(ADR 0047).

1. 기준선: `ggjira router backup`과 설정·비밀 파일 사본을 저장소 밖에 둔다.
2. 배정 정지: `ggjira router status`로 leased/running job이 없을 때까지 기다리거나 `ggjira router jobs cancel`.
   각 워커에서 `ggjira worker results retry`로 spool을 비운다. `ggjira router reports list`가 비어 있게 한다.
3. Jira 워크플로에 `AI 계획 요청`·`계획 검토 대기` 상태와 §34 위쪽의 전이를 추가한다. 새 요청 상태는 새로 만든
   상태를 쓴다. 이전 요청·계획 요청 상태를 그대로 쓰면, 업그레이드 뒤 첫 조회에서 그 상태에 있던 이슈가 모두 계획
   요청이 된다.
4. 이전 요청·계획 요청 상태에 남은 이슈는 업그레이드 뒤 아무도 가져가지 않는다. 맡길 이슈는 업그레이드 뒤 사람이
   `AI 계획 요청`으로 옮긴다. 일괄로 옮기지 않는다. 작업 중·검토 중인 이슈는 그대로 둔다. 예전 구현 실행에는 승인된
   계획이 없으므로, 작업 중에 있어도 다시 실행되지 않는다.
5. 설정 파일의 workflow를 §34 위쪽 예처럼 바꾼다. `mode`·`planningStatus`·`needsDecisionStatus`·`optInLabel`을
   지우고 `planReviewStatus`를 넣는다.
6. 새 버전으로 업그레이드하고 Router를 시작한다. `ggjira router check --issue <KEY>`로 상태와 전이를 확인한다.
7. 되돌리기: 이전 버전, 이전 설정, 1단계의 백업을 함께 복원한다. 이 버전이 남긴 계획·승인 기록(migration 14·15)은
   이전 버전이 읽지 않는다.

## 35. 실패 코드 (ADR 0048)

실패 댓글의 첫 줄은 `실행 실패 [GGJ-xxx]: <원인>`이다. 문구는 `src/router/failure-codes.ts`의 표에 있다.
언어는 Router 설정 `reporting.language`(`ko` 기본, `en`)로 정하고, 실패 댓글뿐 아니라 Router가 다는 모든
댓글에 적용된다(문장은 `src/router/comment-text.ts`). 계획 결정은 현재 담당자가 선택지 번호만 댓글로 남긴다(예: `2`, `2번`). 범위를 벗어난 번호와 일반 대화는 자동 재계획을 시작하지 않는다. 이전 `Decision: <선택지 id>` 형식의 유효한 답도 읽는다. 워커가 보고한 실패는 실패 이유의 첫 줄을
표의 규칙과 위에서부터 맞춰 코드를 정한다. 시간 초과·계획 문제는 Router가 직접 코드를 붙인다. 원문은 댓글의
`자세한 내용:` 로그 파일에 있다.

| 코드 | 뜻 | 할 일 |
|---|---|---|
| `GGJ-101` | 워커가 AI CLI를 실행하지 못함(설치 안 됨, PATH 없음) | 워커 터미널에서 `where codex`/`where claude`, 필요하면 `providers[].command`에 경로 |
| `GGJ-102` | 실행 중 워커 재시작 | 워커가 계속 떠 있는지 확인하고 다시 요청 |
| `GGJ-103` | 워커에 job의 저장소·provider가 없음 | 워커 설정의 `repositories`/`providers`와 Router 설정의 id를 맞춤 |
| `GGJ-104` | git worktree 준비 실패 | 워커의 저장소 경로·`git worktree list`·디스크 공간 확인 |
| `GGJ-105` | 시간 초과 | 범위를 줄이거나 `execution.timeoutMs`를 늘림 |
| `GGJ-201` | AI CLI가 모델을 거부 | 워커 `providers[].model`을 지우거나 계정이 쓸 수 있는 모델로(§18) |
| `GGJ-202` | AI 계정 사용량 한도 | 한도가 초기화된 뒤 다시 요청 |
| `GGJ-203` | AI CLI 로그인 안 됨·거부 | 워커 머신에서 `codex login`/`claude` 로그인 |
| `GGJ-204` | AI CLI가 오류를 내고 끝남(원인 문구 포함) | 문구대로 고침. 원문은 로그 파일 |
| `GGJ-205` | AI CLI가 종료 코드만 남기고 끝남 | 로그 파일과 워커 로그 `<워커 홈>/logs/<jobId>-<attemptId>.jsonl` 확인 |
| `GGJ-301` | 워커 검증 명령(`validateCommand`) 실패 | 로그 파일의 `Validation:`·`Acceptance Checks:` 확인. 명령이 job 시간을 넘기면 `GGJ-105`(§45) |
| `GGJ-302` | 완료 조건 검증 실패(하위 작업 포함) | 계획의 완료 조건이나 구현을 고쳐 다시 요청. AI가 확인하지 못한 항목만 있으면 실패가 아니라 사람 확인 대기다(§45) |
| `GGJ-303` | AI가 검증 근거 없이 완료 보고 | 다시 요청. 반복되면 계획의 Verification을 구체적으로 |
| `GGJ-401` | 계획을 적용할 수 없음(작업 수 초과, 완료 조건 없음 등) | 원인 문구대로 요청을 고쳐 다시 계획 |
| `GGJ-402` | 계획 결과에 계획 없음 | 다시 계획 요청 |
| `GGJ-403` | 결정 필요라고 했지만 결정 내용 없음 | 다시 요청 |
| `GGJ-501` | 연결이 끊긴 실행의 결과가 늦게 도착해 반영 안 함 | 다시 실행하려면 요청 상태로 옮김 |
| `GGJ-999` | 분류되지 않은 오류(첫 줄을 그대로 보임) | 로그 파일 확인. 자주 나오면 표에 규칙 추가 |

## 36. 단일 AI 검토: 질문 답변·수정·재시도 (ADR 0050)

```json
"workflow": {
  "requestStatus": "AI 검토",
  "inProgressStatus": "작업 중",
  "reviewStatus": "결과 검토",
  "doneStatus": "완료"
}
```

`doneStatus`만 선택이며 모든 상태는 서로 달라야 한다. `planReviewStatus`·`mode`·`planningStatus`·
`needsDecisionStatus`·`optInLabel`은 설정 오류다. 전이는 AI 검토 → 작업 중 → 결과 검토(→ 완료)이며,
새 하위 작업이 작업 중으로 갈 수 있는지도 확인한다. `router check`와 설정의 전이 점검을 사용한다.

1. 담당자가 있는 이슈를 **AI 검토**로 옮기면 계획을 시작한다. 완료·질문·승인 대기 모두 같은 상태에 남는다.
2. 질문에는 **현재 Jira 담당자가 번호만** 댓글로 남긴다(`2`, `2번`). 유효한 첫 답변으로 자동 재계획하며
   상태를 다시 옮길 필요 없다. 다른 사람·Router·범위 밖 번호·일반 대화는 자동 실행 신호가 아니다.
3. AI 검토에서 제목이나 설명을 수정하면 최신 내용으로 자동 재계획한다. 설명의 GGJIRA 관리 계획 블록은
   Router가 다시 쓰는 표시 영역이다. 요구사항은 그 블록 밖에 수정한다. 블록 안 편집은 계약을 바꾸지 않는다.
4. 계획이 완성되고 Jira 반영까지 끝나면 승인 안내가 나온다. 사람이 **AI 검토 → 작업 중**으로 직접 옮겨야
   구현된다. 댓글로는 구현을 승인하지 않는다. 조기 이동·질문 대기·입력 변경·다른 계획 버전은 승인을 거절한다.
5. 계획 실행 실패 후 원인을 해결하고 담당자가 **재시도** 댓글을 새로 남기면 계획만 다시 실행한다.
   이전 재시도 댓글은 다시 소비하지 않는다. 일반 댓글에 재시도라는 낱말을 포함하는 것만으로는 동작하지 않는다.
6. 기존 실행이 취소 대기면 종료를 확인한 뒤 최신 요청을 시작한다. `recovery_required`는 자동 재실행하지 않는다.
   워커 종료를 확인한 뒤 담당자의 "재시도" 댓글로 다시 실행한다(관리자는 `jobs resolve`/`jobs retry`, ADR 0062).
   실패한 Jira 반영은 `reports retry`로만 복구한다.
7. 구현 완료·결과 검토·PR merge·하위 작업 의존성·승인 철회는 기존 정책을 유지한다. 구현 재작업은
   AI 검토로 돌아와 새 계획을 완성한 뒤 다시 승인한다. 계획 `재시도` 댓글로 구현을 재실행하지 않는다.

웹 UI·`router issue show`는 `plan_requested`(대기), `planning`, `plan_needs_decision`, `plan_review`(승인 대기),
`plan_failed`, `plan_held`(취소·복구·막힌 보고)를 구분한다. 이벤트 중복은 SQLite의 요청 ID·소스 댓글로 억제한다.
Jira 웹훅에는 **댓글 생성/수정 이벤트도 포함**해야 한다. 이벤트가 없어도 기존 60초 보완 조회가 답변을 읽는다.

### 이전 두 상태 구성에서 전환

1. 이전 Router에서 배정을 멈추고 활성 실행의 종료를 확인한다. Worker spool과 미완료 보고를 정리한다.
2. `router backup`과 설정·비밀 파일 사본을 저장소 밖에 보관한다. Jira 이슈의 상태·활성 attempt도 기록한다.
3. Jira에 AI 검토 상태와 필요한 전이를 준비하고 `requestStatus`를 설정한다. `planReviewStatus`를 삭제한다.
   새 단일 상태 흐름으로 통일하며 자동 설정 변환이나 이전 두 상태 모드는 제공하지 않는다.
4. 업데이트한 Router를 시작하면 migration 16이 과거 job이 있는 이슈의 전환 기준선을 기록하고 열린 계획·배포를
   닫는다. 과거 요청·계획 승인은 자동 채택하지 않는다. 기존 이슈는 업그레이드 뒤 담당자가 AI 검토로 다시 옮긴다.
   이미 AI 검토에 있으면 나갔다 다시 들어온다. 기존 두 상태에 남겨 둔 이슈는 자동으로 옮기지 않는다.
   업그레이드한 DB에서는 이력이 없는 이슈를 AI 검토 상태로 직접 생성한 경우에도 나갔다 다시 들어와 위임을 명시한다.
5. Worker도 최신 빌드로 갱신하고 테스트 이슈로 질문 → 담당자 번호 답변 → 자동 재계획 → 수동 승인 → 구현을
   확인한다. 실제 Jira 상태와 계정·웹훅 설정은 자동 테스트가 검증하지 않는다.
6. 구버전으로 돌아갈 때는 백업한 DB·설정을 함께 복원한다. 새 DB를 그대로 구버전에 연결하지 않는다.
   Git 복귀만으로 Jira 상태·댓글·생성된 하위 이슈가 복구되지는 않는다.

## 37. 자식별 승인과 부모 완료 평가 (생명주기 v2, ADR 0051)

새 계획은 부모 직접 구현 없이 최소 한 개의 대기 자식을 생성한다. 부모는 AI 검토에 둔다.
실행할 자식을 사람이 작업 중으로 옮기면 해당 계약만 승인된다. 계획·개선 계약 게시가 끝나기 전에
작업 중으로 옮겼다면 나갔다 다시 옮겨야 한다. 부모를 작업 중으로 옮기면 새 흐름의 위임 철회로 처리된다.

모든 필수 자식이 완료·통합되면 Router가 quality_review를 배정한다. GitHub에서 최신 검토 head와
동일한 PR head, 실제 merge_commit_sha와 대상 base.ref를 얻을 수 있어야 한다. 수동 완료나 F01 확인은
병합 근거를 대신하지 않는다. Squash merge는 실제 병합 커밋으로 확인한다.

Worker와 Router의 baseBranch를 맞추고 Worker repository.validateCommand를 설정한다. 명령이 없거나
통합 커밋이 fetch 대상에 포함되지 않거나 저장소가 비 Git이면 평가를 통과시키지 않는다.
Router의 issue 화면과 부모 관리 영역에서 자식 완료 수·현재 평가 상태·필요 행동을 확인한다.

기술부채 질문은 부모에 한 개씩 올라온다. 현재 부모 담당자가 `1`, `2 사유`, `3 사유`, `4 사유`로 답한다.
1은 개선 계약 채택과 필수 자식 생성이며, 실행은 그 자식을 수동으로 작업 중에 옮겨야 한다.
2는 planning.followupIssueType(기본 Task)으로 별도 이슈를 만들며 현재 완료 조건에 추가하지 않는다.
3은 수용·기각, 4는 보류다. 2~4의 사유가 빠지면 다음 댓글로 이유를 입력한다.
결함·환경 장애·근거 부족은 1·4만 허용한다. 동일 근거의 기존 후속 이관·수용은 출처를 연결해 재사용하고
후속 티켓을 중복 생성하지 않는다. 검증은 새 대상에서 다시 수행한다.

평가 실패·대상 변경은 원인을 확인한 뒤 부모 담당자의 `재시도` 댓글로 다시 요청한다.
Worker 연결 유실로 recovery_required인 경우 워커 머신에서 실제 프로세스 종료를 확인한 뒤 담당자가 "재시도"
댓글을 남긴다(ADR 0062). 이전 실행이 남아 있었다면 같은 작업이 한 번 더 실행될 수 있다.
Jira 생성·보고 실패는 기존 `reports retry` 절차로 복구한다. 생성 결과가 불명확하면 Jira를 확인한다.

자식 실행 후 부모 요구사항을 수정하면 새 실행과 최종 전환을 보류한다. 실행 중 작업은 기존 계약으로 마치고,
종료 후 담당자가 `재계획` 댓글을 남긴다. 새 계획은 시작·완료한 자식을 명시적으로 보존해야 한다.
모든 판단·개선·통합 검증과 최종 최신성 확인이 끝나면 부모는 결과 검토로 이동한다. 최종 완료는 사람의 몫이다.

### 배포·복귀

1. Router의 신규 배정을 멈추고 실행 중 호출·Worker spool을 정리한다. 활성 업무 계획 전체를 취소하지 않는다.
2. `router backup`과 설정 사본을 저장소 밖에 보관한다.
3. Router와 Worker를 함께 빌드·업데이트한다. 프로토콜 4와 이전 버전은 실행 전에 426으로 거절된다.
4. migration 17은 기존 요청을 v1로 유지하고 새 요청부터 v2로 기록한다. 기존 계획은 원래 방식으로 마무리한다.
5. Jira에 부모 AI 검토 → 결과 검토 전이를 준비하고 `router check`와 설정 화면의 workflow 검사를 실행한다.
6. 실제 테스트 이슈로 자식 생성 → 수동 개별 실행 → PR 병합 → 평가 → 후보 판단·개선 → 부모 결과 검토를 확인한다.
7. 되돌릴 때는 이전 바이너리와 백업 DB·설정을 함께 복원한다. Jira에 쓴 댓글·생성 이슈는 Git 복귀로 취소되지 않는다.

## 38. Worker 콘솔 진행 표시

`worker start`와 `worker run`은 연결·대기, 이슈별 계획/구현/평가 시작, AI 실행·검증·커밋·업로드,
완료·실패·중단·사람 판단 필요를 짧은 줄로 표시한다. 장시간 같은 단계가 이어지면 30초마다 경과 시간을
표시한다. 대기는 상태가 바뀔 때만 출력하며 임의의 진행률이나 AI 원문을 출력하지 않는다.

`완료 · Router 전송 완료`는 로컬 작업이 끝나고 Router가 결과를 수신했다는 뜻이다. Jira 게시·검토·병합 완료와는
구분한다. `결과 보관됨, Router 전송 미완료`는 spool이 남은 상태다. 연결 복구 후 Worker 재시작 또는
기존 `worker results retry` 절차로 전송하고, `보관 결과 N건 전송 완료`를 확인한다.
상세 원인은 기존 JSON 로그와 `<워커 홈>/logs/<jobId>-<attemptId>.jsonl`을 확인한다.
빌드 업데이트는 다음 Worker 실행부터 적용한다. 작업 중인 프로세스를 강제 재시작하지 않는다.

## 39. 칸반 진행 상태와 선택적 리뷰 (ADR 0053)

1. Router와 Worker의 실행·spool을 정리한 뒤 같은 빌드를 배포한다. `npm run build` 후 둘을 재시작한다.
   Router 설정은 `configVersion: 6`이며 일곱 상태를 모두 지정한다. 구형 설정 자동 변환은 하지 않는다.
2. 첫 설정에서 Jira 프로젝트를 선택하면 누락된 AI 상태·전이를 자동 추가하고 안내한다.
   편집 권한 부족·공유 워크플로우·적용 대기는 화면의 안내를 해결한 뒤 다시 시도한다.
   기존 연결은 설정의 **AI 상태 자동 구성**으로 실행한다.
3. `AI 계획`은 수동 요청, `AI 계획중`은 실제 계획 실행 시작의 자동 표시다.
   번호 답변·제목/설명 수정으로 계획을 이어간다. 서브태스크는 각각 `AI 구현`으로 수동 승인한다.
   간단한 작업은 계획 없이 `AI 구현`으로 직접 요청할 수 있다.
4. PR 생성 후 `AI 통합 대기`에서 사람이 머지한다. 워커에 신뢰된 `repositories[].validateCommand`가
   있어야 통합 검증 후 `AI 구현 완료`로 자동 이동한다. 명령이 없거나 실패하면 완료하지 않는다.
   코드 변경 없는 작업에는 변경 불필요 이유와 검증 근거를 남긴다.
5. 부모는 첫 자식 실행 시 `AI 구현`으로 이동한다. 자식들의 통합 대기를 집계하고 모두 완료되면
   부모 인수 조건도 검증한다. 자식 재작업은 부모 진행·검증을 갱신한다.
6. 필요하면 `AI 리뷰`로 수동 이동하여 평가 댓글을 받는다. 평가 뒤에도 이 상태를 유지한다.
   지적은 권고다. `AI 구현`으로 수정, `AI 계획`으로 재계획하거나 `Done`으로 직접 완료한다.
   PR 머지나 AI 리뷰 결과로 자동 Done 처리하지 않는다.
7. 실패·답변 대기는 현재 단계의 라벨과 댓글로 확인한다. 원인 해결 후 담당자의 새 `재시도` 댓글은
   해당 실패 단계만 재실행한다. `recovery_required`도 워커 종료를 확인한 뒤 같은 "재시도" 댓글로 푼다(ADR 0062).
8. 보드는 여덟 열(해야 할 일과 일곱 상태)을 흐름 순서로 배치하고 카드에 레이블을 표시한다.

연결된 테스트 프로젝트 상태 확인은 `npx tsx tools/router-workflow-admin.ts`, 명시적 자동 구성은
`npx tsx tools/router-workflow-admin.ts --apply`로 수행할 수 있다. 이 도구는 자격 증명을 출력하지 않는다.


## 40. FCI 선택 기능과 리뷰 상태 제거

Router 설정 7 / Worker protocol 6 / DB migration 21을 함께 적용한다. 먼저 기존 실행·AI 리뷰·spool을 정리하고 DB와 설정을 백업한 다음 Router·Worker를 중지한다. `npx tsx tools/migrate-fci-config.ts`로 검증하고 `--apply`로 전환한다. 과거 리뷰 지침은 백업에 남고 FCI로 복사되지 않는다. 현재 6상태 정책은 README와 ADR 0055를 따른다. 기존 Jira AI 리뷰 상태에 남은 이슈를 올바른 상태로 옮긴 후 보드 열에서 제외하며 공유 상태를 임의 삭제하지 않는다.

기술부채 추이는 기본 비활성화다. 기술부채 추이 화면에서 비교 시작 커밋을 지정해 활성화한다. 정적 구조 평가에는 모델 입력이 필요하지 않다. 분석 실패, 보고 실패, 평가 불가를 구분하고 각각 분석 재시도·보고 재시도를 사용한다. 구현 재시도로 대체하지 않는다. 계산 규칙, 0기준 처리, 캐시, Unity 한계와 수동 검증 범위는 [FCI 문서](./fci.md)에 있다.

## 41. 부모 통합 PR과 병합 후 평가로 전환

이 절과 ADR 0056이 이전 절의 자식별 PR·필수 리뷰·병합 전 FCI 설명을 대체한다.
Router 설정 7은 유지하고 Worker protocol 7 / migration 22를 Router·Worker에 함께 적용한다.

1. 실행·불확실한 attempt와 일반/FCI spool을 정리한다. 백업한 뒤 Router·Worker를 중지한다.
2. `npx tsx tools/migrate-aggregate-pr.ts`로 전환 대상을 확인한다. 기본 실행은 읽기 전용이며
   `--apply`는 Router 중지와 실행/spool 정리를 확인하고 DB·설정 백업 후 migration을 적용한다.
3. `npx tsx tools/migrate-aggregate-pr.ts --apply`는 최신 승인·게시 커밋을 가진 기존 통합 대기 자식을
   구현 완료로 옮긴다. 모든 결과가 준비된 부모만 자동 조정으로 돌린다. Done은 다시 열지 않는다.
   누락·변경된 증거는 보류하고 자식 구현을 자동 재실행하지 않는다. 이미 병합된 커밋은 대상 브랜치
   조상 관계를 확인한 뒤 재적용하지 않는다.
4. 새 빌드로 Router·Worker를 시작한다. `assemble_pr`는 모든 자식 결과를 모아 부모 PR 하나를 만든다.
   대체 PR 생성 후 기존 미병합 자식 PR만 링크를 남기고 닫으며 브랜치는 보존한다.
5. 부모 PR을 사람이 병합하면 실제 병합 SHA에서 통합 검증을 실행한다. 통과하면 부모만 구현 완료다.
   FCI는 활성화된 경우 별도로 병합 후 분석한다. 기준점 분석은 PR 없이도 등록 시 수행한다.

충돌·PR 게시 실패는 부모 담당자의 새 `재시도` 댓글로 통합 생성 단계만 재실행한다. 통합 검증 실패도
원인 해결 후 같은 방식으로 검증만 재시도한다. FCI·Jira 보고는 각각의 재시도 기능을 사용한다.
이미 성공한 자식을 다시 AI 구현으로 옮길 필요가 없다. 실제 코드 수정이 필요하면 해당 자식이나 부모를
사람이 승인하여 구현한다. 전부 무변경인 경우 빈 PR과 가짜 FCI를 만들지 않고 부모 통합 검증만 수행한다.

되돌리기는 새 실행과 spool을 정리한 뒤 이전 바이너리·백업 DB·설정을 함께 복원한다. Jira 전이와
GitHub PR 종료는 DB 복원으로 취소되지 않으므로 전환 도구 출력과 실제 상태를 함께 확인한다.

## 42. 로컬 웹 UI의 토큰 로그인 임시 생략

`router.config.json`의 `http.localUiWithoutToken`을 `true`로 설정하고 Router를 재시작하면
`http://127.0.0.1:8787/ui/`에서 토큰 입력 없이 대시보드로 진입한다. 기본값은 꺼짐이다.
직접 연결된 loopback 주소, localhost/loopback Host, 같은 출처의 웹 UI 요청에만 적용한다.
일반 관리자 API·외부 접속·Worker·셋업 인증은 기존 방식을 유지하며 토큰을 브라우저로 보내지 않는다.
로그인을 다시 사용하려면 이 항목을 제거하거나 `false`로 바꾸고 Router를 재시작한다.

## 43. 정적 FCI와 커밋 이력으로 전환

일반 작업과 FCI 작업을 끝내고 Worker의 `spool`, `fci-spool`을 비운 뒤 Router와 Worker를 중지한다.
`npx tsx tools/migrate-fci-static.ts`로 미리 확인하고 `--apply`로 적용한다. 도구는 DB·설정을 백업하며,
활성 여부와 시작 커밋을 보존하고 기존 AI 채점 지침은 백업에 보관한다. 새 지침은 기술부채 변화 설명용이다.
두 프로세스를 protocol 8로 함께 시작한다. Router가 DB migration 23을 적용한다.

기술부채 추이 화면에서 비교 시작 커밋 검증과 기준 평가를 확인한다. 과거 이력은 `미평가 모두 평가` 또는
`다음 커밋 평가`로 채운다. 새 대상 브랜치 커밋은 자동 평가한다. 그래프가 비어 있으면 Worker 온라인,
대상 브랜치의 시작 커밋 포함 여부, 평가 상태·분석 범위를 확인한다. 모델 설정은 정적 평가와 무관하다.
AI 설명만 실패하면 설명 재시도를, Jira 보고만 실패하면 보고 재시도를 사용한다.
실패를 해결하기 위해 구현 작업을 다시 시작하지 않는다. 계산 규칙과 제약은 [FCI 문서](./fci.md)를 따른다.

## 44. 작업 중심 웹 UI

상단 메뉴는 대시보드·워커·기술부채 추이·설정·사용 가이드로 구성한다. 별도 검토·이슈·점검 메뉴는 사용하지 않는다.
Jira에서 계획·구현을 승인한 다음 대시보드 작업 목록에서 진행을 확인한다. 작업을 누르면 현재 Jira 상태,
대기·실패 이유, 다음 할 일, 최근 실행 결과와 PR을 볼 수 있다. 목록은 Router에 저장된 마지막 실행 기록이며
Jira 전체 이슈 목록이나 현재 상태를 대신하지 않는다. 키 검색으로 다른 작업을 직접 열 수도 있다.

작업 상세의 `결과 확인·의견 남기기 (선택)`은 사람이 의견을 기록하는 보조 기능이다. 확인 기록은 승인이나
완료 조건이 아니다. 보류 의견은 실행을 멈추지 않고 수정 요청은 AI를 재실행하지 않는다. 두 의견은 기존처럼
Jira 댓글로 전달된다. 실행·커밋·과거 판단 기록과 PR 병합 SHA 확인 로직은 보존한다.

최초 연결·설정 변경·연동 장애 때는 `설정 → 연동 진단`을 사용한다. Jira 인증·프로젝트·상태·전이·하위 작업
유형과 GitHub PR 조회 권한을 읽기 전용으로 확인하며, 코드를 실행하거나 자동 수정하지 않는다.
병합 후 통합 검증 및 FCI와 구분한다. 구 URL `#/issues`, `#/reviews`, `#/check`는 각각 작업 상세,
대시보드, 설정의 연동 진단으로 연결한다. 이 변경에 DB 마이그레이션이나 Worker 프로토콜 변경은 없다.

## 45. 신뢰 검증과 검증 방식 (ADR 0059)

구현 결과의 근거는 두 가지다. AI가 스스로 보고한 완료 조건 확인(`verification`)과, 워커가 커밋 뒤 직접 실행한
`repositories[].validateCommand` 출력(`validation`)이다. 뒤의 것만 GGJIRA가 만든 증거다.

- **댓글·작업 상세에 "워커 검증 명령이 실행되지 않았습니다. AI 자체 보고만 근거입니다"
  (`no_trusted_validation`)**: 그 워커의 저장소 설정에 `validateCommand`가 없다. `worker start`로 만든 설정은
  기본값이 `null`이라 모든 구현 결과가 개별 검토 대상과 확인 필요 항목이 된다. 워커 머신의
  `worker.config.json`에서 `repositories[].validateCommand`에 저장소의 검사 명령(예: `npm run check`,
  `dotnet test`)을 넣고 `npm run dev -- worker check`로 경고가 사라졌는지 본 뒤 워커를 재시작한다. 이 사유는
  자동 완료·부모 PR 조립을 막지 않는다.
- **검증 명령이 오래 걸림**: 명령은 job의 취소 신호와 별도의 `timeoutMs` 한도로 실행된다(AI 실행 시간과
  따로 센다). 한도를 넘기면 `GGJ-105` 시간 초과, Router가 취소하거나 임대를 잃으면 `cancelled`로 끝나고 push하지
  않는다. 커밋은 워커의 job 브랜치에 남는다.
- **완료 조건 줄의 `(실행)`·`(코드 확인)`**: AI가 보고한 확인 방식이다. `실행`은 명령·테스트를 돌려 결과를 봤다는
  뜻이고, `코드 확인`은 코드·문서를 읽고 판단했다는 뜻이다. 명령을 실행할 수 없는 에이전트(예: 기본 도구의 Claude
  Code)는 `코드 확인`을 써야 한다. 표시가 없으면 업그레이드 전 결과이거나 AI가 알 수 없는 값을 보냈다. 방식은
  집계(`router reviews`, 작업 상세)에만 쓰이고 검토 분류를 바꾸지 않는다.
- 기본 구현 지침에 이 규칙이 들어 있다. 업그레이드 전에 발급된 attempt는 이전 지침을 그대로 쓴다.
- **하위 작업에 "사람 확인 대기" 댓글**(ADR 0061): AI가 실패한 검증은 없지만 일부 완료 조건을 확인하지 못했다고
  보고했다(예: 화면을 띄울 수 없는 워커의 GUI 조건). 결과 커밋은 원격 브랜치에 보존됐고 이슈는 작업 중에 머문다.
  댓글에 적힌 조건을 직접 확인한 뒤 **Jira에서 이슈를 구현 완료로 옮긴다.** Router가 그 이동을 확인으로 기록하고
  (검토 기록 actor `jira`), 이 하위 작업에 의존하는 작업과 부모 PR이 진행된다. 웹 UI 검토 화면의 "결과 확인 기록"도
  같은 일을 한다. 실패한 결과나 승인 뒤 내용이 바뀐 결과는 손으로 옮겨도 완료로 치지 않는다. 문제가 있으면 옮기지
  말고 설명을 고쳐 다시 요청한다. 다시 실행해도 같은 조건은 다시 미확인으로 나온다.

## 46. GGJIRA 자체 변경 검증 절차

GGJIRA 코드를 바꾼 사람·AI 에이전트(Claude Code, Codex 등)가 완료를 보고하기 전에 따른다. CLAUDE.md
"완료의 정의"의 2번을 구체화한 것이다.

규칙:

- Jira는 `FakeJiraGateway`만, 네트워크는 `127.0.0.1` loopback만, 파일은 테스트가 만드는 임시 디렉터리만 쓴다.
- 실제 `router.config.json`, `router.env`, 워커 credential, 실제 Jira·AI CLI를 쓰지 않는다. 실제 연동 확인은
  사람이 `router check`·`worker check`로 따로 한다.
- 실행한 명령과 결과(통과 수, 실패 메시지)를 그대로 보고한다. 실행하지 못한 검사는 못 했다고 쓴다.

1단계 — 바꾼 영역의 테스트 파일을 하나씩 실행한다(`npx vitest run test/<file>`). Windows에서 멈추면 §13을 따른다.

| 바꾼 곳 | 실행할 테스트 | 볼 것 |
|---|---|---|
| `src/contracts/*` | `contracts-implementation`, `contracts-schemas`, `contracts-state-machines` | JSON Schema와 Zod 일치, 과거 결과 파싱 |
| `src/router/review-gate.ts`, 검토·확인 필요 | `router-review-gate`, `router-review-queue`, `router-attention` | 분류(`immediate`/`standard`)와 사유 코드 |
| Jira 댓글 문구·보고 | `router-comment-text`, `router-reporting` | 댓글 본문, 실패 로그 파일 내용 |
| 역할 지침 | `router-prompts` | 기본 지침 문구, envelope의 `systemPrompt` |
| 워커 실행·검증 명령 | `worker-scope`, `worker-push`, `worker-runtime-runner` | 단계 순서(commit·validate·push), 실패 시 push 없음 |
| 통합 검증 | `worker-quality-review`, `router-board-workflow` | 고정 SHA 검증, 상태 이동 |
| 워커 홈·설정·`worker start` | `worker-runtime-config`, `worker-start`, `worker-runtime-ops`, `cli` | 모든 경로가 홈 아래, GGJIRA 폴더 안 홈 거부 |
| 자식 완료·검토 판단·복구 | `router-board-workflow`, `router-review-queue`, `router-admin-api` | 사람 확인 대기 → Jira 이동 → 의존 작업·부모 PR, `recovery_required` → "재시도" |
| 워커 계층 경계 | `worker-runtime-no-jira` | `src/worker-runtime`이 Jira·Router DB를 import하지 않음 |
| Router + Worker 전체 | `router-integration`, `router-daemon` | loopback HTTP로 계획→승인→구현→보고가 한 번씩 |

2단계 — `npm run check`. Windows에서 멈추거나 `spawn EFTYPE`(§13)만 실패하면
`docker compose -f docker-compose.test.yml run --rm --build check`로 Linux에서 전체를 확인한다.

3단계 — 동작이 바뀌었으면 위 표의 테스트에 실패 → 수정 → 통과를 보이는 사례를 추가한다. 웹 UI만 바꾼 경우는
자동 테스트가 없으므로, 바꾼 화면 파일과 확인 방법을 보고에 적는다.

정리 — 테스트는 임시 디렉터리를 스스로 지운다. 중단된 실행이 남긴 `ggjira-*` 임시 폴더는 OS 임시 디렉터리에서 지운다.

## 47. 워커 홈 전환 (ADR 0060)

워커 설정 `configVersion 5`(GGJIRA 폴더 안 `worker.config.json`, `data/worker`, `data/worker-logs`)는 더 읽지 않는다.
`worker start`가 `… is configVersion 5 …` 오류로 멈추면 새 워커 홈으로 다시 설정한다. 자동 변환은 없다.

1. Router에서 그 워커의 실행 중 작업이 없는지 본다(`ggjira router status`). 있으면 끝나기를 기다린다.
2. 예전 위치에서 결과를 비운다: 워커를 멈춘 뒤 이전 빌드로 `worker results retry --config worker.config.json`을 실행해
   `still waiting 0`을 확인한다. 새 빌드에는 `--config`가 없다.
3. 새 빌드로 `npm run dev -- worker start`(또는 `run-worker.bat`)를 실행한다. 기본 홈
   (`%LOCALAPPDATA%\ggjira\worker`)에 첫 설정을 묻는다. 웹 UI > 워커에서 재페어링 코드를 받아 입력한다.
   저장소는 새로 clone되며, 기존 clone을 쓰려면 질문에 그 폴더 경로를 넣는다(GGJIRA 폴더 안의 clone은 쓰지 않는다).
4. 워커 홈의 `worker.config.json`에 `repositories[].validateCommand`를 다시 넣고 `worker check`로 확인한다.
5. 확인이 끝나면 GGJIRA 폴더의 `worker.config.json`, `data/worker-credential.json`, `data/worker/`, `data/worker-logs/`를
   지운다. 남겨 두면 그 안의 worktree가 다시 GGJIRA 지침을 읽을 위험만 남는다.

Router와 Worker를 함께 새 빌드로 재시작해야 ADR 0059·0061 동작(실패 로그의 Acceptance Checks 절, 사람 확인 대기)이
적용된다. 이미 발급된 attempt는 이전 지침과 규칙으로 끝난다.
