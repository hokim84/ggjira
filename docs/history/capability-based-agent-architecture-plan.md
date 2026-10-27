# GGJIRA Capability-based Agent Architecture 구현 계획

## 0. 작업 지시

현재 GGJIRA 프로젝트의 코드를 먼저 분석한 뒤, 아래 요구사항을 기준으로 **기존 구현을 최대한 재사용하면서 아키텍처를 수정**한다.

바로 코드를 수정하기 전에 반드시 Plan Mode에서 다음을 먼저 수행한다.

1. 현재 프로젝트 구조와 주요 실행 흐름을 분석한다.
2. 기존 구현 중 유지 가능한 부분과 변경이 필요한 부분을 구분한다.
3. 아래 목표 구조와 현재 구조의 차이를 정리한다.
4. 실제 변경 대상 파일/모듈을 식별한다.
5. 단계별 migration plan을 작성한다.
6. 기존 기능이 깨질 위험이 있는 부분을 명시한다.
7. 계획이 확정된 뒤 구현한다.

불필요한 전면 재작성은 피한다.

---

# 1. 프로젝트 핵심 철학

GGJIRA는 인간이 여러 AI Agent에게 작업을 위임하기 위한 Jira 기반 프로젝트 관리 시스템이다.

Jira는 단순한 상태판이 아니라 Human과 AI가 공유하는 **공식 작업 인터페이스이자 상태 저장소**다.

핵심 원칙은 다음과 같다.

- Jira Issue의 `Assignee`는 작업 결과에 책임지는 **인간**이다.
- AI Agent는 Jira Assignee가 아니다.
- 인간이 Jira Issue의 상태를 `AI Implementation`으로 변경하는 행위를 AI 실행에 대한 명시적 승인으로 본다.
- AI가 구현한 결과 역시 최종적으로 인간이 검토하고 완료한다.
- AI 내부 실행 구조를 사람이 기억하거나 관리할 필요가 없어야 한다.
- Jira에는 사람이 알아야 할 수준의 정보만 기록한다.
- 세부 실행 단계는 Agent 내부 plan으로 처리한다.
- 별도의 복잡한 Agent 관리 UI를 만들지 않고 Jira 자체를 최대한 활용한다.
- MVP를 우선하며 불필요한 범용 프레임워크 구현을 피한다.

책임 모델은 다음과 같다.

```text
Jira Assignee
= 결과에 책임지는 Human

Jira Status
= 현재 작업 단계 및 AI 위임 여부

Agent
= AI 작업을 수행하는 실행 주체

Sub-agent
= Agent 내부의 역할별 추론/작업 단위

Capability
= Agent가 수행할 수 있는 능력

Backend
= 실제 외부 작업을 수행할 수 있는 환경 또는 도구
```

---

# 2. 기존 설계에서 변경되는 부분

기존에는 개념적으로 다음과 같은 구조를 사용했다.

```text
PM Agent
    ↓
Worker Agent
    ↓
Implementation
```

Programming Worker, UI Worker, Graphics Worker 등 Worker 타입을 별도로 두는 방향이었다.

이 구조를 제거하거나 최소화한다.

새로운 구조는 다음과 같다.

```text
GGJIRA Agent
    │
    ├ Planning Sub-agent
    ├ Task Decomposition Sub-agent
    ├ Programming Sub-agent
    ├ UI Sub-agent
    ├ Art Sub-agent
    ├ Testing Sub-agent
    └ Review Sub-agent
          │
          ▼
      Backend / Tools
```

PM과 Worker를 서로 다른 종류의 Agent로 취급하지 않는다.

Planning, decomposition, implementation, testing, review 등은 모두 **Agent가 수행할 수 있는 역할 또는 capability**다.

---

# 3. 목표 아키텍처

최종적인 개념 구조는 다음과 같다.

```text
Human
  │
  ▼
Jira Issue
  │
  │ Webhook
  ▼
GGJIRA Runtime
  │
  ▼
Agent Dispatcher
  │
  ▼
Agent Instance
  │
  ├ Capability Profile
  │
  ├ Sub-agent Orchestration
  │
  └ Backend Registry
          │
          ├ Local Development Environment
          ├ Git
          ├ Unity
          ├ ComfyUI
          ├ Blender
          ├ CI
          └ future backends
```

Agent 간 차이는 `PM`, `Worker`, `Art Agent` 같은 클래스 타입이 아니라 **Capability Profile**로 표현한다.

예:

```yaml
agent:
  id: dev-machine

  capabilities:
    - planning
    - task-decomposition
    - programming
    - ui
    - testing
    - review

  backends:
    - filesystem
    - git
    - unity
```

