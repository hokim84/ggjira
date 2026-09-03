# GGJIRA

Jira를 인간과 AI Agent가 공유하는 작업 인터페이스로 사용하는 경량 프로젝트 오케스트레이션
시스템이다. 동일한 Agent Runtime이 설정만으로 두 역할 중 하나로 동작한다.

```
pm          — 요구사항 이슈를 분석해 Plan을 만들고, 실행 가능한 하위 티켓을 만들어
              implement 역할의 Jira 계정에 할당한다. 중요한 선택이 필요하면 이슈를
              "Needs Decision"으로 넘기고 인간의 결정을 기다린다.
implement   — 자신에게 할당된(assignee) 준비 상태 이슈를 발견해 claim하고, Claude Code
              CLI 또는 Codex CLI로 구현한 뒤 결과를 Jira에 기록한다.
```

PM은 Implement 프로세스를 직접 실행하지 않는다 — Jira의 Assignee/Workflow State를 통해
작업이 전달되며, 여러 머신의 Implement Agent가 각자 독립적으로 작업을 가져간다. 설계
배경은 [`GGJira_Phase2_Implementation_Plan.md`](./GGJira_Phase2_Implementation_Plan.md)
(2차)와 [`PLAN.md`](./PLAN.md)(MVP)를, 실행 흐름은 [`docs/architecture.md`](./docs/architecture.md)를,
문제 해결은 [`docs/runbook.md`](./docs/runbook.md)를 참고한다.

## 설치

### 요구 사항

