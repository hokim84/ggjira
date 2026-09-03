# 0009: Plan Mode를 Jira Workflow 단계로 구현

## Context

`GGJira_Phase2_Implementation_Plan.md` §5.5~§5.7은 Plan Mode를 "LLM 내부 옵션이 아니라
GGJIRA workflow의 공식 단계"로 요구한다: PM이 계획을 만들고, 결정이 필요하면 `Needs
Decision` 상태로 넘겨 인간의 입력을 기다린 뒤 Replan한다. 별도 Web UI 없이 Jira의 기존
Issue/Comment/Field/Workflow만 사용한다(§5.6).

## Decision

- **Plan 스키마** (`src/pm/plan.ts`): `{ needsDecision, summary, tasks[], keepTaskKeys[],
  decision? }`를 zod로 정의하고, 동일 구조의 JSON Schema(`PLAN_JSON_SCHEMA`)를
  `WorkerRequest.outputSchema`로 provider에 전달한다. `structuredOutput`이 없으면 원문
  텍스트에서 fenced ```json 블록을 fallback으로 추출한다.
- **결정 요청** (`src/pm/prompt.ts`): `needsDecision: true`인 Plan은 질문/선택지(장단점,
  추천안, 영향)를 마크다운으로 렌더링해 `[GGJIRA:DECISION-REQUEST]` 마커와 함께 댓글로
  남기고 `workflow.needsDecisionTransitionName`으로 전이한다. 응답 형식(`Decision: <id>`
  댓글 + 상태를 `readyStatus`로 되돌리기)을 댓글 본문에 직접 안내한다 — 별도 UI가 필요
  없다.
- **Human Decision 파싱** (`src/pm/context.ts`): `findHumanDecision`이 가장 최근
  DECISION-REQUEST 댓글 이후, 이 Agent 자신이 아닌 첫 댓글을 찾는다. `Decision: <id>`
  패턴이 있으면 구조화된 id로, 없으면 원문 그대로 replan 컨텍스트에 포함한다 — 형식을
  안 지켜도 입력이 유실되지 않는다.
- **Replan / Apply** (`src/pm/apply.ts`): 승인된 Plan은 하위 이슈를 생성·할당한다.
  `keepTaskKeys`에 없고 아직 `workflow.readyStatus`인(= 사람도 Implement Agent도 아직
  손대지 않은) 기존 하위 이슈만 `ggjira-superseded` 라벨을 붙이고 할당 해제한다. 진행
  중이거나 완료된 하위 이슈는 건드리지 않는다 — 완전한 plan diff 엔진은 만들지 않는다
  (§5.7).

## Consequences

- Plan Mode의 모든 상태(Plan 요약, 결정 요청, 사람의 결정, 최종 하위 티켓)가 Jira
  Issue/Comment에 그대로 남아 사람이 GGJIRA 내부 상태를 몰라도 이해할 수 있다(§6 원칙).
- PM은 `readyStatus`가 아닌 이슈를 폴링하지 않으므로, `Needs Decision`으로 넘어간 이슈는
  사람이 되돌리기 전까지 자동으로 재시도되지 않는다 — 이는 의도된 동작이다.
- provider가 스키마를 지키지 않으면(특히 Codex, ADR 0010) plan 파싱이 실패해 Job이
  `failed`로 끝난다. 재시도 로직은 없다 — 사람이 `worker.jsonl` 원문을 보고 프롬프트를
  조정하거나 재실행해야 한다.