Art 작업을 수행할 수 있는 머신은 다음과 같이 표현할 수 있다.

```yaml
agent:
  id: art-machine

  capabilities:
    - planning
    - art-generation
    - art-review

  backends:
    - comfyui
```

Agent Runtime 자체는 동일하게 유지한다.

---

# 4. Sub-agent와 Backend의 개념을 반드시 분리할 것

중요한 설계 원칙이다.

```text
Sub-agent
= 무엇을 판단하고 어떤 역할을 수행하는가

Backend
= 실제로 무엇을 사용하여 행동하는가
```

예:

```text
Programming Sub-agent
→ Local Code Backend

Art Sub-agent
→ ComfyUI Backend

3D Sub-agent
→ Blender Backend

Testing Sub-agent
→ Local / CI Backend
```

다음과 같은 모델은 피한다.

```text
ComfyUI Agent
Codex Agent
Blender Agent
```

이 구조는 역할, 모델, 도구, 실행 환경의 추상화 수준을 섞기 때문이다.

---

# 5. Jira Workflow

MVP Jira Workflow의 핵심 흐름은 다음과 같이 유지한다.

```text
Backlog
   ↓
Ready for Planning
   ↓
AI Planning
   ↓
Plan Review
   ↓
Ready
   ├───────────────┐
   ▼               ▼
In Progress   AI Implementation
   │               │
   └───────┬───────┘
           ▼
         Review
           ↓
          Done
```

## Ready for Planning

인간이 이 상태로 변경하면 AI Planning을 시작한다.

Agent는 다음 capability를 사용할 수 있다.

```text
planning
task-decomposition
dependency-analysis
capability-analysis
```

결과는 Jira Issue/Sub-task 형태로 기록한다.

---

## Plan Review

인간이 생성된 계획을 검토한다.

AI는 이 상태에서 구현하지 않는다.

인간이 작업 범위, dependency, acceptance criteria 등을 수정할 수 있어야 한다.

---

## AI Implementation

이 상태 변경이 **AI 실행 승인 명령**이다.

다음 조건을 모두 만족할 경우에만 실행한다.

```text
status == AI Implementation

AND

assignee exists

AND

required capabilities can be satisfied
```

Assignee는 계속 인간으로 유지한다.

AI Implementation 상태라고 해서 Jira Assignee를 Agent로 변경하지 않는다.

---

## Review

AI 구현 완료 후 자동으로 Review 단계로 넘길 수 있다.

Agent는 PR, commit, test result, implementation summary 등을 Jira에 기록한다.

최종 승인과 Done 전환은 인간이 수행하는 것을 기본 정책으로 한다.

---

# 6. Planning 결과 모델

Planning 단계에서 PM 전용 Agent가 계획을 생성하는 것이 아니라 현재 작업을 받은 Agent가 Planning capability를 사용한다.

Planning 결과에는 최소한 다음 정보가 포함되어야 한다.

```text
Objective

Acceptance Criteria

Dependencies

Constraints

Required Capabilities

Suggested Execution Strategy
```

예:

```text
Objective
Inventory Drag & Drop 구현

Acceptance Criteria
- slot drag 가능
- valid target 표시
- invalid drop 복구
- Inventory API를 통해서만 데이터 수정

Dependencies
- GAME-141 Inventory API

Required Capabilities
- programming
- ui

Constraints
- 기존 InventoryView 구조 유지
```

중요:

Jira에는 지나치게 낮은 수준의 구현 절차를 기록하지 않는다.

다음과 같은 내용은 Agent Internal Plan으로 처리한다.

```text
수정할 클래스
사용할 함수
구현 알고리즘 세부 단계
코드 작성 순서
테스트 실행 순서
```

---

# 7. Capability 모델 구현

Agent가 지원하는 기능을 문자열 또는 enum 기반 capability로 표현할 수 있는 구조를 만든다.

초기 capability 후보:

```text
planning
task-decomposition
dependency-analysis

programming
ui
testing
review

art-generation
art-review

unity
```

단, capability 목록을 코드 전체에 하드코딩하여 분기문이 증가하는 구조는 피한다.

가능하면 configuration/registry 기반으로 설계한다.

MVP에서는 완전한 plugin framework까지 구현할 필요는 없다.

다음 정도면 충분하다.

```text
CapabilityRegistry

AgentProfile
 ├ capabilities
 └ backends
```

---

# 8. Agent Profile

각 Agent Runtime은 시작 시 자신의 Profile을 로드한다.

Profile에는 최소 다음 정보가 포함된다.

```text
agent id

capabilities

available backends

runtime/provider configuration
```

