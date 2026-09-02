# 0003: WorkerProvider 인터페이스로 실행 방식을 분리

## Context

`writing-block.md` 원칙 6·7은 "Worker 실행 방식은 Provider 경계를 통해 교체 가능해야 하고,
초기에는 하나만 실제 구현해도 된다"고 명시한다. MVP는 구독형 Claude Code CLI를
`child_process.spawn`으로 실행한다. 향후 Codex CLI 등 다른 Worker를 추가할 가능성이 있다.

## Decision

`src/worker/provider.ts`에 최소 인터페이스 하나만 정의한다:
`run(request, { signal, onEvent }) → WorkerResult`. 구현체는 두 개만 둔다.

- `ClaudeCodeCliProvider` (`src/worker/claude-code-cli.ts`): 실제 Claude Code CLI subprocess 실행
- `FakeProvider` (`src/worker/fake.ts`): 테스트/e2e 전용, 실제 프로세스를 띄우지 않음

## Consequences

- 다른 CLI 기반 Worker를 추가할 때 이 인터페이스만 구현하면 되고, `job/runner.ts` 등
  상위 계층은 변경할 필요가 없다.
- 인터페이스는 지금 필요한 만큼만 정의한다. 병렬 실행, 세션 재개(`--resume`) 등은
  필요해지는 시점에 확장한다 (미리 설계하지 않음).
