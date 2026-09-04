# 아키텍처

## 개요

GGJIRA는 하나의 Agent Runtime을 여러 머신에 설치해 서로 다른 역할(`pm`, `implement`)로
실행한다. 역할은 코드가 아니라 설정(`agent.role`)과 System Prompt로 결정된다. PM은
Implement 프로세스를 직접 실행하지 않는다 — Jira에 실행 가능한 티켓을 만들고 Assignee를
지정할 뿐이며, 각 머신의 Implement Agent가 자신에게 할당된 작업을 독립적으로 발견해
가져간다. 자세한 설계 배경은 `GGJira_Phase2_Implementation_Plan.md`를 참고한다.

```
Human
  → Jira Issue (Assignee: ggjira-pm)
  → [PM Agent] Plan 생성
       ├─ 결정 불필요 → 하위 Task 생성 + Assignee: ggjira-implement
       └─ 결정 필요   → Needs Decision → Human → Replan
  → [Implement Agent] 할당된 Task 발견 → claim → 실행 → 결과 기록
  → Jira (댓글/전이/라벨)
```

## Agent Runtime 부트스트랩

`src/agent/runtime.ts`의 `bootstrapAgent()`가 시작 시 한 번 실행된다.

```
authenticate (jira.getMyself())
  → loadRole(config.agent.role)         # "pm" | "implement"
  → createHandlerForRole()              # pm/executor.ts 또는 implement/executor.ts
  → CycleDeps { jira, store, handler }  # job/cycle.ts, job/runner.ts가 이후 이 handler만 사용
```

이 함수가 `pm/executor.ts`와 `implement/executor.ts`를 둘 다 아는 유일한 지점이다. 그
아래 두 모듈은 서로를 import하지 않는다(CLAUDE.md 참고) — PM이 Implement 실행 경로를 직접
호출할 수 없도록 코드 구조로 강제한다.

## 폴링 → claim → 실행 → 보고 (역할-무관 공통 루프)

`job/cycle.ts`(`runPollCycle`)와 `job/runner.ts`(`runJobForIssue`)는 pm/implement 모두에
동일하게 적용되는 실행 루프다.

```
findAssignedJobs (poller.ts)
  JQL: assignee = currentUser() AND status = "<workflow.readyStatus>"
  (config.jira.jql로 override 가능)
  → 로컬 data/state.json에 이미 claim된 이슈 제외
  ↓
claimJob (agent/claim.ts)
  1. 이슈 재조회 — 여전히 readyStatus인지 확인
  2. Jira transition(claimTransitionName) 시도
  3. 시작 댓글
  → 실패(재조회 결과 이미 다른 상태 / transition 거부)
    = ClaimLostError → Job "cancelled", Jira에는 아무것도 남기지 않음
    (다른 Agent나 사람이 먼저 처리한 것으로 간주 — 진짜 오류가 아니다)
  ↓
handler.run() — 역할별 JobHandler (agent/handler.ts)
  → ExecutionResult { status, summary, changes?, validation?, artifacts?,
                       failureReason?, blockingIssue?, decisionRequest? }
  ↓
reportForResult (reporter.ts) — 표준 포맷으로 Jira에 기록 (아래 "표준 결과 포맷" 참고)
```

## 표준 결과 포맷 (`ExecutionResult` → Jira 댓글)

모든 역할은 `agent/result.ts`의 `ExecutionResult`로 결과를 표현하고, `reporter.ts`가 이를
하나의 포맷으로 렌더링한다. 사람이나 PM Agent가 Jira만 보고 후속 판단을 할 수 있는 수준이면
충분하다.

성공:

```
Implementation completed.

Summary:
Formation avoidance implemented.

Changes:
- FormationController
- FormationMovement

Validation:
- Unit tests passed

Artifacts:
- branch: ggjira/GGJ-42-run-...

agent: ggjira-implement@HODORI-HOME
runId: run-...
```

실패:

```
Execution failed.

Summary:
Implementation could not be completed.

Failure Reason:
Unity project failed to compile.

Blocking Issue:
GGJ-138

agent: ggjira-implement@HODORI-HOME
runId: run-...
```

| `ExecutionResult.status` | Job 최종 상태 | Jira 후속 동작 |
|---|---|---|
| `succeeded` (implement) | `succeeded` | 댓글 + `workflow.doneTransitionName` 전이 |
| `planned` (pm, 결정 불필요) | `succeeded` | 댓글 + `workflow.plannedTransitionName` 전이 (없으면 라벨 `ggjira-planned`) |
| `needs_decision` (pm) | `succeeded` | `decisionRequest` 댓글 + `workflow.needsDecisionTransitionName` 전이 |
| `failed` | `failed` / `timed_out`(`timedOut:true`) | 댓글 + 라벨 `workflow.failureLabel` |

