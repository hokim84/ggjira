# 0007: 단일 Agent Runtime + 역할(Role) 설정

## Context

2차 구현(`GGJira_Phase2_Implementation_Plan.md`)은 PM Agent와 Implement Agent를 추가해야
한다. §3.1은 "PM Agent, Implement Agent 등을 서로 다른 프로그램으로 만들지 않는다 — 동일
Runtime + Role Configuration + System Prompt = Agent Role"을 원칙으로 명시한다. 또한 §4.1은
"PM Agent가 Worker/Implement Agent를 직접 실행하지 않는다"를 요구한다.

## Decision

- `src/agent/runtime.ts`의 `bootstrapAgent()`가 `config.agent.role`(`"pm" | "implement"`)에
  따라 역할별 `JobHandler`(`src/agent/handler.ts`)를 선택한다. 이 함수가 `src/pm/executor.ts`와
  `src/implement/executor.ts`를 둘 다 import하는 유일한 지점이다.
- `src/job/runner.ts`(`runJobForIssue`)와 `src/job/cycle.ts`(`runPollCycle`,
  `recoverStaleClaims`)는 역할을 모른다 — claim → `handler.run()` → 표준 결과 보고라는
  공통 생명주기만 안다.
- `src/pm/`은 `src/implement/`를 import하지 않는다(코드 리뷰로 강제; CLAUDE.md에 명시).
  PM 핸들러는 Jira 쓰기(이슈 생성/할당/전이)만 하고, 실제 구현 실행은 별도 프로세스(다른
  머신의 Implement Agent)가 Jira를 통해 발견해 수행한다.
- 두 역할이 공유하는 결과 타입은 `src/agent/result.ts`의 `ExecutionResult`
  하나다(ADR 0008 관련).

## Consequences

- 새 역할을 추가하려면(3차 이후 candidate: review, test) `JobHandler` 구현체 하나와
  `runtime.ts`의 분기 한 줄만 있으면 된다. `job/runner.ts`, `poller.ts`, `reporter.ts`는
  변경할 필요가 없다.
- PM이 Implement 실행 경로를 직접 호출하는 회귀는 `src/pm/`이 `src/implement/`를 import하는
  순간 코드 리뷰에서 바로 드러난다 — 별도 lint 규칙 없이도 눈에 띄는 구조.
- 대가: `bootstrapAgent()`는 두 역할의 의존성(WorkerProvider, JobStore, worktreesRoot 등)을
  전부 알아야 한다. 역할이 늘어나면 이 함수가 다소 커질 수 있지만, 2차 범위(2개 역할)에서는
  문제가 되지 않는다.
