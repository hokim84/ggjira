# GGJIRA

Jira를 인간과 AI Agent가 공유하는 작업 인터페이스로 사용하는 경량 프로젝트 오케스트레이션
시스템이다. configVersion 4에서는 동일한 Agent Runtime이 Jira 상태와 Agent Profile의
capability를 기준으로 planning과 implementation을 모두 수행한다.

```
Ready for Planning — 계획을 만들고 Jira에 사람이 검토할 Objective, Acceptance Criteria,
                     Dependencies, Constraints, Required Capabilities를 기록한다.
AI Implementation  — Assignee와 필요한 capability/backend를 확인한 뒤 Claude Code
                     CLI 또는 Codex CLI로 구현하고 Review로 넘긴다.
```

Jira Assignee는 결과에 책임지는 인간이며 AI 실행 중에도 변경하지 않는다. 인간이 이슈를
`AI Implementation`으로 전환하는 것이 실행 승인이다. Agent의
정체성·역할·성향은 Jira의 **Agent Profile Issue**로 관리한다 — Human이 Jira에서 직접
정의하고 수정할 수 있고, 새 머신은 프로필을 선택해 join하기만 하면 된다(기존 Jira
Workflow는 건드리지 않는다). 설계 배경은
[`GGJira_Phase2_Implementation_Plan.md`](./GGJira_Phase2_Implementation_Plan.md)(2차)와
[`advanced_plan.md`](./advanced_plan.md)(3차: Agent Profile)를, 실행 흐름은
[`docs/architecture.md`](./docs/architecture.md)를, 문제 해결은
[`docs/runbook.md`](./docs/runbook.md)를 참고한다.

## 설치

### 요구 사항

