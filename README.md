# GGJIRA

Jira를 인간과 AI가 함께 쓰는 작업 인터페이스로 삼는 경량 오케스트레이션 시스템이다.
configVersion 5는 **Router 한 대**와 **Worker 여러 대**로 구성된다.

```text
Jira ──Webhook──▶ Router ──▶ SQLite          사람: 이슈를 "AI 작업 요청"으로 옮긴다 (= 실행 승인)
                   ▲                         Router: 승인 확인 → job 생성 → 워커 배정 → Jira에 보고
                   │ HTTPS long polling      Worker: 받은 job을 Claude Code / Codex CLI로 실행
          ┌────────┴────────┐
      Worker A          Worker B
```

- **Router**(`ggjira router serve`)만 Jira에 접근한다. 웹훅을 받고 60초마다 보완 조회를 한다. 승인·
  Assignee·의존성·계획 버전을 확인한 뒤 capability·저장소·가용성이 맞는 워커에 배정한다. 결과는
  댓글·라벨·상태 전이로 Jira에 남긴다.
- **Worker**(`ggjira worker run`)는 Router에만 연결한다. 로컬 저장소와 AI CLI 로그인은 워커가 갖는다.
  Router는 `repositoryId`와 `providerId`만 보내고, 실제 경로·명령은 워커 설정이 정한다.
- **Jira Assignee는 결과에 책임지는 사람**이다. AI 실행 중에도 바꾸지 않는다.
- 계획(PM)은 선택 기능이다. workspace에 `planningStatus`를 설정하면, 그 상태의 이슈는 워커가 계획을
  세우고 Router가 부모 이슈에 계획을 기록하고 하위 이슈를 만든다.

구조와 동작은 [`docs/architecture.md`](./docs/architecture.md), 운영·장애 대응은
[`docs/runbook.md`](./docs/runbook.md), 설계 판단은 [`docs/decisions/`](./docs/decisions/)
(0018~0022)에 있다. v4(각 머신이 Jira를 폴링하던 구조)는 제거했다. 전환 절차는 runbook §19에 있다.

## 요구 사항

- Node.js 24 (`.nvmrc`), git
- Router 서버: Docker Engine + Compose, 이 서버를 가리키는 도메인(HTTPS, Caddy가 인증서 발급)
- Jira Cloud: Router용 계정 1개와 API token. 필요한 권한은 Browse, Transition Issues, Add Comments,
  Edit Issues, Create Issues(계획 사용 시)다. 관리자 웹훅을 만들 수 있어야 한다.