가능하면 기존 설정 파일 시스템을 확장한다.

별도 DB를 추가하지 않는다.

예:

```yaml
id: dev-pc

capabilities:
  - planning
  - task-decomposition
  - programming
  - ui
  - testing
  - review

backends:
  - filesystem
  - git
  - unity
```

---

# 9. Backend 인터페이스

외부 환경을 Backend abstraction으로 분리한다.

MVP에서 우선 필요한 backend와 향후 backend를 구분한다.

초기 구현:

```text
filesystem
git
existing coding runtime
```

확장 가능한 구조만 준비:

```text
unity
comfyui
blender
ci
```

Backend는 capability와 동일한 개념이 아니다.

예:

```text
Capability:
art-generation

Backend:
comfyui
```

Agent가 `art-generation` capability를 수행하기 위해 ComfyUI backend를 사용할 수 있다.

---

# 10. ComfyUI 처리

ComfyUI는 이번 단계에서 완전한 기능 구현을 요구하지 않는다.

대신 architecture가 ComfyUI 같은 독립 실행 환경을 자연스럽게 연결할 수 있도록 만들어야 한다.

목표 구조:

```text
Art Sub-agent
      ↓
art-generation capability
      ↓
ComfyUI Backend Adapter
      ↓
ComfyUI Server
      ↓
Generated Asset
      ↓
Agent
      ↓
validation / Jira result / repository
```

MVP에서는 다음 수준까지 허용한다.

```text
ComfyUIBackend interface 또는 adapter contract 정의

실제 backend 구현은 stub/placeholder 가능
```

단, 기존 코드에 ComfyUI 전용 분기를 대량으로 추가하면 안 된다.

---

# 11. Agent Dispatch

현재 여러 Agent Runtime이 실행될 수 있는 구조가 존재하거나 예정되어 있다면 capability 기준으로 task를 받을 수 있도록 수정한다.

개념적으로:

```text
Issue
  ↓
Required Capabilities
  ↓
Agent Profile 확인
  ↓
실행 가능한 Agent 선택
```

예:

```text
Required:
programming
ui
```

Agent A:

```text
planning
programming
ui
testing
```

→ 실행 가능

Agent B:

```text
planning
art-generation
```

→ 실행 불가

MVP에서 중앙 집중식 scheduler가 없다면 복잡한 scheduler를 새로 만들지 않는다.

각 Agent가 webhook/event를 받고:

```text
canHandle(issue)
```

여부를 판단하는 구조도 허용한다.

현재 프로젝트 구조에 더 단순하게 적용되는 방식을 선택한다.

---

# 12. 중복 실행 방지

여러 Agent가 같은 Issue를 잡는 문제를 반드시 고려한다.

기존에 execution lock 또는 job state가 있다면 재사용한다.

없다면 최소한 다음과 같은 추상화를 설계한다.

```text
Issue Execution Lease

issueId
agentId
executionId
startedAt
```

단, MVP에서는 분산 lock 시스템까지 만들 필요는 없다.

현재 실행 환경에서 중복 실행을 방지할 수 있는 가장 단순한 방법을 선택한다.

향후 여러 머신에서 동시에 Agent를 실행할 때 교체 가능하도록 경계를 만든다.

---

# 13. Sub-agent Orchestration

하나의 Agent가 작업을 처리할 때 내부적으로 필요한 역할을 순차적으로 사용할 수 있도록 한다.

예:

```text
AI Planning

Planning
→ Task Decomposition
→ Dependency Analysis
```

구현:

```text
AI Implementation

Planning
→ Programming / UI
→ Testing
→ Review
```

Art:

```text
Planning
→ Art
→ ComfyUI Backend
→ Art Review
```

MVP에서는 범용 DAG orchestration engine을 만들지 않는다.

현재 Agent harness가 sub-agent 또는 역할 기반 prompt 호출을 지원한다면 그것을 활용한다.

없다면 간단한 sequential pipeline으로 구현한다.

---

# 14. 기존 PM Agent / Worker Agent migration

현재 코드에서 다음 개념을 찾는다.

```text
PM Agent

Worker Agent

worker type

worker role

worker provider

worker routing

PM-specific execution flow
```

각 개념을 분석한 뒤 다음 방식으로 migration한다.

```text
PM Agent logic
→ planning/task-decomposition capabilities

Worker Agent logic
→ implementation-related capabilities

Worker provider
→ runtime/backend configuration

Worker type
→ capabilities

Worker routing
→ capability matching
```

기존 코드를 제거하기 전에 재사용 가능한 로직을 식별할 것.