- Node 20 (`.nvmrc`에 고정)
- git
- 다음 중 하나 이상의 Worker CLI가 설치되어 로그인된 상태
  - [Claude Code CLI](https://claude.com/claude-code) (`claude --version`으로 확인)
  - [Codex CLI](https://github.com/openai/codex) (`codex --version`으로 확인) — 이 저장소에서는
    실제 CLI로 검증되지 않았으므로(`docs/architecture.md` 참고), 먼저 `worker:run`으로
    단독 확인을 권장한다
- Jira Cloud 사이트 접근 권한과, 사용할 각 Agent Identity(역할)마다 API 토큰. 필요 권한:
  Browse, Transition Issues, Add Comments, Edit Issues(라벨), `pm` 역할이면 추가로
  Create Issues, Assign Issues.

### 저장소 받기

```bash
git clone https://github.com/hokim84/ggjira.git
cd ggjira
nvm use        # Node 20 (.nvmrc)
npm install
```

## 처음 설정: `ggjira`

인자 없이 실행하면 로컬 설정이 없을 때 자동으로 Setup 메뉴가 뜬다.

```bash
npm run dev -- setup
```

```
GGJIRA Setup
  1) Create GGJira Workspace   -- 이 프로젝트에서 처음 실행하는 PM 머신
  2) Join as Agent             -- 이미 만들어진 Agent Profile로 이 머신을 등록
  3) Manual setup (legacy)     -- Agent Profile 없이 모든 값을 직접 입력
```

### 첫 머신: Create GGJira Workspace

프로젝트에서 GGJIRA를 처음 쓰는 머신에서 `1`을 선택한다. Jira URL/이메일/API 토큰으로
연결을 확인한 뒤, 프로젝트를 고르고(`listProjects`로 후보를 보여준다), 그 프로젝트에
Workspace Configuration 이슈(`[GGJIRA] Workspace Configuration`)와 PM Agent Profile
이슈(`[AGENT] pm-01` 등)가 없으면 새로 만든다 — 이 단계에서만 워크플로우 상태/전이
이름을 묻는다(아래 표). 이후 로컬 저장소 경로/Provider/모델을 물은 뒤 `.env` +
`ggjira.config.json`을 쓰고, 이 머신을 방금 만든 PM 프로필에 등록(claim)한다.

| 질문 | 기본값 | 의미 |
|---|---|---|
| Ready-to-plan Jira status | `To Do` | 이 상태의 이슈에 planning 수행 |
| Planning transition name | `In Progress` | planning 시작 시 이 전이로 이동 |
| Review transition name | `In Review` | 구현 성공 시 Review로 이동 |
| Needs-decision transition name | `Needs Decision` | 결정이 필요할 때 이 전이로 이동 |

보드의 실제 상태/전이 이름이 다르면(한글 컬럼명 등) 실제 이름을 그대로 입력한다.
**입력할 이름은 보드의 "컬럼 표시 이름"이 아니라 이슈의 실제 status 이름이어야 한다** —
확실한 값은 `jira:smoke <KEY>` 출력의 `status:` 줄이다. 이 문제로 이슈가 하나도 안
잡힌다면(`No assigned issues ready to claim.`) [`docs/runbook.md`](./docs/runbook.md) §3을
참고한다. `pm` 역할을 쓸 계획이면 워크플로우에 `Needs Decision` 상태와 그리로/에서
나오는 전이를, 프로젝트에 Sub-task 이슈 타입을 미리 준비해 둔다.

설정이 끝나면 "Start the agent now? (Y/n)"에 Y로 답해 바로 데몬을 시작하거나, 나중에
`npm run dev -- run`으로 시작한다.

### 새 워커 머신: Join as Agent

다른 머신에서 같은 저장소를 clone하고 `ggjira`(또는 `setup`)를 실행해 `2`를 선택한다.
Jira 연결 확인 후, 그 프로젝트에 등록된(비활성이 아닌) Agent Profile 목록을 보여준다.

```
Available agents:
  1. unity-implement-01   implement  unity-programmer   unregistered
  2. reviewer-01          implement  general-programmer registered (machine 3fa1…)
```

번호나 agentId로 선택하면 이 머신이 그 프로필에 등록된다 — **워크플로우 상태/전이
이름은 Workspace Configuration 이슈에서 자동으로 복사되므로 다시 묻지 않는다.** 이미
다른 머신이 등록한 프로필을 선택하면 강제로 가져올지(takeover) 확인한다. 이후 로컬
저장소 경로/Provider/모델만 물으면 끝이다.

### Agent 추가하기

새 Agent Profile은 인간이 직접 CLI로 만든다. Planning 작업은 Profile을 자동 생성하거나
비활성화하지 않는다.

```bash
npm run dev -- agent:list                                          # 프로젝트의 Agent Profile 목록
npm run dev -- agent:create unity-implement-02 --role implement --preset unity-programmer
npm run dev -- agent:disable unity-implement-02                    # 라벨 ggjira-disabled 부여
```

프로필이 생기면 Human이 Jira에서 Display Name/Capabilities/Work Style/Human Instructions를
직접 수정할 수 있다 — GGJIRA는 생성 이후 description을 다시 쓰지 않는다. 새 머신에서
`ggjira` → `2` Join as Agent로 그 프로필을 골라 시작하면 된다.

### Manual setup (legacy)

Agent Profile 없이 모든 값을 직접 입력하고 싶으면(예: Jira 프로젝트에 이슈를 추가로
만들고 싶지 않은 경우) `3`을 선택한다. Jira URL → 이메일 → API 토큰 → Agent Identity →
Role(`pm`/`implement`) → Machine 이름 → Workspace 경로 → Provider → 모델 → Workflow
상태/전이 이름 → (`pm`이면) Needs Decision 전이명과 implement 계정 이메일 순으로 묻는다.

### 공통 사항

`ggjira setup`은 어느 모드로 실행하든 이미 설정이 있으면 다시 실행해 값을 바꿀 수 있다
— 각 질문은 기존 `ggjira.config.json`/`.env` 값을 기본값으로 보여주므로, 바꾸려는
항목만 새로 입력하고 나머지는 Enter로 넘기면 된다(API 토큰도 Enter만 누르면 기존 값을
유지하며 화면에 다시 노출되지 않는다). 기존 파일은 덮어쓰지 않고 `.bak`으로 남는다.

설정을 바꾸지 않고 현재 상태(Jira 연결, 워크스페이스, Provider 실행 가능 여부, profile
mode면 이 머신의 등록 상태)만 다시 확인하려면:

```bash
npm run dev -- setup --check
```

`.env`는 비밀(`JIRA_EMAIL`, `JIRA_API_TOKEN`)만 담고 0600 권한으로 생성된다.
`ggjira.config.json`은 나머지 설정을 담으며, 둘 다 `.gitignore`에 포함되어 커밋되지 않는다.
Jira에는 machine id나 로컬 저장소 경로 같은 민감/머신 종속 정보를 저장하지 않는다.

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

같은 저장소를 여러 머신에 clone하고 각 머신에서 `ggjira`를 실행해 Join as Agent로 서로
다른 Agent Profile을 선택하면 된다(레거시라면 각각 `ggjira setup`의 Manual 모드). 머신
간 직접 통신은 없다 — 각 Agent는 Jira의 Assignee + Workflow State만 보고 독립적으로
작업을 발견한다. 예를 들어 머신 A는 PM Agent Profile로 Create, 머신 B/C는 서로 다른
implement Agent Profile로 Join해 PM이 만든 하위 티켓을 여러 Implement Agent가 나눠
처리하게 할 수 있다. Profile mode에서는 Agent Profile 하나에 머신 하나만 등록되므로(다른
머신에서 다시 Join하려면 명시적으로 takeover해야 한다), 같은 Agent를 여러 머신에서 동시에
돌리려면 레거시(Manual) 모드처럼 같은 Jira 계정을 여러 머신에 그대로 설정한다. 동시에
같은 이슈를 발견했을 때의 동작은 [`docs/runbook.md`](./docs/runbook.md) §8 참고.

## 그 밖의 명령

```bash
npm run dev -- status                                          # 현재 claim과 최근 실행 목록
npm run dev -- worktrees:prune [--olderThanDays N]              # 오래된 워크트리 정리 (기본 7일, 브랜치는 안 지움)
npm run dev -- worker:run --prompt "<지시문>" [--timeout <ms>] [--schema <path>] [--read-only]
                                                                 # Worker만 단독 실행 (Jira 이슈 없이)
npm run dev -- agent:list                                      # Agent Profile 목록 (profile mode)
npm run dev -- agent:create <id> --role <pm|implement> [--preset <id>] [--display <name>]
npm run dev -- agent:disable <id>                               # ggjira-disabled 라벨 부여
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
setup`) + 3차 구현(Agent Profile, Workspace Configuration, Create/Join Setup, Prompt
Composition, PM Agent 라우팅)까지 코드와 자동 테스트(`npm run check`, 238개)가 완료된
상태다. 3차 구현이 실제 Jira/CLI로 무엇을 검증했고 무엇이 아직인지는
[`docs/phase3-verification.md`](./docs/phase3-verification.md)에, 2차 구현은
[`docs/phase2-completion-report.md`](./docs/phase2-completion-report.md)에 정리되어
있다. 프로덕션에 쓰기 전 알아둘 것:

- **Agent Profile 등록(claim)은 완전한 분산 락이 아니다** — property 쓰기 후 짧은 지연을
  두고 재조회해 동시 claim을 감지하는 MVP 수준 보호다
  ([`docs/decisions/0012-agent-profile-in-jira.md`](./docs/decisions/0012-agent-profile-in-jira.md)).
  진짜 동시 claim이 아니라면 [`docs/runbook.md`](./docs/runbook.md) §10을 참고한다.
- **Agent Profile / Workspace Configuration의 실 Jira 검증(issue property PUT 상태 코드,
  description round-trip)은 Atlassian 문서 기준으로 구현했고 이 세션에서 실측하지
  않았다** — `docs/phase3-verification.md`의 체크리스트로 직접 확인해야 한다.
- **Codex CLI Provider는 실제 `codex` 바이너리로 검증되지 않았다** — 인자 형식과 결과
  파싱은 공개 문서 기준 추정([`docs/decisions/0010-provider-request-generalization-and-codex.md`](./docs/decisions/0010-provider-request-generalization-and-codex.md)).
  `provider.type: "codex"`를 쓰기 전 반드시 `worker:run --schema`로 단독 확인한다.
- **Claim(작업 이슈)은 완전한 원자적 락이 아니다** — Jira transition 실패를 항상 "경쟁
  패배"로 해석한다([`docs/decisions/0008-assignee-dispatch-and-transition-claim.md`](./docs/decisions/0008-assignee-dispatch-and-transition-claim.md)).
  같은 이슈에서 반복적으로 실패하면 `claimTransitionName` 설정 오류를 의심한다
  (`docs/runbook.md` §8).
- **Replan은 완전한 plan diff가 아니다** — 아직 시작하지 않은 하위 이슈만 superseded
  처리한다([`docs/decisions/0009-plan-mode-as-jira-workflow.md`](./docs/decisions/0009-plan-mode-as-jira-workflow.md)).
- **실제 다중 머신 시나리오는 이 세션에서 실측하지 않았다** — 코드는 여러 머신에서 독립
  실행되도록 작성했지만, 실제 2대 이상의 머신으로 검증하는 것은 사용자가
  [`docs/runbook.md`](./docs/runbook.md)와 위 "Multi-Machine" 절을 따라 직접 확인해야 한다.

## 개발

```bash
npm run check   # typecheck + lint + format:check + test (CI와 동일)
```
