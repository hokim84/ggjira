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

## Setup

`ggjira setup`(`src/setup/wizard.ts`)이 Jira URL/이메일/토큰 → 연결 확인(`getMyself`) →
Agent Identity/Role/Machine → Workspace(존재 + git repo 확인) → Provider(`--version` 확인)
→ Workflow 상태/전이 이름 → (`role: pm`이면) Needs Decision 전이명 + Implement Assignee
순서로 질문해 `.env`(0600, `JIRA_EMAIL`/`JIRA_API_TOKEN`)와 `ggjira.config.json`을 만든다.
기존 파일은 `.bak`으로 보존한다. `ggjira setup --check`는 같은 검증들을 프롬프트 없이
현재 설정에 대해 실행한다.

## Multi-Machine

머신 간 직접 통신은 없다. 각 머신은 독립적으로 `ggjira setup` → `ggjira run`을 실행하며,
Jira의 Assignee + Workflow State만으로 작업을 발견한다. 동일 Agent Identity(Jira 계정)를
여러 머신에서 실행할 수 있으며, 중복 실행 방지는 claim(Jira transition)만으로 처리한다 —
완전한 분산 락은 2차 범위 밖이다(`GGJira_Phase2_Implementation_Plan.md` §5.4, §7).

## Persistence

파일 기반. `data/runs/<ISSUE-KEY>/<runId>/{job.json, worker.jsonl, summary.md}`와
`data/state.json`(claim 기록). 배경은
[`decisions/0004-file-based-persistence.md`](./decisions/0004-file-based-persistence.md).

## Webhook이 아닌 Polling을 쓰는 이유

원래 합의된 기본 구조는 `Jira → Webhook → GGJIRA`였다. 개발 머신이 외부에서 접근 불가능해
MVP는 `Jira → JQL Polling → GGJIRA`로 시작했고, 2차에서도 이 결정을 유지한다(멀티 머신
환경에서 각 머신이 인바운드 웹훅을 받을 필요가 없다는 장점도 있다). 자세한 배경은
[`decisions/0001-polling-over-webhook.md`](./decisions/0001-polling-over-webhook.md) 참고.
