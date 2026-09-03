# GGJIRA — Claude Code 작업 규칙

GGJIRA는 Jira를 인간/AI Agent 공용 작업 인터페이스로 사용하는 경량 오케스트레이션 시스템이다.
동일 Agent Runtime이 설정(`agent.role`)만으로 `pm` 또는 `implement` 역할로 동작하며, Jira의
Assignee/Workflow State를 통해 작업을 발견·claim·실행·기록한다. PM은 Jira에 실행 가능한
하위 티켓을 만들고 Assignee를 지정할 뿐, Implement 프로세스를 직접 실행하지 않는다.
전체 계획은 `PLAN.md`(MVP)와 `GGJira_Phase2_Implementation_Plan.md`(2차: Plan Mode +
Assignee Dispatch + Multi-Machine)를 참고한다. 원문 요구사항은 `writing-block.md`에 있다.

## 디렉터리 = 계층 규칙

`src/` 하위 디렉터리는 실행 계층과 1:1로 대응한다. 새 코드는 해당 계층 디렉터리에 두고,
로그는 `layer` 필드로 그 디렉터리 이름을 사용한다.

- `src/jira/` — Jira REST 호출, 인증, 에러 매핑
- `src/agent/` — 공통 Agent Runtime: 인증(`getMyself`), 역할별 핸들러 선택, `claimJob`,
  표준 실행 결과 타입(`ExecutionResult`)
- `src/implement/` — implement 역할의 JobHandler: worktree → worker 실행 → 커밋 → 검증
- `src/pm/` — pm 역할의 JobHandler: Plan 생성, Human Decision 요청, Jira에 하위 티켓 적용
- `src/poller/` — 이 Agent에게 할당된(assignee) 준비 상태 이슈 조회(JQL)
- `src/job/` — Job 상태 머신, 디스크 기록(`data/runs/`, `data/state.json`), 역할-무관 실행 루프
- `src/worker/` — WorkerProvider 인터페이스, Claude Code CLI / Codex CLI 실행, worktree
- `src/reporter/` — `ExecutionResult` → Jira 댓글/전이/라벨(표준 포맷, CLAUDE.md §완료의 정의 아님,
  §4.4 참고)로 기록
- `src/setup/` — `ggjira setup` 대화형 위저드: Jira 연결/워크스페이스/Provider 검증, config 저장

**`src/pm/`은 `src/implement/`를 import하지 않는다.** PM은 Jira 쓰기(이슈 생성/할당/전이)만
하고, 실행은 별도 프로세스(다른 머신의 Implement Agent)가 Jira를 통해 발견해 수행한다
(`GGJira_Phase2_Implementation_Plan.md` §4.1). 두 모듈을 모두 아는 곳은 역할별 핸들러를
선택하는 `src/agent/runtime.ts` 하나뿐이다.

미래 확장(Web UI, Agent Registry, Scheduler)을 위한 빈 디렉터리는 미리 만들지 않는다.

## 명령

```
npm run typecheck   # tsc --noEmit
npm run lint        # biome lint
npm run format       # biome format --write
npm run format:check
npm run test         # vitest run
npm run check         # 위 전부 (CI와 동일)
npm run dev -- <command>   # tsx로 CLI 실행
npm run build         # dist/ 빌드
```

## 완료의 정의

작업을 완료로 보고하기 전에 다음을 모두 만족해야 한다.

1. `npm run check`가 통과한다.
2. 해당 milestone의 검증 명령(`PLAN.md` §8 "테스트" 항목)을 실제로 실행해 확인했다.
3. 아키텍처나 결정이 바뀌었다면 `docs/architecture.md`, `docs/decisions/`, 실패 진단 방법이
   바뀌었다면 `docs/runbook.md`를 같은 커밋/PR에서 갱신했다.
4. 외부 서비스(Jira, Claude Code CLI)에 대한 실제 호출은 자동 테스트에 넣지 않는다.
   자동 테스트는 Fake(`FakeJiraGateway`, `FakeWorkerProvider`, fetch mock)만 사용하고,
   실제 연동 확인은 `jira:smoke`, `worker:run` 같은 수동 CLI 명령으로 한다.

## 결정 기록

설계 결정을 바꾸거나 새로 내리면 `docs/decisions/NNNN-제목.md`에
Context / Decision / Consequences 3절로 남긴다. 기존 ADR을 삭제하지 않고,
필요하면 새 ADR로 이전 결정을 superseded 처리한다.

## 도구 사용 원칙

Memory, Skill, MCP, Subagent 등은 현재 구현 단계에서 실제 이득이 있을 때만 도입한다.
도구를 쓰는 것 자체를 목표로 삼지 않는다. Jira 접근은 `src/jira/client.ts`가 직접
REST를 호출하므로 별도 MCP 서버가 필요 없다.