## 계층과 실패 추적

| 계층 | 책임 | 실패 신호 |
|---|---|---|
| jira | REST 호출, 인증, 에러 매핑 | `JiraApiError`(status, endpoint) |
| poller | assignee+status JQL 조회 → 후보 이슈 | 로그 `poll.error` |
| agent | 인증, claim, 역할 선택 | `ClaimLostError`(claim은 실패 아님) / `job.json.failureStage:"jira"` |
| job | 상태 머신, 재시작 복구, 디스크 기록 | `job.json.status` + `failureStage` |
| implement | worktree, worker 실행, 커밋, 검증 명령 | `ExecutionResult.failureReason`, `failureStage:"worker"` |
| pm | Plan 생성/파싱, Jira에 하위 티켓 적용 | `ExecutionResult.failureReason` (plan 파싱 실패 / apply 실패) |
| reporter | 결과 → Jira 댓글/전이/라벨 | `job.json.reportingFailed` (실행 자체는 성공해도 Jira 기록만 실패할 수 있음) |
| setup | Jira 연결/워크스페이스/Provider 검증 | `ggjira setup` 또는 `ggjira setup --check` 출력 |
| profile | Agent Profile / Workspace Configuration 이슈 파싱·검색·등록 | `InvalidProfileError`, `ProfileAlreadyRegisteredError`, `ProfileClaimLostError` |

각 계층은 `src/<layer>/` 디렉터리와 로그의 `layer` 필드로 1:1 대응한다 (`CLAUDE.md` 참고).

## Job 상태 머신

```
queued → claimed → running → succeeded
       ↘ cancelled              → failed
                                 → timed_out
```

`queued → cancelled`는 claim 경쟁에서 진 경우에만 쓰인다(진짜 실패가 아니다).

## Plan Mode (pm 역할)

`pm/executor.ts`가 이슈 + 댓글 + 기존 하위 이슈를 모아(`pm/context.ts`) provider에게
JSON Schema 출력(`pm/plan.ts`의 `PLAN_JSON_SCHEMA`)을 요청한다. `needsDecision`이 false면
`pm/apply.ts`가 하위 이슈를 생성·할당(`pm.implementAssignee`)하고, 선택적으로
`pm.taskReadyTransitionName`으로 전이한다. `needsDecision`이 true면 선택지/장단점/추천안을
`pm/prompt.ts`의 `buildDecisionRequestComment`로 렌더링해 `[GGJIRA:DECISION-REQUEST]` 마커와
함께 댓글로 남기고 `Needs Decision`으로 전이한다.

인간이 `Decision: <id>` 형식(또는 자유 텍스트)으로 댓글을 남기고 이슈를 다시
`workflow.readyStatus`로 되돌리면, 다음 사이클에서 PM이 재발견한다. `pm/context.ts`의
`findHumanDecision`이 가장 최근 DECISION-REQUEST 이후 사람(자기 자신이 아닌)의 첫 댓글을
찾아 replan 프롬프트에 포함시킨다. `pm/apply.ts`는 이전 계획 중 `keepTaskKeys`에 없고 아직
`readyStatus`인(= 아직 시작 안 한) 하위 이슈만 `ggjira-superseded` 라벨을 붙이고 할당
해제한다 — 진행 중이거나 완료된 작업은 건드리지 않는다.

## Provider 경계

`WorkerProvider` 인터페이스(`worker/provider.ts`) 하나에 두 실구현을 둔다.

- `ClaudeCodeCliProvider`(`worker/claude-code-cli.ts`) — `claude -p --output-format
  stream-json`, `--json-schema`로 구조화 출력, `--append-system-prompt`로 역할별 지시 전달
- `CodexCliProvider`(`worker/codex-cli.ts`) — `codex exec --json --output-last-message
  <file>`. Codex CLI에는 `--append-system-prompt`/`--json-schema` 상당 플래그가 없어
  system prompt와 스키마 요청을 프롬프트 텍스트에 직접 포함시킨다(미검증 — 아래 참고)

`worker/factory.ts`의 `createProvider(config)`가 `config.provider.type`으로 구현체를
선택한다. 공통 프로세스 제어(spawn, timeout → SIGTERM → grace → SIGKILL, 프로세스 그룹
kill, stdout 라인 버퍼링)는 `worker/spawn.ts`의 `runProcessWithTimeout`로 추출되어 있다.

