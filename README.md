# GGJIRA

Jira를 인간과 AI가 함께 쓰는 작업 인터페이스로 삼는 경량 오케스트레이션 시스템이다.
configVersion 6은 **Router 한 대**와 **Worker 여러 대**로 구성된다. Router와 Worker의 wire protocol은 5다.

```text
Jira ──Webhook──▶ Router ──▶ SQLite          사람: AI 계획 / AI 구현 / 선택적 AI 리뷰 요청
                   ▲                         Router: 계획중 → 구현 → 통합 대기 → 구현 완료
                   │ HTTPS long polling      Worker: 받은 job을 Claude Code / Codex CLI로 실행
          ┌────────┴────────┐
      Worker A          Worker B
```

- **Router**(`ggjira router serve`)만 Jira에 접근한다. 웹훅을 받고 60초마다 보완 조회를 한다. 승인·
  Assignee·의존성·계획 버전을 확인한 뒤 저장소·가용성이 맞는 워커에 배정한다. 결과는
  댓글·라벨·상태 전이로 Jira에 남긴다.
- **Worker**(`ggjira worker run`)는 Router에만 연결한다. 로컬 저장소와 AI CLI 로그인은 워커가 갖는다.
  Router는 `repositoryId`와 `providerId`만 보내고, 실제 경로·명령은 워커 설정이 정한다.
  `worker start`·`worker run` 콘솔은 대기, 이슈별 시작·현재 단계·완료와 결과 전송 여부를 한 줄씩 표시한다.
  긴 작업은 30초마다 경과 시간을 표시하고, 반복 대기 메시지는 생략한다.
- **Jira Assignee는 결과에 책임지는 사람**이다. AI 실행 중에도 바꾸지 않는다.
- **계획·구현 승인은 사람이 결정한다.** `AI 계획`으로 옮기면 계획을 요청하고, 실제 실행이 시작되면
  `AI 계획중`으로 자동 이동한다. 담당자의 번호 댓글로 질문에 답할 수 있다. 서브태스크는 각각 `AI 구현`으로
  옮겨 승인하며, 간단한 작업은 계획 없이 제목·설명을 기준으로 바로 구현할 수 있다.
- **구현 완료는 통합·검증 완료다.** PR이 준비되면 `AI 통합 대기`로 이동하고, 사람이 머지한 뒤 워커의
  신뢰된 검증 명령이 통과하면 `AI 구현 완료`로 이동한다. 부모는 첫 자식 실행부터 진행을 표시하고 자식 전체의
  통합·검증을 집계한다. 코드 변경 없는 작업은 불필요한 이유와 검증 근거를 보고하여 바로 완료할 수 있다.
- **AI 리뷰는 선택 사항이다.** `AI 리뷰`로 수동 이동하면 기술 부채·결함·수정 제안을 댓글로 남긴다.
  지적 해결은 강제 조건이 아니며, `Done`은 항상 사람이 결정한다. 자세한 흐름과 초기 연결 자동 상태 추가는
  [ADR 0053](./docs/decisions/0053-board-workflow-and-optional-review.md)와 runbook §39를 따른다.

구조와 동작은 [`docs/architecture.md`](./docs/architecture.md), 운영·장애 대응은
[`docs/runbook.md`](./docs/runbook.md), 설계 판단은 [`docs/decisions/`](./docs/decisions/)
(0018~0022)에 있다. v4(각 머신이 Jira를 폴링하던 구조)는 제거했다. 전환 절차는 runbook §19에 있다.

## 요구 사항