- 각 Worker 머신: 로그인된 [Claude Code CLI](https://claude.com/claude-code) 또는
  [Codex CLI](https://github.com/openai/codex)와 작업할 저장소 clone. Codex provider는 실제
  CLI로 아직 검증하지 않았다(ADR 0010).

```bash
git clone https://github.com/hokim84/ggjira.git
cd ggjira
nvm use && npm install        # 워커 머신은 npm run build 후 `node dist/cli.js` 또는 npm link
```

## 1. Jira 준비

프로젝트 workflow에 다음 상태를 둔다(이름은 자유).

| 설정 키 | 예 | 의미 |
|---|---|---|
| `requestStatus` | AI 작업 요청 | 사람이 이 상태로 옮기면 구현 실행 승인 |
| `inProgressStatus` | 작업 중 | Router가 실행 시작 시 옮김. 실패하면 여기 머문다(`ggjira-failed` 라벨) |
| `reviewStatus` | AI 작업 완료 | 성공 시 Router가 옮김. Done 처리는 사람이 한다 |
| `planningStatus` (선택) | AI 계획 요청 | 이 상태면 계획 job이 된다 |
| `needsDecisionStatus` (선택) | 결정 필요 | 계획이 사람의 결정을 요청할 때. 없으면 `reviewStatus` |

요청 → 작업 중 → 완료로 가는 전이가 있어야 한다. 이슈 설명에 `h2. Required Capabilities` 절(예:
`* programming`)을 두면 그 capability를 가진 워커만 배정된다.

## 2. Router 띄우기

가장 쉬운 방법은 웹 셋업이다. 설정 없이 Router를 띄우면 `https://<도메인>/ui/`에 셋업 마법사가
열리고, 컨테이너 로그에 일회용 setup token이 찍힌다(runbook §20). 수동으로 하려면:

```bash
mkdir -p deploy/config && sudo chown 1000:1000 deploy/config
cp deploy/router.config.example.json deploy/config/router.config.json   # Jira URL, workspaces, 상태, workers
cp deploy/router.env.example deploy/config/router.env                   # Jira token과 secret 2개 입력
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"   # secret 생성
export GGJIRA_DOMAIN=router.example.com
docker compose up -d --build
docker compose exec router node dist/cli.js router check --issue PROJ-1   # 상태·전이 확인
```

Jira 관리자 웹훅은 URL `https://router.example.com/webhooks/jira`로 만들고, secret은
`GGJIRA_WEBHOOK_SECRET`와 같게 둔다. 필터는 프로젝트 기준이다(runbook §16). Docker 없이 띄우려면
`ggjira router serve`만 실행해 `http://127.0.0.1:8787/ui/`의 마법사를 쓰거나, `ggjira router setup`으로
설정 템플릿과 새 secret을 만든다(개발용. 운영은 HTTPS 뒤에 둔다). 실행 중에는 같은 `/ui/`에서 워커
상태, 페어링, 설정 편집(저장 즉시 적용), Jira 점검을 할 수 있다.

## 3. Worker 붙이기

Router 설정 `workers[]`에 워커를 선언한다(허용 capability·저장소). 그다음:

```bash
# Router 쪽 (컨테이너 안, 또는 --url https://… 와 GGJIRA_ADMIN_TOKEN으로 밖에서)
ggjira router workers pair worker-1

# Worker 머신
ggjira worker setup --router https://router.example.com --pairing-code <code> --config worker.config.json
#  → worker.config.json의 repositories[].path, providers, capabilities를 채운다
ggjira worker check --config worker.config.json
ggjira worker run --config worker.config.json
```

`worker.config.example.json`이 예시다. token은 credential 파일에만 저장된다.

## 운영 명령

```text
ggjira router status                       큐 대기, 워커 연결, recovery 대기, 웹훅 지연, 막힌 보고
ggjira router workers list|pair|disable|enable|revoke
ggjira router jobs list|show|cancel|retry|resolve
ggjira router reports list|retry <batchId>   Jira 반영만 재시도(워커 재실행 없음)
ggjira router reconcile                    즉시 보완 조회
ggjira router backup                       SQLite 온라인 백업 (복원: runbook §17)
ggjira worker results retry                spool에 남은 결과 재전송
ggjira worker worktrees prune [--older-than-days 7] [--dry-run]
```

실행 중 연결이 끊겨 결과가 불명확한 job은 자동으로 다시 실행하지 않는다(`recovery_required`).
워커 머신에서 멈췄는지 확인한 뒤 `jobs resolve`(닫기) 또는 `jobs retry`(새 attempt)를 한다.

## 알려진 제한

- Router는 단일 인스턴스다(SQLite). 이중화하지 않는다.
- 웹훅은 이슈 단위가 아니라 전체 후보 조회 한 번으로 합쳐서 처리한다. 후보가 매우 많으면 조회 비용이
  커진다(ADR 0022).
- 새 하위 이슈가 Jira 기본 상태로 생성될 때 그 상태가 요청 상태가 아닌지는 REST로 확인할 수 없다.
  `router check`가 수동 확인 항목으로 알려 준다.
- 실제 Jira 웹훅, 각 AI CLI, 실제 여러 머신 구성은 자동 테스트 대상이 아니다. `router check`,
  `worker check`와 테스트 이슈 1건으로 직접 확인한다.

## 개발

```bash
npm run check          # typecheck + lint + format:check + test (CI와 동일)
npm run dev -- --help  # tsx로 CLI 실행
docker compose -f docker-compose.test.yml run --rm --build check   # Linux에서 전체 check
```

작업 규칙은 [`CLAUDE.md`](./CLAUDE.md)에 있다. 이 Windows 개발 머신의 테스트 실행 문제는 runbook
§13을 본다.