`FakeWorkerProvider`(`worker/fake.ts`)는 테스트 전용, 실제 프로세스를 띄우지 않는다.

**Codex Provider는 실제 `codex` CLI로 검증되지 않았다** (개발 환경에 미설치). 인자 형식은
공개 문서 기준으로 작성했으며, 실제 CLI로 확인 후 필요하면 `worker/codex-cli.ts`와
`docs/decisions/0010-provider-request-generalization-and-codex.md`를 갱신해야 한다.

## Agent Profile & Workspace Configuration

3차 구현(`advanced_plan.md`)은 Agent의 정체성·설정을 Jira Issue로 옮긴다. 핵심 원칙은
"기존 Jira Workflow를 바꾸지 않는다" — 새 Status/Transition을 추가하지 않고, 라벨 /
issue property / description만으로 표현한다(`src/profile/`).

```
[GGJIRA] Workspace Configuration   라벨 ggjira-workspace   프로젝트당 1개
  description: Workflow 상태/전이 이름, Project Policy, Config Version
  → src/profile/workspace.ts (parseWorkspaceConfig / createWorkspaceConfig / findWorkspaceConfig)

[AGENT] <agentId>                  라벨 ggjira-agent        Agent당 1개
  description: Role, Preset, Display Name, Capabilities, Work Style, Human Instructions
  issue property "ggjira.registration": { machineId, jiraAccountId, registeredAt, claimToken, ggjiraVersion }
  → src/profile/profile.ts (parseAgentProfile / createAgentProfile / claimAgentProfile)
```

- **식별**: 라벨(`ggjira-agent`, `ggjira-workspace`) + summary 형식(`[AGENT] <id>`)으로
  검색한다. Status는 관여하지 않는다.
- **Enabled/Disabled**: 라벨 `ggjira-disabled` 유무. 사람이 Jira UI에서 라벨 하나로
  켜고 끌 수 있다.
- **등록(claim)**: `ggjira.registration` issue property에 이 머신의 `machineId`를 쓰고,
  짧은 지연 후 재조회해 다른 머신의 동시 claim을 감지한다(`claimAgentProfile`,
  `docs/decisions/0012-agent-profile-in-jira.md`). 사람이 읽는 description에는 절대
  쓰지 않는다 — description은 사람이 소유하고, GGJIRA는 생성 이후 다시 덮어쓰지 않는다.
- **메타 이슈 오폴링 방지**: `[AGENT]`/`[GGJIRA]` 이슈는 생성 직후 담당자를 해제하고,
  `poller.ts`가 이 두 라벨이 붙은 이슈를 폴링 후보에서 제외한다(`advanced_plan.md` §2.11).

## Prompt Composition

`src/agent/prompt.ts`의 `composeSystemPrompt()`가 역할 고유 System Prompt 위에 다음
레이어를 순서대로 쌓는다(레이어가 비어 있으면 그 섹션 자체를 생략한다).

```
corePolicy            buildPmSystemPrompt() / buildImplementSystemPrompt() (기존 그대로)
  ↓
Project Policy        Workspace Configuration의 Project Policy
  ↓
Role Preset            src/profile/presets.ts 정적 테이블(pm, general/unity/backend-programmer)
  ↓
Agent Profile          Capabilities, Work Style
  ↓
Human Instructions     Agent Profile의 Human Instructions
```

`agent/runtime.ts`의 `bootstrapAgent()`가 profile mode(`isProfileMode(config)`)일 때만
이 합성된 프롬프트를 `PmHandlerDeps.buildSystemPrompt`/`ImplementHandlerDeps.buildSystemPrompt`로
주입한다. 레거시 config는 이 필드가 없으므로 두 핸들러 모두 기존 `build*SystemPrompt()`
결과를 그대로 쓴다 — 프롬프트가 byte 단위로 이전과 동일함을 테스트로 보장한다
(`test/agent-runtime.test.ts`). `src/implement/`는 `src/profile/`을 import하지 않는다 —
합성은 `agent/runtime.ts`가 대신하고 결과 문자열만 넘긴다.

Jira 접근이 실패하면 `bootstrapAgent`가 로드해 둔 마지막 성공값을 그대로 쓰고 경고
로그만 남긴다(`createContextLoader`) — 일시적 네트워크 장애로 폴링이 멈추지 않는다.

## PM의 Agent 라우팅 (Plan Mode 확장)

Profile mode에서는 PM이 등록된 Agent 로스터(`findAgentProfiles`)를 planning 프롬프트에
포함하고, `Plan.agentProfiles`/`Plan.disableAgentIds`로 Agent 생성·비활성을 요청할 수
있다(`pm/apply.ts`). 하위 티켓의 담당자는 다음 순서로 정해진다.