가능하다면 호환 layer를 둬서 단계적으로 migration한다.

---

# 15. Jira Assignee 정책 변경

기존 코드가 Agent를 Jira Assignee로 설정하도록 구현되어 있다면 제거 또는 비활성화한다.

새 정책:

```text
Assignee = Human Owner
```

Agent 실행을 위해 Assignee를 변경하지 않는다.

AI 사용 여부는 status transition으로 결정한다.

```text
Ready
→ AI Implementation
```

이 transition을 인간의 AI 실행 승인으로 간주한다.

---

# 16. Webhook 처리

Webhook은 계속 시스템의 주요 event trigger로 사용한다.

중요 이벤트:

```text
issue created

status changed

comment added

assignee changed
```

특히:

```text
Ready for Planning
→ planning 실행

AI Implementation
→ implementation 실행
```

으로 연결한다.

Webhook handler 자체에 planning/implementation 로직을 넣지 않는다.

다음과 같이 분리한다.

```text
Webhook
   ↓
Event Normalizer
   ↓
Command / Job
   ↓
Agent Runtime
```

---

# 17. Jira 기록 정책

AI가 지나치게 많은 comment나 ticket을 생성하지 않도록 한다.

Sub-task를 생성하는 기준:

```text
독립적으로 완료할 수 있는가?

별도 Acceptance Criteria가 필요한가?

Dependency를 별도로 추적할 가치가 있는가?

실패/보류 상태를 별도로 관리할 가치가 있는가?
```

그렇지 않은 작업은 Agent internal plan에 둔다.

AI 구현 완료 시 Jira에는 다음 정도만 기록한다.

```text
Implementation summary

Changed scope

Test result

Commit / PR

Warnings / unresolved issues
```

Agent의 상세 reasoning이나 내부 Sub-agent 대화는 Jira에 기록하지 않는다.

---

# 18. Human takeover

Assignee는 원래 인간이므로 Human takeover를 위해 Assignee 변경이 필요하지 않다.

AI 구현을 중단하고 사람이 직접 작업해야 하는 경우 다음 흐름을 지원할 수 있어야 한다.

```text
AI Implementation
↓
In Progress
```

AI execution이 이미 동작 중인 경우 안전하게 중단 또는 후속 실행을 막을 방법을 검토한다.

MVP에서는 강제 process kill보다:

```text
execution cancellation flag

next step cancellation

result discard
```

등 현재 구조에서 안전한 방식을 우선한다.

---

# 19. 실패 처리

Agent 실행 실패 시 자동으로 Done 처리하면 안 된다.

예:

```text
AI Implementation
     ↓
Execution Failure
     ↓
Review 또는 기존 상태 유지
```

Jira comment에 최소한 다음을 기록한다.

```text
실패 단계

간단한 원인

재시도 가능 여부

인간이 필요한 조치
```

MVP에서는 복잡한 자동 retry 정책을 만들 필요 없다.

---

# 20. 이번 구현 범위에서 제외

다음 기능은 이번 작업에서 구현하지 않는다.

```text
완전한 분산 Agent Scheduler

Agent Marketplace

동적 plugin 설치 시스템

범용 DAG Workflow Engine

Agent별 Jira 계정

Agent용 이메일 계정 관리

자동 Atlassian 사용자 생성

복잡한 Agent load balancing

실행 중 Agent 간 live handoff

완전한 ComfyUI integration

Blender integration

Audio / Video generation backend

자체 프로젝트 관리 UI
```

단, 향후 추가할 수 있도록 interface boundary는 깨끗하게 유지한다.

---

# 21. 권장 구현 순서

## Phase 1: 현재 코드 분석

현재 repository에서 다음을 찾는다.

```text
Jira webhook entrypoint

workflow/status 처리

PM Agent

Worker Agent

provider/runtime abstraction

config

job/execution 관리

Jira API wrapper

prompt/system instruction 구성
```

현재 구조를 문서화한다.

---

## Phase 2: 공통 Agent 모델

다음을 추가 또는 기존 구조에서 추출한다.

```text
AgentProfile

Capability

Backend

AgentRuntime
```

기존 PM/Worker가 이 공통 구조 위에서 동작하도록 먼저 변경한다.

아직 기존 흐름을 제거하지 않는다.

---

## Phase 3: Capability 기반 Planning

기존 PM Agent의:

```text
planning
task decomposition
dependency analysis
worker selection
```

중 앞의 세 기능을 capability 기반 Agent 실행으로 이동한다.

`worker selection`은 `required capability determination`으로 변경한다.

---

## Phase 4: AI Implementation trigger

