# GGJIRA

Jira를 인간과 AI가 함께 쓰는 작업 인터페이스로 삼는 경량 오케스트레이션 시스템이다.
configVersion 7은 **Router 한 대**와 **Worker 여러 대**로 구성된다. Router와 Worker의 wire protocol은 8이다.

```text
Jira ──Webhook──▶ Router ──▶ SQLite          사람: AI 계획 / AI 구현 / FCI 선택 활성화
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
- **자식 완료 후 부모 PR 하나를 만든다.** 자식은 구현·자체 테스트와 원격 결과 커밋 보존 후 `AI 구현 완료`가 된다.
  의존 자식은 선행 결과 커밋을 사용하며 병합을 기다리지 않는다. 모두 완료하면 `assemble_pr`가 부모 통합 PR을
  자동 생성하고 부모를 `AI 통합 대기`로 옮긴다. 사람이 병합한 뒤 신뢰된 통합 검증에 통과하면 부모도
  `AI 구현 완료`가 된다. Done은 수동이다. 전부 무변경이면 빈 PR 없이 부모 통합 검증을 진행한다.
- **기술부채 추이(FCI)는 선택 기능이다.** 저장소별 기본 비활성화 상태이며 비교 시작 커밋을 지정하면 대상 브랜치의 구조 변화를 단일 그래프로 추적한다. 과거 커밋은 버튼으로 평가하고 새 커밋은 자동 평가한다. 구조 부채 지수는 모든 기술부채나 실제 개선 비용을 측정한 값은 아니다.
  원점수와 기준 100 지수를 구분하고 근거·불확실성을 보존한다. 점수나 분석 실패는 승인·상태 전이를 막지 않는다.
  기존 일반 AI 리뷰 상태는 제거했다. 설정·계산·제약은 [FCI 문서](./docs/fci.md)를 따른다.

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

프로젝트에서 다음 여섯 상태와 전이를 사용한다. 초기 연결 시 누락된 상태·전이를 안내와 함께 구성한다.

| 설정 키 | 기본 상태 | 진입 |
|---|---|---|
| requestStatus | AI 계획 | 사람이 계획 요청 |
| planningInProgressStatus | AI 계획중 | 실제 계획 실행 시 자동 |
| inProgressStatus | AI 구현 | 사람의 개별 구현 승인 |
| integrationPendingStatus | AI 통합 대기 | 부모 통합 PR 또는 단독 작업 PR 게시 후 자동 |
| implementationCompleteStatus | AI 구현 완료 | 자식: 구현·자체 테스트·커밋 보존 / 부모·단독: 실제 병합·통합 검증 성공 |
| doneStatus | Done | 사람이 최종 완료 |

FCI는 별도 Jira 상태를 사용하지 않는다. 분석과 보고는 구현·통합 검증과 독립적이다.
업그레이드 시 실행·spool을 정리하고 Router와 Worker를 함께 갱신한다. v6 설정 전환은
[FCI 운영 문서](./docs/fci.md)의 절차와 tools/migrate-fci-config.ts를 사용한다.

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
상태, 페어링, 설정 편집(저장 즉시 적용), 연동 진단을 할 수 있다.
대시보드의 작업 목록에서 작업 상세를 열어 현재 단계·대기 이유·다음 행동을 확인한다.
결과 확인·의견 기록은 작업 상세의 선택 기능이며 승인·병합·완료를 대신하지 않는다.
Jira/GitHub 연결 문제는 **설정 → 연동 진단**에서 확인한다.

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

`설정 → 프롬프트`에서 플랜·구현·기술부채 변화 설명의 기본 지침과 입력 예시를 확인하고, 역할별 추가 지침을
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
