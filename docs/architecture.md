# 아키텍처

## Router 중심 아키텍처로 전환 중 (진행 중, ADR 0018)

`src/contracts/`, `src/router/`, `src/worker-runtime/`에서 Router가 Jira 접근과 배정
판단을 독점하고 워커는 Router에만 연결하는 구조로 전환 중이다. 배경·계약·단계별 계획은
`docs/router-service-implementation-plan.md`(구현 상태 포함)와
[`decisions/0018-router-centric-architecture.md`](./decisions/0018-router-centric-architecture.md)를
본다. 이 절 아래의 내용(v2~v4)은 이 전환이 완료되기 전까지 유효한 현재 실행 경로다.

현재 4단계까지 구현되었다. Router(`src/router/`)는 웹훅·후보 조회·승인 식별·규칙 기반 배정과
`/api/v1/*` Worker API(pairing, 세션, `jobs/next` long polling, start, heartbeat, authorize,
result)를 SQLite 위에서 제공한다. Worker(`src/worker-runtime/`)는 Router에만 연결해 envelope를
받고 기존 `src/worker/` provider·worktree로 실행하며, 결과를 로컬 spool에 저장한 뒤 제출한다.
Worker Runtime은 `src/jira/`를 import하지 않는다(`test/worker-runtime-no-jira.test.ts`).
프로토콜 세부 판단은 [`decisions/0020-router-stage3-worker-protocol.md`](./decisions/0020-router-stage3-worker-protocol.md).
Planning job도 워커가 실행하되 계획을 구조화 결과로만 반환하고, Jira 반영은 Router가 한다
([`decisions/0021-router-stage4-reporting-recovery.md`](./decisions/0021-router-stage4-reporting-recovery.md)).

```
Worker                                   Router (SQLite)
  workers/session ───────────────────▶   현재 세션 교체, 미확정 attempt 반환
  workers/heartbeat (5s) ────────────▶   가용성 기록, 취소 지시
  jobs/next (≤25s) ──────────────────▶   queued job 임대(30s) → envelope
  jobs/{id}/start ───────────────────▶   승인 재확인 → running
  jobs/{id}/heartbeat (5s) ──────────▶   임대 갱신, 승인 변경 시 cancel
  jobs/{id}/authorize (커밋·검증 직전) ▶   실행 권한 재확인
  spool → jobs/{id}/result ──────────▶   결과 저장, 현재 attempt일 때만 상태 반영
```

Router의 Jira 쓰기는 모두 SQLite 저널(`report_steps`)을 거친다. 실행 허가·결과 저장과 같은
트랜잭션에서 단계를 기록하고, 트랜잭션 밖의 `processReportJournal`이 Jira를 다시 읽은 뒤
쓴다. 그래서 재시도해도 같은 쓰기가 두 번 일어나지 않고, 워커를 다시 실행하지도 않는다.

```
start 허가 ──▶ [start:<attempt>]   승인 상태 → inProgressStatus
result 저장 ─▶ [<resultId>]         성공: 댓글 → 실패 라벨 제거 → reviewStatus
                                    실패: 댓글 + ggjira-failed (inProgressStatus 유지)
                                    결정 요청: 댓글 → needsDecisionStatus ?? reviewStatus
                                    계획: 부모 계획 블록 → 하위 이슈 생성(마커) → plan-task
                                          → ggjira.plan → superseded → 댓글 → reviewStatus
중단 확인 ───▶ [recovered:<attempt>] "적용된 것 없음" 댓글
```

실행 진입점 CLI(`router serve`, `worker run`)와 주기 타이머, 관리자 HTTP API는 아직 없다(5단계).

## Capability 기반 Runtime (configVersion 4)

v4에서는 한 Runtime이 planning과 implementation 핸들러를 모두 보유하고 Jira 상태에 따라
작업을 dispatch한다. `agent.role`은 v2/v3 설정 호환용이며 v4 실행 선택에는 사용하지 않는다.
Agent 간 차이는 Jira Agent Profile의 `Capabilities`와 로컬 설정의 `agent.backends`로 표현한다.

```
Jira polling
  → Ready for Planning → planning capability → Plan Review
  → AI Implementation  → assignee 확인 → required capabilities/backend 확인
                       → implementation → Review
```

`AI Implementation` 상태는 인간의 실행 승인이다. 구현을 claim하기 위해 다른 상태로 전환하지
않으며 Assignee도 변경하지 않는다. 새 Sub-task는 상위 이슈의 Assignee를 상속한다.
Planning 결과는 상위 및 하위 이슈 description의 `GGJIRA Plan`, `Acceptance Criteria`,
`Dependencies`, `Constraints`, `Required Capabilities` 섹션에 기록되어 사람이 수정할 수 있다.
구현 직전에는 이 섹션을 다시 읽어 최신 Required Capabilities를 사용한다.

