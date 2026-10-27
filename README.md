# GGJIRA

Jira 이슈를 AI에게 맡기고, 사람은 승인과 결과 확인만 하도록 돕는 경량 오케스트레이션 시스템이다.

```text
Jira ──웹훅──▶ Router (서버 1대 + SQLite) ──▶ Jira에 댓글·상태 반영
                 ▲
                 │ HTTPS long polling
        ┌────────┴────────┐
     Worker A          Worker B       각 머신에서 Claude Code / Codex CLI로 실행
```

- **Router**(`ggjira router serve`)만 Jira에 접근한다. 승인된 이슈를 찾아, 저장소가 맞고 비어 있는
  워커에 작업을 배정한다. 결과는 Jira 댓글과 상태로 남긴다.
- **Worker**(`ggjira worker run`)는 Router에만 연결한다. 받은 작업을 AI CLI로 실행하고 결과를 돌려준다.
  저장소와 AI CLI 로그인은 워커 머신에 있다.
- **사람**은 계획과 구현을 승인하고 Done을 직접 옮긴다. Jira Assignee는 결과 책임자이며 AI가 바꾸지 않는다.

configVersion 7, Router–Worker protocol 8 기준이다.

## 작업 흐름

| 단계 | Jira 상태 | 하는 일 |
|---|---|---|
| 계획 | AI 계획 → AI 계획중 | 사람이 이슈를 옮기면 AI가 계획을 세우고 Router가 하위 이슈를 만든다. AI 질문에는 번호 댓글로 답한다 |
| 구현 승인 | AI 구현 | 사람이 하위 이슈를 하나씩 옮긴다. 간단한 작업은 계획 없이 바로 구현할 수 있다 |
| 자식 완료 | AI 구현 완료 | AI가 구현·검증하고 결과 커밋을 원격에 남긴다. AI가 확인하지 못한 조건이 있으면 사람이 확인하고 직접 옮긴다. 뒤에 실행되는 자식은 앞 자식의 커밋을 이어서 쓴다 |
| 부모 통합 | AI 통합 대기 | 자식이 모두 끝나면 부모 PR 하나를 자동으로 만든다 |
| 병합 후 | AI 구현 완료 → Done | 사람이 PR을 병합하고 통합 검증을 통과하면 완료된다. Done은 사람이 옮긴다 |

## AI 결과 검증

AI가 "완료했다"고 보고해도 GGJIRA는 그 말만 믿지 않는다.

- **워커 검증 명령:** 워커가 AI와 별개로 저장소의 검증 명령(예: `npm test`)을 직접 실행한다.
  GGJIRA가 스스로 만드는 증거는 이것 하나다. 작업이 취소되거나 제한 시간을 넘기면 함께 멈춘다.
- **검증 명령이 없으면 개별 검토:** 검증 명령 없이 끝난 구현 결과에는 "AI 자체 보고만 근거"라는
  표시가 붙고, 확인 필요 항목에 올라간다. 자동 완료나 부모 PR 생성을 막지는 않는다.
- **확인 방식 표시:** AI는 완료 조건마다 직접 실행해 봤는지(`실행`), 코드만 읽고 판단했는지(`코드 확인`)를
  밝힌다. Jira 댓글과 웹 UI에는 `통과(실행)`처럼 표시된다. AI의 자기 보고라서 판정에는 쓰지 않는다.
- **확인하지 못한 조건은 사람이 확인:** AI가 화면 확인처럼 직접 확인할 수 없는 조건을 "미확인"으로 정직하게
  보고하면, 하위 작업은 실패하지 않고 결과 커밋을 보존한 채 "AI 구현 완료"로 이동한다. 확인하지 못한 조건은
  댓글과 검토 화면에 남으니 부모 PR을 병합하기 전에 사람이 확인한다(ADR 0061·0066). 검증에 실패한 조건이 있으면
  그대로 실패다.
- **공통 구현 지침:** 어떤 AI든 같은 기본 지침을 받는다.
  - 하지 않은 실행을 했다고 쓰지 않는다.
  - 실행 계약의 완료 조건만 검증한다. 저장소 밖(상위 폴더 등)의 지침은 따르지 않는다.
  - 버그를 고칠 때는 버그 때문에 실패하는 확인을 먼저 만든다.
  - 확인한 원인만 고친다.
  - 계약·저장 데이터를 바꾸면 그것을 쓰는 곳을 확인한다.

워커 홈의 `worker.config.json`에서 `repositories[].validateCommand`를 지정한다. 지정하지 않으면
`worker check`가 경고한다. 자세한 내용은 [runbook §45](./docs/runbook.md)와
[ADR 0059](./docs/decisions/0059-trusted-validation-and-evidence-method.md)에 있다.

## pstack에서 가져온 것

