# GGJIRA — Claude Code 작업 규칙

GGJIRA는 Jira를 인간/AI Agent 공용 작업 인터페이스로 사용하는 경량 오케스트레이션 시스템이다.
Jira 이슈 → Poller → Job → Worker(Claude Code CLI) → 결과를 Jira에 기록하는 vertical slice가 MVP다.
전체 계획은 `PLAN.md`를 참고한다. 원문 요구사항은 `writing-block.md`에 있다.

## 디렉터리 = 계층 규칙

`src/` 하위 디렉터리는 실행 계층과 1:1로 대응한다. 새 코드는 해당 계층 디렉터리에 두고,
로그는 `layer` 필드로 그 디렉터리 이름을 사용한다.

- `src/jira/` — Jira REST 호출, 인증, 에러 매핑
- `src/poller/` — JQL 폴링, 후보 이슈 선정
- `src/job/` — Job 상태 머신, 디스크 기록(`data/runs/`, `data/state.json`)
- `src/worker/` — WorkerProvider 인터페이스, Claude Code CLI 실행, worktree, 프롬프트
- `src/reporter/` — 실행 결과를 Jira 댓글/전이/라벨로 기록

미래 확장(PM Agent, 다른 Provider, Web UI)을 위한 빈 디렉터리는 미리 만들지 않는다.

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
3. 아키텍처나 결정이 바뀌었다면 `docs/architecture.md` 또는 `docs/decisions/`를 같은 커밋/PR에서 갱신했다.
4. 외부 서비스(Jira, Claude Code CLI)에 대한 실제 호출은 자동 테스트에 넣지 않는다.
   자동 테스트는 Fake(`FakeProvider`, fetch mock)만 사용하고, 실제 연동 확인은
   `jira:smoke`, `worker:run` 같은 수동 CLI 명령으로 한다.

## 결정 기록

설계 결정을 바꾸거나 새로 내리면 `docs/decisions/NNNN-제목.md`에
Context / Decision / Consequences 3절로 남긴다. 기존 ADR을 삭제하지 않고,
필요하면 새 ADR로 이전 결정을 superseded 처리한다.

## 도구 사용 원칙

Memory, Skill, MCP, Subagent 등은 현재 구현 단계에서 실제 이득이 있을 때만 도입한다.
도구를 쓰는 것 자체를 목표로 삼지 않는다. Jira 접근은 `src/jira/client.ts`가 직접
REST를 호출하므로 별도 MCP 서버가 필요 없다.