Jira status가 `AI Implementation`으로 변경되었을 때만 AI implementation이 실행되도록 변경한다.

Assignee 변경을 실행 trigger로 사용하지 않는다.

Assignee는 인간으로 유지한다.

---

## Phase 5: Capability matching

Planning 결과의 required capabilities와 현재 AgentProfile을 비교하여 해당 Agent가 작업을 처리할 수 있는지 판단한다.

최소 인터페이스:

```text
canHandle(requiredCapabilities)
```

실패 시 명확한 이유를 Jira에 남긴다.

---

## Phase 6: Sub-agent 역할 통합

기존 PM/Worker별 prompt 또는 실행기를 다음 역할로 재구성한다.

```text
planning
implementation
testing
review
```

가능하면 기존 harness의 sub-agent 기능을 활용한다.

---

## Phase 7: Backend abstraction

현재 filesystem/git/tool 실행 구조를 Backend abstraction 아래로 정리한다.

ComfyUI용 contract를 추가할 수 있지만 실제 integration은 필수가 아니다.

---

## Phase 8: 기존 PM/Worker 제거

모든 호출 경로가 새로운 AgentRuntime을 사용하게 된 것을 확인한 뒤 기존 PM/Worker 전용 abstraction을 제거하거나 compatibility wrapper로 축소한다.

---

## Phase 9: 테스트

아래 시나리오를 검증한다.

```text
Ready for Planning → AI planning

Plan Review에서는 구현하지 않음

AI Implementation → 구현 시작

Assignee가 인간으로 유지됨

Programming capability 작업 성공

UI capability 작업 성공

지원하지 않는 capability 작업 거부

중복 webhook 시 중복 실행 방지

AI Implementation에서 Human In Progress로 변경

실행 실패

PR/commit 결과 Jira 기록

기존 프로젝트 설정 migration
```

---

# 22. Acceptance Criteria

이번 변경은 다음 조건을 만족하면 완료로 본다.

- PM Agent와 Worker Agent가 서로 다른 핵심 실행 타입으로 존재하지 않는다.
- 공통 Agent Runtime이 planning과 implementation을 모두 수행할 수 있다.
- Agent의 차이는 Capability Profile과 Backend 구성으로 표현된다.
- Jira Assignee는 AI 실행 과정에서도 인간으로 유지된다.
- `AI Implementation` 상태 전환이 실제 AI 구현 trigger가 된다.
- Planning 결과에 required capabilities가 포함된다.
- Agent가 자신의 capabilities로 issue 처리 가능 여부를 판단할 수 있다.
- 기존 programming workflow가 정상 동작한다.
- 기존 Jira webhook 기반 구조가 유지된다.
- 상세 실행 plan은 Jira가 아니라 Agent 내부에서 관리된다.
- ComfyUI 같은 외부 환경을 Backend Adapter 형태로 추가할 수 있는 구조가 존재한다.
- 이번 작업에서 불필요한 범용 orchestration framework를 새로 만들지 않는다.

---

# 23. 설계 판단 우선순위

구현 중 애매한 선택지가 생기면 다음 우선순위로 판단한다.

```text
1. Human responsibility / explicit AI approval

2. Jira as source of truth

3. 단순한 MVP

4. 기존 코드 재사용

5. 명확한 abstraction boundary

6. 향후 multi-machine 확장성

7. 범용성
```

미래 확장성을 위해 현재 구조를 과도하게 복잡하게 만들지 않는다.

---

# 24. Plan Mode 최종 출력 요구사항

코드를 수정하기 전에 다음 형식으로 계획을 제출한다.

## Current Architecture

현재 코드가 어떻게 동작하는지 요약.

## Gap Analysis

현재 구조와 목표 구조의 차이.

## Keep

그대로 유지할 기존 코드와 이유.

## Modify

수정할 모듈/파일과 변경 내용.

## Remove / Deprecate

제거하거나 deprecated할 PM/Worker 관련 구조.

## New Abstractions

추가할 최소 abstraction.

## Migration Order

기존 기능을 깨뜨리지 않고 migration하는 순서.

## Tests

변경을 검증할 테스트.

## Risks

특히 webhook 중복 실행, multi-agent 충돌, 기존 설정 호환성 문제.

## Deferred

이번 구현에서 의도적으로 제외하는 확장 기능.

계획을 작성한 뒤 프로젝트 규모에 비해 과도하게 복잡한 부분이 있다면 스스로 단순화안을 제시한다.

최우선 목표는 **완벽한 범용 Multi-Agent Framework를 만드는 것이 아니라, GGJIRA의 현재 MVP를 capability 기반 Agent 구조로 안전하게 진화시키는 것**이다.