[pstack](https://github.com/backnotprop/pstack)은 AI 코딩 에이전트가 조사·구현·검증하는 절차를
`SKILL.md`로 정리한 도구 모음이다(MIT). GGJIRA는 pstack을 설치하지 않고 검증 원칙만 가져와 Router
프롬프트와 결과 형식에 넣었다. 그래서 Claude Code를 쓰든 Codex를 쓰든 같은 규칙이 적용된다.

| pstack | GGJIRA에 반영한 내용 |
|---|---|
| `tdd` | 버그 수정은 실패하는 확인을 먼저 만들고, 수정 전과 수정 후 결과를 모두 보고한다 |
| `blast-radius` | 증거가 얼마나 확실한지 구분한다(`실행`/`코드 확인`). 계약·저장 데이터를 바꾸면 그것을 쓰는 곳을 확인한다 |
| `automations/benny` | 확인된 원인만 고친다. AI 보고보다 직접 실행한 증거를 중시한다. 외부 게시는 한 곳에서만 한다(Router만 Jira에 쓰는 기존 원칙과 같다) |
| 검증 skill | GGJIRA를 개발할 때의 검증 절차를 Claude·Codex가 함께 읽는 문서([runbook §46](./docs/runbook.md), `AGENTS.md`)로 만들었다 |

가져오지 않은 것도 있다.
- 여러 모델 교차 리뷰(`interrogate`): 범용 AI 리뷰를 폐지한 결정(ADR 0055)과 맞지 않는다.
- 전체 자동화 모드(`poteto-mode`): 작업 분배를 맡는 GGJIRA와 역할이 겹친다.

분석 전체는 [docs/pstack-adoption-analysis.md](./docs/pstack-adoption-analysis.md)에 있다.

## 시작하기

### 요구 사항

- Router 서버: Docker Engine + Compose, HTTPS 도메인(Caddy가 인증서 발급)
- Jira Cloud: Router용 계정 1개와 API token
  - 권한: Browse, Transition Issues, Add Comments, Edit Issues, Create Issues
  - 관리자 웹훅을 만들 수 있어야 한다.
  - AI 상태를 자동으로 추가하려면 워크플로우 편집 권한도 필요하다.
- Worker 머신
  - Node.js 24 이상, git
  - 로그인된 [Claude Code CLI](https://claude.com/claude-code) 또는 [Codex CLI](https://github.com/openai/codex).
    Codex provider는 실제 CLI로 아직 검증하지 않았다(ADR 0010).
  - 작업할 저장소

Router 이미지와 `ggjira` npm 패키지는 같은 버전으로 함께 릴리스된다([Releases](https://github.com/hokim84/ggjira/releases)).

### 1. Router 띄우기

가장 쉬운 방법은 웹 셋업이다. 설정 파일 없이 Router를 띄우면 `https://<도메인>/ui/`에 셋업 마법사가 열린다.
일회용 setup token은 컨테이너 로그에 찍힌다(runbook §20). 마법사는 Jira에 빠진 AI 상태·전이도 안내하며 구성한다.

```bash
git clone https://github.com/hokim84/ggjira.git && cd ggjira      # compose 파일과 Caddy 설정
mkdir -p deploy/config && sudo chown 1000:1000 deploy/config
export GGJIRA_DOMAIN=router.example.com
docker compose up -d                                               # 릴리스 이미지를 받아 실행
docker compose logs router | grep -A1 "setup token"                # 웹 셋업 token
docker compose exec router node dist/cli.js router check --issue PROJ-1   # 상태·전이 확인
```

`GGJIRA_VERSION=0.2.0`처럼 이미지 버전을 고정할 수 있다. Cloudflare Tunnel로 포트를 열지 않고 띄우는
방법은 runbook §16-1에 있다.

설정을 손으로 쓰려면 `deploy/router.config.example.json`과 `deploy/router.env.example`을
`deploy/config/`에 복사해 채운다. Jira 웹훅은 `https://<도메인>/webhooks/jira`로 만들고, secret은
`GGJIRA_WEBHOOK_SECRET`와 같게 둔다(runbook §16).

Docker 없이 한 대에서 시험해 보려면 `npm install -g ggjira` 뒤 `ggjira router serve`를 실행하고
`http://127.0.0.1:8787/ui/`를 연다. 운영에서는 HTTPS 뒤에 둔다. Windows에서는 checkout의 `run-all.bat`가
Router와 Worker를 함께 띄운다(runbook §33).

### 2. Worker 붙이기

1. Router 웹 UI의 **워커 → 워커 추가**에서 workerId와 저장소를 고른다. 페어링 코드(10분, 1회용)가 나온다.
2. 워커 머신에서 실행하고 묻는 대로 답한다(Router 주소, AI CLI, 페어링 코드, 저장소 폴더).

```bash
npm install -g ggjira            # Router와 같은 버전
ggjira worker start              # 처음에는 설정을 묻고, 이후에는 바로 실행
ggjira worker check              # 연결·저장소·검증 명령 점검
```

워커의 설정·인증 파일·clone·작업 폴더·로그는 모두 **워커 홈** 한 곳에 둔다. 기본값은 설치한 패키지면
`%LOCALAPPDATA%\ggjira\worker`(Windows), `~/.ggjira/worker`(그 밖), GGJIRA checkout에서 실행하면 그 안의 `data/worker`이고,
`--home`이나 `GGJIRA_WORKER_HOME`으로 바꾼다. 워커 홈이 다른 프로젝트 안에 있어도 작업 중인 AI는 작업 저장소 위 폴더의
CLAUDE.md·AGENTS.md를 읽지 않는다. 워커가 Claude Code·Codex에 그 파일을 빼라고 넘긴다(ADR 0065).

워커는 작업마다 기준 브랜치를 리모트에서 새로 받아 별도 worktree에서 작업한다. 받아 오지 못하면
진행하지 않는다. 마지막으로 워커 홈의 `worker.config.json`에 저장소별 `validateCommand`를 넣는다([AI 결과 검증](#ai-결과-검증)).

## 웹 UI

Router가 `/ui/`로 제공한다.

- **작업:** 목록·상세에서 현재 단계, 대기 이유, 다음 행동, 검증 결과를 본다.
- **워커:** 연결 상태와 페어링
- **설정:** 저장하면 바로 적용된다.
  - 프롬프트: 플랜·구현·기술부채 설명의 기본 지침을 보고, 역할별 추가 지침을 편집한다. 새로 시작하는 작업부터 적용된다.
  - 연동 진단: Jira·GitHub 연결 문제를 확인한다.
- **기술부채 추이(FCI):** 저장소별 선택 기능이다. 대상 브랜치의 구조 변화를 그래프로 추적하며,
  승인이나 상태 전이에는 영향을 주지 않는다([docs/fci.md](./docs/fci.md)).

## 운영 명령

```text
ggjira router status                       큐, 워커 연결, recovery 대기, 웹훅 지연, 막힌 보고
ggjira router workers list|pair|disable|enable|revoke
ggjira router jobs list|show|cancel|retry|resolve
ggjira router reports list|retry <batchId>   Jira 반영만 재시도(워커 재실행 없음)
ggjira router reconcile                    즉시 보완 조회
ggjira router backup                       SQLite 온라인 백업(복원: runbook §17)
ggjira worker check                        워커 설정·연결 점검
ggjira worker results retry                남은 결과 재전송
ggjira worker worktrees prune [--older-than-days 7] [--dry-run]
```

실행 중 연결이 끊겨 결과가 불확실한 작업은 자동으로 다시 실행하지 않는다(`recovery_required`). Router가 Jira에
안내 댓글을 달고, 워커가 멈춘 것을 확인한 뒤 담당자가 "재시도" 댓글을 남기면 새로 실행한다(ADR 0062).
관리자는 `jobs resolve`(닫기)나 `jobs retry`(새로 실행)를 쓸 수도 있다.
업그레이드할 때는 Router(`docker compose pull && docker compose up -d`)와 Worker(`npm install -g ggjira@<버전>`)를
같은 버전으로 함께 갱신한다.

## 알려진 제한

- Router는 단일 인스턴스다(SQLite). 이중화하지 않는다.
- 웹훅이 오면 이슈 하나가 아니라 후보 전체를 다시 조회한다. 후보가 아주 많으면 비용이 커진다.
- 실제 Jira, AI CLI, 여러 머신 구성은 자동 테스트하지 않는다. `router check`, `worker check`,
  테스트 이슈 1건으로 직접 확인한다.

## 문서와 개발

- 구조: [docs/architecture.md](./docs/architecture.md)
- 운영·장애 대응: [docs/runbook.md](./docs/runbook.md)
- 설계 결정: [docs/decisions/](./docs/decisions/)
- 작업 규칙: [CLAUDE.md](./CLAUDE.md). Codex 등 다른 에이전트는 [AGENTS.md](./AGENTS.md)를 본다.
- 기여·릴리스: [CONTRIBUTING.md](./CONTRIBUTING.md), 보안 신고: [SECURITY.md](./SECURITY.md)
- 지난 계획과 작업 기록: [docs/history/](./docs/history/)

```bash
git clone https://github.com/hokim84/ggjira.git && cd ggjira && npm install
npm run check          # typecheck + lint + format:check + test (CI와 동일)
npm run dev -- --help  # CLI 실행
docker compose -f docker-compose.test.yml run --rm --build check   # Linux에서 전체 검사
```

무엇을 바꿨을 때 어떤 테스트를 돌릴지는 runbook §46에 있다. Windows에서 테스트가 멈추면 runbook §13을 본다.

## 라이선스

[MIT](./LICENSE)
