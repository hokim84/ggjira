# ADR 0014: Capability Runtime과 Human Assignee

## Context

기존 Runtime은 `agent.role`을 PM 또는 implement로 고정하고 Agent의 Jira 계정을 Assignee로
사용해 작업을 라우팅했다. 이 모델은 Assignee를 결과 책임자인 인간으로 사용하고 Jira 상태
전환을 AI 위임 승인으로 삼으려는 정책과 충돌한다.

## Decision

configVersion 4부터 하나의 Runtime이 planning과 implementation 핸들러를 모두 등록한다.
`Ready for Planning`과 `AI Implementation` 상태를 작업 종류로 정규화하고, Jira Agent
Profile의 capabilities와 로컬 backend registry를 모두 만족할 때만 실행한다. Assignee는 인간
책임자로 유지한다. 동일 호스트 중복 실행은 파일시스템 execution lease로 막는다. v2/v3의
role·Agent-assignee 흐름은 설정 migration을 위한 호환 계층으로만 유지한다.

## Consequences

사람은 Jira 상태를 변경해 AI 실행을 명시적으로 승인하고, description의 계획·필요 capability를
직접 수정할 수 있다. Runtime 종류를 늘리지 않고 backend를 추가할 수 있다. 여러 호스트 사이의
분산 claim, Webhook 수신, 범용 DAG orchestration은 별도 결정이 필요하다.