동일 호스트의 여러 Runtime은 `data/leases/<issue>/owner.json` 디렉터리를 원자적으로 생성해
중복 실행을 막는다. 처리한 상태·담당자·description 조합은 `data/handled/`에 기록하므로 동일한
실패를 매 polling마다 반복하지 않으며, 사람이 계획이나 책임자를 수정하면 다시 평가한다.
실행 중에는 Jira 승인 상태를 확인하고 상태가 바뀌거나 담당자가 제거되면 provider에 취소
신호를 보내고 후속 커밋·검증·Review 전환을 막는다.

`BackendRegistry`는 현재 filesystem, git, coding-runtime 가용성을 검사한다. unity와 comfyui는
capability-to-backend 경계만 정의되어 있으며 adapter가 등록되지 않으면 해당 작업을 거부한다.
실제 Webhook 수신과 분산 scheduler는 이번 버전에 포함하지 않는다.

아래 내용은 v2/v3 호환 실행 흐름을 설명한다.

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
`workflow.readyStatus`(v4는 `workflow.planningStatus`)로 되돌리면, 다음 사이클에서 PM이
재발견한다. `pm/context.ts`의 `findHumanDecision`이 가장 최근 DECISION-REQUEST 이후
사람(자기 자신이 아닌, 또는 자신과 같은 계정을 쓰는 human owner)의 첫 댓글을 찾아 replan
프롬프트에 포함시킨다. 요청 댓글에 `decisionId:` 줄이 있어도 사람이 그대로 옮겨 적을
필요는 없다 — 응답에 `decisionId`가 아예 없으면(실제 사람 답장의 기본형) 최신 요청에 대한
답으로 받아들이고, 응답에 **다른** `decisionId`가 명시된 경우만 오래된 요청에 대한 응답으로
보고 무시한다.

`pm/apply.ts`는 이전 계획 중 `keepTaskKeys`에 없고 아직 시작 안 한 하위 이슈만
`ggjira-superseded` 라벨을 붙이고 할당 해제한다 — 진행 중이거나 완료된 작업은 건드리지
않는다. "아직 시작 안 했다"의 판정은 config 모드에 따라 다르다: legacy(v2)는
`workflow.readyStatus`와 정확히 일치하는지로 보고, v4는 반대로 `inProgressStatus` /
`reviewStatus` / `completionStatus`(계획·구현 lane 공유, ADR 0017) 중 어디에도 해당하지
않으면 아직 시작 안 한 것으로 본다 — v4에서 새 하위 이슈가 실제로 멈춰 있는 상태
(`implementationStatus`, 또는 `pm.taskReadyTransitionName`이 이끄는 임의의 상태, 또는
배포 모드라면 아무 전이도 없이 Jira 기본 생성 상태 그대로)가 설정마다 다르기 때문에,
하나의 고정된 "ready" 상태와 비교하는 방식은 쓸 수 없다.

## Human-approved PM 배포 (Distribution)

`config.distribution.enabled`가 true면 PM이 만든 하위 이슈를 Implement Agent가 곧바로
집어가지 않고, 사람이 계획을 검토하고 실행 Agent를 지정한 뒤에만 실행되도록 한 단계를
더 강제한다(`GGJira_Phase2_Implementation_Plan.md`, `docs/decisions/0016-*.md`,
`docs/decisions/0017-*.md`). 계획(parent)과 구현(subtask) lane은 in-progress/review
상태를 공유한다(ADR 0017) — 그 상태에 있는 동안 어떤 코드도 "계획 중인지 구현 중인지"를
다시 확인하지 않기 때문이다. 관여하는 Jira 상태:

```
planningStatus → (PM claim) → inProgressStatus → (계획 완료) → reviewStatus
                                                                     ↓ (사람 검토, 하위 이슈 생성)
implementationStatus (하위 이슈, 사람이 직접 이동) → inProgressStatus(공유) → reviewStatus(공유)
```

부모 단위의 별도 "실행 승인" 상태는 없다 — 하위 이슈 각각을 `implementationStatus`로
옮기는 행위 자체가 그 이슈의 승인이다(§Plan Mode에서 이미 다루는 것과 동일한 원칙).

**메타데이터 (issue property, Jira Workflow는 건드리지 않음)**:

- 부모 이슈의 `ggjira.plan` — `{ version, taskIds, decisionId? }`. `version`은
  `applyPlan`을 호출할 때마다 새로 발급되는 문자열(보통 `job.runId`)이고, 재계획 때마다
  갱신된다.
