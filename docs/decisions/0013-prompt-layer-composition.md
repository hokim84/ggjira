# 0013: System Prompt를 레이어로 합성한다

## Context

`advanced_plan.md` §5는 Agent Prompt를 완성된 문자열 하나로 저장하지 말고, 다음 레이어를
합성해 최종 System Prompt를 만들 것을 요구한다.

```
GGJira Core Policy → Project Policy → Role Preset → Agent Profile → Human Instructions
→ (Machine Capability, 이번 범위 밖)
```

기존 코드는 `pm/prompt.ts`의 `buildPmSystemPrompt()`와 `worker/prompt.ts`의
`buildImplementSystemPrompt()`가 인자 없이 고정 문자열을 반환했다. 이를 확장하되,
CLAUDE.md의 계층 규칙(`src/pm/`은 `src/implement/`를 모르고, 반대로 `src/implement/`도
`src/pm/`이나 profile 관련 모듈을 몰라야 한다는 원칙의 연장)과 레거시 config의 동작을
그대로 유지해야 한다는 제약이 있었다.

## Decision

- `src/agent/prompt.ts`의 `composeSystemPrompt(layers)`가 합성을 전담한다. 각 레이어는
  optional이며 비어 있으면 해당 섹션을 아예 렌더링하지 않는다 — `profile`/`preset`/
  `projectPolicy`가 모두 없으면 `corePolicy`를 그대로 반환한다(레거시와 byte 단위로
  동일, `test/agent-runtime.test.ts`로 회귀 검증).
- 합성 자체는 `src/agent/`(두 역할을 모두 아는 유일한 계층, ADR 0007)에 두고,
  `PmHandlerDeps`/`ImplementHandlerDeps`에 `buildSystemPrompt?: () => Promise<string>`을
  추가했다. `bootstrapAgent()`가 profile mode일 때만 이 함수를 주입하고, `pm/executor.ts`
  ·`implement/executor.ts`는 `deps.buildSystemPrompt?.() ?? build*SystemPrompt()`로
  기본값을 유지한다. 이렇게 하면 `src/implement/`는 `src/profile/`을 **import하지
  않고도** 합성된 프롬프트를 받을 수 있다 — 의존성은 `src/agent/runtime.ts`에만 생긴다.
- `src/pm/`은 예외적으로 `src/profile/`을 직접 import한다(로스터 조회·Agent 생성/비활성
  때문, ADR 없음 — CLAUDE.md의 금지 대상은 `src/implement/`뿐이다).
- Machine Capability 레이어는 이번 범위에서 만들지 않는다 — provider/model은 이미 CLI
  인자로 반영되어 있어 당장 프롬프트에 중복할 실익이 적다.
- Jira 조회 실패에 대비해 `bootstrapAgent`가 마지막으로 성공한 `AgentContext`를 캐시
  해 두고(`createContextLoader`), 재조회가 실패하면 경고 로그만 남기고 그 값을 계속
  쓴다 — 일시적 네트워크 문제로 폴링이 멈추면 안 되기 때문이다.

## Consequences

- Claude Code CLI는 `--append-system-prompt`로 자신의 기본 System Prompt 위에 이
  합성 결과를 얹지만, Codex CLI는 상당 플래그가 없어 합성 결과를 사용자 프롬프트
  앞에 붙인다(`worker/codex-cli.ts`, ADR 0010). 두 Provider가 "core policy"를 다루는
  위치가 다르므로, Project Policy에 "당신은 시스템 프롬프트의 전부다"를 전제하는
  지시를 넣으면 Provider마다 결과가 달라질 수 있다 — 문서(runbook)에 명시한다.
- 매 실행마다 Jira에서 Profile/Workspace를 다시 읽으므로(재조회), 사람이 Jira에서
  Human Instructions를 고치면 다음 실행부터 즉시 반영된다 — 재시작이 필요 없다.
- 프롬프트 합성 로직 자체에는 자동 테스트(`test/agent-prompt.test.ts`)가 있지만, 실제
  Claude Code/Codex가 합성된 프롬프트를 어떻게 해석하는지는 수동 검증 대상이다
  (`docs/phase3-verification.md`).