- Node.js 24 (`.nvmrc`), git
- Router 서버: Docker Engine + Compose, 이 서버를 가리키는 도메인(HTTPS, Caddy가 인증서 발급)
- Jira Cloud: Router용 계정 1개와 API token. 필요한 권한은 Browse, Transition Issues, Add Comments,
  Edit Issues, Create Issues(계획이 하위 이슈를 만들 때)다. 관리자 웹훅을 만들 수 있어야 한다.
  초기 연결의 AI 상태 자동 추가에는 프로젝트 워크플로우 편집 권한이 필요하다. 권한 부족·공유 워크플로우·적용 대기는 설정 화면에서 안내한다.
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
| `requestStatus` | AI 검토 | 부모의 계획·자식 실행·완료 평가 관리 |
| `inProgressStatus` | 작업 중 | 사람이 실행할 자식을 옮기면 해당 계약만 승인 |
| `reviewStatus` | 결과 검토 | 자식 구현 결과 또는 부모 품질 평가 통과 후 Router가 옮김 |
| `doneStatus` (선택) | 완료 | 워커가 연 PR이 머지되면 Router가 옮김. 의존성은 여기에 와야 풀린다 |

자식은 작업 중 → 결과 검토(→ 완료), 부모는 AI 검토 → 결과 검토 → 수동 완료 전이가 필요하다.
프로토콜 4이므로 Router와 Worker를 함께 갱신한다. 기존 계획은 기존 생명주기로 마무리한다.
새 흐름은 Git 통합 근거와 Worker의 `validateCommand`가 필요하다. 가용한 Worker는 계획·구현·완료 평가를 모두 수행한다. 예전 `planReviewStatus`·`planningStatus`·`needsDecisionStatus`·`mode` 설정은 오류로
거절한다(runbook §36).

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
Windows에서는 `run-all.bat`(Router와 Worker 창을 함께 연다, runbook §33)을, 그 밖에는 `ggjira router serve`만 실행해 `http://127.0.0.1:8787/ui/`의 마법사를 쓰거나, `ggjira router setup`으로
설정 템플릿과 새 secret을 만든다(개발용. 운영은 HTTPS 뒤에 둔다). 실행 중에는 같은 `/ui/`에서 워커
상태, 페어링, 설정 편집(저장 즉시 적용), Jira 점검을 할 수 있다.

## 3. Worker 붙이기

1. Router 웹 UI > **워커** > **워커 추가**에서 workerId, 저장소를 고른다. 정책이 저장,
   적용되고 페어링 코드(10분, 1회용)가 표시된다.
2. 워커 머신의 ggjira 폴더에서 실행하고, 묻는 대로 답한다(Router 주소, LLM, 페어링 코드, 필요하면
   저장소 폴더).

```bash
cd <ggjira 폴더>
npm run dev -- worker start      # 처음에는 설정을 묻고, 이후에는 바로 실행
```

`npm run dev --`는 이 레포의 CLI를 실행한다(`--` 뒤가 ggjira에 넘어가는 인자). `npm run build && npm link`로
설치하면 어디서든 `ggjira worker start`로 쓸 수 있다. 저장소 설정에 `cloneUrl`을 넣어 두면 워커가 직접
clone한다(설정 > 저장소). token은 credential 파일(`data/worker-credential.json`)에만 저장된다. 손으로
구성하려면 `worker setup` 후 `worker.config.json`(예시 `worker.config.example.json`)을 채우고 `worker run`을 쓴다.

Git 저장소에서는 계획·구현·리뷰를 시작하기 전에 기준 브랜치(`baseBranch`)를 리모트에서 fetch하고,
받아온 커밋에서 작업별 worktree를 만든다. 리모트는 `pushRemote` 설정값(없으면 `origin`)을 사용한다.
공유 체크아웃의 브랜치와 로컬 수정은 유지하며, fetch 실패 시 오래된 코드로 작업을 계속하지 않는다.

## 운영 명령

`설정 → 프롬프트`에서 플랜·구현·리뷰의 기본 지침과 입력 예시를 확인하고, 역할별 추가 지침을
편집·저장할 수 있다. 추가 지침은 Router 전체에 공통 적용되며 새로 Worker에 전달되는 실행부터
사용한다. 실행 중인 작업의 지침은 유지된다. 초기화 후 저장하면 기본 지침만 적용된다.
통합 검증은 AI를 호출하지 않는 자동 검사이므로 별도 프롬프트를 설정하지 않는다.

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