- Node 20 (`.nvmrc`에 고정)
- git
- 다음 중 하나 이상의 Worker CLI가 설치되어 로그인된 상태
  - [Claude Code CLI](https://claude.com/claude-code) (`claude --version`으로 확인)
  - [Codex CLI](https://github.com/openai/codex) (`codex --version`으로 확인) — 이 저장소에서는
    실제 CLI로 검증되지 않았으므로(`docs/architecture.md` 참고), 먼저 `worker:run`으로
    단독 확인을 권장한다
- Jira Cloud 사이트 접근 권한과, 사용할 각 Agent Identity(역할)마다 API 토큰

### 저장소 받기

```bash
git clone https://github.com/hokim84/ggjira.git
cd ggjira
nvm use        # Node 20 (.nvmrc)
npm install
```

### Jira 준비 (사이트 관리자)

여러 머신/역할로 운영하려면 Jira 쪽에 다음을 미리 준비해 둔다.

1. 역할별 Jira 계정(예: `ggjira-pm`, `ggjira-implement`) — 각 계정으로 로그인해
   API 토큰을 발급한다. 필요 권한: Browse, Transition Issues, Add Comments, Edit Issues
   (라벨), `pm` 역할이면 추가로 Create Issues, Assign Issues.
2. (pm 역할을 쓸 경우) 워크플로우에 `Needs Decision` 상태와 `<진행 중> → Needs Decision`,
   `Needs Decision → <준비 상태>` 전이를 추가한다.
3. (pm 역할을 쓸 경우) 프로젝트에 Sub-task 이슈 타입이 활성화되어 있는지 확인한다.

## 설정: `ggjira setup`

머신마다 `ggjira setup`을 실행해 대화형으로 `.env`와 `ggjira.config.json`을 만든다. 설정
파일을 직접 편집할 필요가 없다.

```bash
npm run dev -- setup
```

Jira URL → 이메일 → API 토큰(연결 자동 확인) → Agent Identity → Role(`pm`/`implement`) →
Machine 이름 → Workspace(대상 저장소) 경로 → Provider(`claude-code`/`codex`) → Workflow
상태/전이 이름 → (role이 `pm`이면) Needs Decision 전이명과 implement 계정 이메일 순으로
묻는다. 이미 설정이 있다면 다시 실행해 값을 바꿀 수 있다 — 기존 파일은 `.bak`으로 남는다.

설정을 바꾸지 않고 현재 상태(Jira 연결, 워크스페이스, Provider 실행 가능 여부)만 다시
확인하려면:

```bash
npm run dev -- setup --check
```

`.env`는 비밀(`JIRA_EMAIL`, `JIRA_API_TOKEN`)만 담고 0600 권한으로 생성된다.
`ggjira.config.json`은 나머지 설정을 담으며, 둘 다 `.gitignore`에 포함되어 커밋되지 않는다.

## 처음 실행할 때: 3단계 검증 순서

`setup`을 끝냈다면 순서대로 실행해서 각 단계를 확인한다. 한 번에 `run`부터 돌리지 않는다 —
아래 순서대로 하면 문제가 생겨도 어느 단계인지 바로 알 수 있다.

```bash
# 1. Jira 연동 확인 (인증 계정 → 이슈 조회 → 테스트 댓글 → transition 목록 출력)
npm run dev -- jira:smoke <ISSUE-KEY>

# 2. Worker(Claude Code CLI 또는 Codex CLI) 단독 실행 확인
npm run dev -- worker:run --prompt "README.md 맨 끝에 한 줄만 추가해줘"

# 3. Jira에서 이 Agent의 계정에 이슈를 assign(준비 상태로)한 뒤, 폴링 1회 실행
npm run dev -- once
```

`once`가 기대한 대로 동작하면(claim 전이 + 시작 댓글 + 실행 결과 댓글 + 완료 전이) 데몬으로
넘어간다. `pm` 역할이면 `once` 대신 특정 이슈만 시험해볼 수 있다.

```bash
npm run dev -- pm:plan <ISSUE-KEY> --dry-run   # Jira에 아무것도 쓰지 않고 Plan만 출력
npm run dev -- pm:plan <ISSUE-KEY>             # 실제로 하위 티켓 생성 또는 Needs Decision 전이
```

## 평소 실행

```bash
npm run dev -- run       # 폴링 데몬. config의 polling.intervalMs 주기로 계속 돈다.
                          # Ctrl+C(SIGINT) 또는 SIGTERM을 보내면 진행 중인 사이클을 마치고 종료한다.
```

빌드해서 실행할 수도 있다.

```bash
npm run build
node dist/cli.js run
```

daemon(`run`)은 시작할 때마다 `data/state.json`에 남은 claim을 먼저 점검한다. 이전 실행이
비정상 종료(kill, 크래시)로 이슈를 "진행 중"으로 남겨뒀다면, 다시 실행하지 않고 실패로 정리한 뒤
Jira에 알리고 넘어간다 — 자세한 동작은 [`docs/runbook.md`](./docs/runbook.md) §5 참고.

## Multi-Machine

같은 저장소를 여러 머신에 clone하고 각각 `ggjira setup`을 실행하면 된다. 머신 간 직접
통신은 없다 — 각 Agent는 Jira의 Assignee + Workflow State만 보고 독립적으로 작업을
발견한다. 예를 들어 머신 A는 `role: pm`, 머신 B/C는 `role: implement`(같은 Jira 계정도
가능)로 설정해 PM이 만든 하위 티켓을 여러 Implement Agent가 나눠 처리하게 할 수 있다.
동시에 같은 이슈를 발견했을 때의 동작은 [`docs/runbook.md`](./docs/runbook.md) §8 참고.

## 그 밖의 명령

```bash
npm run dev -- status                                          # 현재 claim과 최근 실행 목록
npm run dev -- worktrees:prune [--olderThanDays N]              # 오래된 워크트리 정리 (기본 7일, 브랜치는 안 지움)
npm run dev -- worker:run --prompt "<지시문>" [--timeout <ms>] [--schema <path>] [--read-only]
                                                                 # Worker만 단독 실행 (Jira 이슈 없이)
```

`worker:run`은 `ggjira.config.json`의 `workspace.path`에 새 git worktree를 만들고, 그 안에서
Worker를 실행한 뒤 변경 사항을 GGJIRA가 직접 커밋한다(`--read-only`면 커밋하지 않는다).
`once`/`run`이 이슈별로 만드는 워크트리도 동일한 방식이다.

## 무엇을 확인하면 되는가

- 이슈에 댓글이 달리고 상태가 바뀌었는지 — Jira에서 직접 확인한다.
- 실제로 무슨 작업을 했는지 — `data/runs/<ISSUE-KEY>/<runId>/summary.md`.
- 실패했을 때 — `npm run dev -- status`로 어떤 이슈가 실패했는지 먼저 보고,
  [`docs/runbook.md`](./docs/runbook.md)의 계층별 진단 순서를 따라간다.

## 구현 상태 / 알려진 제한사항

이 저장소는 MVP(T1~T8) + 2차 구현(Plan Mode, Assignee Dispatch, Multi-Machine, `ggjira
setup`)까지 코드와 자동 테스트(`npm run check`, 142개)가 완료된 상태다. 무엇이 실제
Jira/CLI로 검증됐고 무엇이 아직 아닌지는 [`docs/phase2-completion-report.md`](./docs/phase2-completion-report.md)에
정리되어 있다. 프로덕션에 쓰기 전 알아둘 것:

- **Codex CLI Provider는 실제 `codex` 바이너리로 검증되지 않았다** — 인자 형식과 결과
  파싱은 공개 문서 기준 추정([`docs/decisions/0010-provider-request-generalization-and-codex.md`](./docs/decisions/0010-provider-request-generalization-and-codex.md)).
  `provider.type: "codex"`를 쓰기 전 반드시 `worker:run --schema`로 단독 확인한다.
- **Claim은 완전한 원자적 락이 아니다** — Jira transition 실패를 항상 "경쟁 패배"로
  해석한다([`docs/decisions/0008-assignee-dispatch-and-transition-claim.md`](./docs/decisions/0008-assignee-dispatch-and-transition-claim.md)).
  같은 이슈에서 반복적으로 실패하면 `claimTransitionName` 설정 오류를 의심한다
  (`docs/runbook.md` §8).
- **Replan은 완전한 plan diff가 아니다** — 아직 시작하지 않은 하위 이슈만 superseded
  처리한다([`docs/decisions/0009-plan-mode-as-jira-workflow.md`](./docs/decisions/0009-plan-mode-as-jira-workflow.md)).
- **실제 다중 머신 시나리오(Scenario C)는 이 세션에서 실측하지 않았다** — 코드는 여러
  머신에서 독립 실행되도록 작성했지만, 실제 2대 이상의 머신으로 검증하는 것은 사용자가
  [`docs/runbook.md`](./docs/runbook.md)와 위 "Multi-Machine" 절을 따라 직접 확인해야 한다.

## 개발

```bash
npm run check   # typecheck + lint + format:check + test (CI와 동일)
```