- 각 하위 이슈의 `ggjira.plan-task` — `{ planVersion, taskId, parentKey, workspaceId,
  dependencies }`. `dependencies`는 계획 내부 참조(taskId)가 실제 생성된 Jira 키로 치환된
  배열이다.

`poller.ts`와 `agent/runtime.ts`의 dispatch 핸들러 양쪽에서, 하위 이슈를 실행하기 전에
다음을 확인한다: (1) 이슈의 실행-Agent 필드 선택값이 이 머신의
`distribution.executionAgentOptionId`와 일치, (2) `ggjira.plan-task.workspaceId`가 이
workspace와 일치, (3) (`agent/runtime.ts`에서만, claim 이후) 부모의 `ggjira.plan.version`
== 하위 이슈의 `planVersion` — 부모 이슈 자체는 조회하지 않고 issue property만 읽는다.
재계획으로 `keepTaskKeys`에 남은 하위 이슈는 `applyPlan`이 그 자리에서 `planVersion`을
새 값으로 재기록한다 — 하지 않으면 부모만 새 버전으로 넘어가고 유지된 하위 이슈는 (3)에서
영원히 실패한다.

`ggjira.plan-task` property가 **존재하지만 스키마와 맞지 않으면**(수동 편집 등으로 깨진
경우) `readPlanTaskMetadata`는 `PlanMetadataError`를 던진다 — property가 아예 없는 경우
(수동으로 만든, 배포 대상이 아닌 이슈)와 구분해야, 깨진 데이터를 "게이팅 없음"으로 착각해
승인 없이 실행하는 사고를 막을 수 있다. `poller.ts`는 이 에러를 해당 이슈 하나만 후보에서
제외하고 다음 사이클에 재시도하며, 다른 이슈의 폴링은 막지 않는다.

**Setup 전파**: `ggjira setup`의 5번(`PM approval & distribution`)이 입력받은 4개 상태
(`implementationStatus`/`inProgressStatus`/`reviewStatus`/`planningStatus`) +
`executionAgentFieldId` + `workspaceId`는 `[GGJIRA] Workspace Configuration` 이슈에도
함께 기록된다(`profile/workspace.ts`의 "Distribution" 섹션) — 여러 머신이 각자 상태
이름을 다르게 입력해 어긋나는 사고(ADR 0015가 기본 3개 상태에 대해 고친 것과 같은 종류)를
막기 위해서다. `executionAgentOptionId`만은 예외로, 이 필드는 "이 머신이 실행-Agent
필드에서 어떤 옵션인지"를 가리키므로 절대 공유 이슈에 쓰지 않고 머신마다 로컬 config에만
둔다(README §Human-approved PM distribution) — Join 흐름은 workspace 쪽 Distribution이
활성화돼 있으면 role이 implement인 새 머신에게만 이 값을 물어본다.

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

Workflow 설정은 **상태 3개가 전부다**(ADR
[0015](./decisions/0015-status-based-workflow.md)). Create GGJira Workspace는
`listProjectStatuses`로 받은 실제 상태 목록을 번호와 함께 출력하고, 그 중에서만 고르게 한다
(`listStatuses`/`askStatus`/`askWorkflowStatuses` in `flows.ts`).

```text
사람: 이슈를 workflow.implementationStatus(예: "AI 작업 요청")로 이동
  -> agent가 claim하며 workflow.inProgressStatus(예: "진행 중")로 이동
  -> 구현 완료 후 workflow.reviewStatus(예: "검토 중")로 이동
  -> 사람이 검토 후 완료 처리          (GGJIRA는 완료 상태로 전이하지 않는다)
```

전이(transition) 이름은 설정에 저장하지 않는다. 이동이 필요할 때
`transitionIssueToStatus(key, targetStatus)`(`src/jira/client.ts`)가 그 이슈에서 가능한
전이 중 도착 상태가 목표와 같은 것을 찾아 실행하고, 도달할 수 없으면 현재 상태와 도달 가능한
상태를 담은 `StatusNotReachableError`를 던진다. 덕분에 프로젝트의 전이 라벨이 어떤 언어든
설정과 어긋날 수 없다. 이미 workspace가 있으면 setup은 현재 3개를 보여주고 "Change these
statuses? (y/N)"만 물어, 동의할 때 `updateWorkspaceConfig`로 Jira 이슈 description을 갱신한다.
Join 흐름은 workflow를 아예 묻지 않는다. PM(계획) 관련 `planningStatus`/`needsDecisionStatus`는
선택값이라 setup이 묻지 않으며, 없으면 planning 라우팅과 JQL에서 함께 빠진다.
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