```
1. task.assigneeAgentId가 지정되고, 그 Agent가 enabled+registered+role=implement면 그 계정
2. 로스터에서 조건을 만족하는 첫 Agent
3. (로스터가 비어있거나 대상이 없으면) 레거시 pm.implementAssignee 조회
```

레거시 조회는 실제로 필요할 때만, 그리고 plan당 최대 한 번만 호출한다(`resolveTaskAssigneeAccountId`).

## Setup

`ggjira setup`(`src/setup/wizard.ts`)이 메뉴를 보여준다.

```
1) Create GGJira Workspace   -- 이 프로젝트의 첫 PM 머신
2) Join as Agent             -- 이미 있는 Agent Profile에 이 머신을 등록
3) Manual setup (legacy)     -- Agent Profile 없이 모든 값을 직접 입력(2차까지의 기존 흐름)
```

Create/Join 흐름의 세부 단계는 `src/setup/flows.ts`에 있다. 공통적으로 Jira URL/이메일/
토큰 → 연결 확인(`getMyself`) → Project 선택(`listProjects`/`getProject`) 순으로 진행하고,
Workflow 상태/전이 이름은 Workspace Configuration 이슈에서 읽어오므로(Join의 경우) 다시
묻지 않는다. Machine ID는 `crypto.randomUUID()`로 최초 1회 생성해 로컬 config에 저장하고
재실행 시 그대로 재사용한다(`agent.machineId`) — hostname은 더 이상 식별자로 쓰지 않는다.
Manual 모드는 기존 2차 구현의 선형 흐름(Agent Identity/Role/Machine → Workspace → Provider
→ Workflow 5문항)을 그대로 유지한다. 세 모드 모두 `.env`(0600, `JIRA_EMAIL`/`JIRA_API_TOKEN`)와
`ggjira.config.json`을 만들고 기존 파일은 `.bak`으로 보존한다. `ggjira setup --check`는
같은 검증들과, profile mode면 이 머신의 등록 상태를 프롬프트 없이 확인한다.

## First Run

config 없이 인자 없이 실행한 `ggjira`는 Setup 메뉴로 들어간다(`src/setup/first-run.ts`의
`hasLocalConfig`). config가 있으면 곧바로 데몬을 시작한다(`ggjira run`과 동일). Create/Join
직후에는 "Start the agent now?"에 Y로 답하면 별도 명령 없이 바로 데몬이 이어서 시작된다.

## Agent 관리 CLI

`ggjira agent:list` / `agent:create <id> --role <pm|implement> [--preset <id>]` /
`agent:disable <id>`가 `src/profile/commands.ts`의 순수 함수(`listAgentsCommand` 등)를
감싼다 — profile mode(`jira.projectKey` 설정)가 아니면 명확한 에러로 안내한다.

## Multi-Machine

머신 간 직접 통신은 없다. 각 머신은 독립적으로 `ggjira setup` → `ggjira run`을 실행하며,
Jira의 Assignee + Workflow State만으로 작업을 발견한다. Profile mode에서는 Agent Profile당
등록 가능한 머신이 하나뿐이다(`claimAgentProfile`) — 같은 Agent를 여러 머신에서 동시에
실행하려면 명시적으로 takeover해야 한다. 레거시 모드는 기존처럼 동일 Jira 계정을 여러
머신에서 실행할 수 있으며, 중복 실행 방지는 claim(Jira transition)만으로 처리한다 —
완전한 분산 락은 범위 밖이다(`GGJira_Phase2_Implementation_Plan.md` §5.4, §7).

## Persistence

파일 기반. `data/runs/<ISSUE-KEY>/<runId>/{job.json, worker.jsonl, summary.md}`와
`data/state.json`(claim 기록). 배경은
[`decisions/0004-file-based-persistence.md`](./decisions/0004-file-based-persistence.md).

## Webhook이 아닌 Polling을 쓰는 이유

원래 합의된 기본 구조는 `Jira → Webhook → GGJIRA`였다. 개발 머신이 외부에서 접근 불가능해
MVP는 `Jira → JQL Polling → GGJIRA`로 시작했고, 2차에서도 이 결정을 유지한다(멀티 머신
환경에서 각 머신이 인바운드 웹훅을 받을 필요가 없다는 장점도 있다). 자세한 배경은
[`decisions/0001-polling-over-webhook.md`](./decisions/0001-polling-over-webhook.md) 참고.
