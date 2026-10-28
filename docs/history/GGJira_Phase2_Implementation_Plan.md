# GGJira 2차 구현 계획서

> Claude Plan / Implementation용  
> 전제: GGJira MVP는 이미 구현 완료된 상태이며, 기존 구현을 폐기하거나 전면 재작성하지 않는다.  
> 목표: 기존 MVP를 기반으로 **Plan Mode + Jira Assignee 기반 Agent Dispatch + Multi-Machine Agent 실행**을 추가한다.

---

## 1. 프로젝트 방향

GGJira의 핵심 원칙은 다음과 같다.

- Jira를 Human / Agent 공용 작업 인터페이스로 사용한다.
- Jira가 프로젝트의 공식 작업 상태와 인간이 확인해야 할 정보를 가진다.
- PM Agent는 요구사항을 분석하고 계획 및 하위 티켓을 생성한다.
- Implement Agent는 할당된 Jira 티켓을 가져가 작업하고 결과를 Jira에 기록한다.
- 인간은 Jira를 통해 계획을 검토하고 필요할 때 개입한다.
- 인간이 Agent 내부 실행 과정이나 여러 머신의 세부 상태를 기억할 필요가 없어야 한다.
- 가능한 한 단순한 구조를 유지하며, 실제 필요가 확인되기 전에는 별도의 분산 인프라를 추가하지 않는다.

2차 구현에서도 이 원칙을 유지한다.

---

# 2. 2차 구현 목표

2차 구현의 핵심 목표는 다음 흐름을 완성하는 것이다.

```text
Human
  ↓
Jira Issue
  ↓
PM Agent
  ↓
Plan
  ├─ 결정 불필요 → 실행 Task 생성
  │
  └─ 결정 필요 → Needs Decision
                    ↓
                  Human
                    ↓
                  Replan
                    ↓
              실행 Task 생성
                    ↓
             Jira Assignee
              ↙          ↘
      Implement Agent   Implement Agent
        Machine A         Machine B
              ↓
          Implementation
              ↓
        Jira 결과 기록
```

여기서 중요한 설계 원칙은 다음과 같다.

**PM Agent가 Implement Agent를 직접 실행하지 않는다.**

PM Agent는 Jira에 실행 가능한 티켓을 만들고 적절한 Agent Identity를 Assignee로 지정한다.

각 머신에서 실행 중인 GGJira Agent가 자신에게 할당된 작업을 독립적으로 가져가 수행한다.

---

# 3. 핵심 개념

## 3.1 공통 Agent Runtime

PM Agent, Implement Agent 등을 서로 다른 프로그램으로 만들지 않는다.

가능하면 동일한 GGJira Agent Runtime을 사용하고 다음 설정으로 역할을 결정한다.

```text
GGJira Agent Runtime
        +
Agent Configuration
        +
System Prompt
        =
Agent Role
```

예:

```text
runtime + pm system prompt
→ PM Agent

runtime + implement system prompt
→ Implement Agent
```

초기 2차 구현에서 필수 역할은 두 개만 지원한다.

- `pm`
- `implement`

향후 필요에 따라 아래 역할을 추가할 수 있지만 이번 범위에는 포함하지 않는다.

- `review`
- `test`
- `tech-art`
- 기타 specialized role

---

## 3.2 Agent Identity와 Machine Identity

두 개념을 반드시 분리한다.

### Agent Identity

Jira에서 작업을 할당받는 논리적 작업자.

예:

```text
ggjira-pm
ggjira-implement
```

### Machine Identity

실제 GGJira Runtime이 실행되는 물리적/논리적 환경.

예:

```text
HODORI-HOME
OFFICE-PC
BUILD-SERVER
```

관계 예:

```text
ggjira-implement
        ↓
   HODORI-HOME
```

나중에는 동일 Agent Identity를 다른 머신에서 실행할 수도 있다.

```text
ggjira-implement
        ↓
    OFFICE-PC
```

따라서 Jira의 작업 할당 모델에 Machine 이름을 직접 결합하지 않는다.

---

# 4. 기존 MVP에서 수정해야 할 부분

## 4.1 PM → Worker 직접 실행 제거

### 기존 개념

```text
PM Agent
   ↓
Worker / Implement Agent 직접 실행
```

### 변경

```text
PM Agent
   ↓
Jira Task 생성
   ↓
Jira Assignee 지정
   ↓
Implement Agent가 작업 발견
   ↓
Claim
   ↓
Execute
```

PM Agent의 책임은 다음 범위로 제한한다.

1. 요구사항 분석
2. 계획 작성
3. 필요한 경우 인간에게 결정 요청
4. 실행 가능한 하위 티켓 생성
5. 각 티켓의 Assignee 결정

실제 구현 Agent의 실행 생명주기를 PM Agent가 직접 관리하지 않는다.

---

## 4.2 Agent 구현 일반화

기존 코드에 PM / Worker별 실행 코드가 강하게 결합되어 있다면 공통 Runtime으로 추출한다.

공통화 후보:

- Jira 연결
- 인증
- Issue 조회
- Issue 상태 변경
- Comment 작성
- LLM Provider 실행
- Workspace 관리
- Git 관련 처리
- 결과 기록
- 오류 처리
- Agent execution loop

역할별 차이는 가능한 한 다음으로 제한한다.

- System Prompt
- Role configuration
- 처리 가능한 Jira workflow/state
- 역할별 task handler

전면 재작성보다 기존 구현을 재사용하는 리팩터링을 우선한다.

---

## 4.3 Jira 인증 설정 정리

기존 인증 코드가 환경변수나 설정 파일에 직접 결합되어 있다면 Setup 프로세스에서 사용할 수 있도록 분리한다.

인증 처리와 일반 Agent 설정을 가능한 한 분리한다.

예:

```text
config
credentials
```

인증 정보가 일반 설정이나 로그에 노출되지 않도록 한다.

---

## 4.4 실행 결과 처리 표준화

기존 Agent 결과 기록을 다음 개념으로 정리한다.

```text
Status
Summary
Changes
Validation
Artifacts
Failure Reason
```

성공 예:

```text
Implementation completed.

Summary:
Formation avoidance implemented.

Changes:
- FormationController
- FormationMovement

Validation:
- Unit tests passed
- Unity compilation passed

Artifacts:
- Commit: abc123
```

실패 예:

```text
Execution failed.

Summary:
Implementation could not be completed.

Failure Reason:
Unity project failed to compile.

Blocking Issue:
GGJ-138
```

결과 포맷은 PM Agent 또는 인간이 Jira만 보고 후속 판단을 할 수 있는 수준이면 된다.

---

# 5. 새로 추가해야 할 부분

# 5.1 `ggjira setup`

GGJira 설치 후 최초 실행 시 Setup Wizard를 제공한다.

목표:

> 사용자가 설정 파일을 직접 편집하지 않고 하나의 Agent를 실행 가능한 상태로 만든다.

예상 UX:

```text
$ ggjira setup

Welcome to GGJira

Jira URL:
> https://example.atlassian.net

Authentication:
> API Token

✓ Jira connection successful

Agent Identity:
> ggjira-implement

Role:
> implement

Machine:
> HODORI-HOME

Workspace:
> D:\Projects\Game

Provider:
> Codex

✓ Setup complete
```

Setup에서 최소한 다음 정보를 구성한다.

```text
jira site
jira authentication
agent identity
agent role
machine identity
workspace
llm provider
system prompt / prompt selection
```

### Setup 요구사항

- Jira 연결 검증
- 인증 정보 검증
- Agent Identity 확인
- Role 선택
- Machine 이름 기본값 자동 제안 가능
- Workspace 존재 여부 검증
- Provider 설정 검증
- 완료 후 실제 실행 가능한 configuration 생성

### 인증

2차 구현에서는 기존 인증 방식을 최대한 재사용한다.

API Token 기반 인증을 우선 허용한다.

OAuth 또는 Service Account 자동 provisioning은 이번 구현의 필수 범위가 아니다.

향후 인증 구현을 교체할 수 있도록 인증 계층은 가능한 한 분리한다.

---

# 5.2 Jira Assignee 기반 Dispatch

Agent 작업 할당을 위해 별도의 중앙 Scheduler를 만들지 않는다.

Jira의 기존 `Assignee` 개념을 Agent에게도 사용한다.

예:

```text
GGJ-123

Assignee:
ggjira-implement

Status:
Ready for Execution
```

Implement Agent는 자신의 Jira identity에 할당된 실행 가능한 Issue를 검색한다.

개념적 조건:

```text
assignee = current agent
AND
status = Ready for Execution
```

이 구조를 통해 Jira 자체를 Human / Agent 공용 작업 인터페이스로 유지한다.

---

# 5.3 Agent Execution Loop

각 머신에서 Agent는 독립적으로 실행된다.

기본 실행 흐름:

```text
Start
 ↓
Load Configuration
 ↓
Authenticate Jira
 ↓
Load Agent Role / System Prompt
 ↓
Find Assigned Work
 ↓
Claim Job
 ↓
Execute
 ↓
Validate
 ↓
Report Result
 ↓
Complete / Fail
 ↓
Wait for next work
```

PM과 Implement 역할은 동일 Runtime을 사용하되 검색 대상 workflow/state와 system prompt가 다를 수 있다.

---

# 5.4 Job Claim

여러 머신에서 Agent가 실행될 가능성이 있으므로 동일 티켓의 중복 실행을 최소한 방지해야 한다.

2차 구현에서는 복잡한 distributed lock이나 별도 lease server를 만들지 않는다.

Jira 상태 전환을 최소 claim mechanism으로 사용한다.

예:

```text
Ready for Execution
        ↓
Agent discovers issue
        ↓
claimJob(issue)
        ↓
In Progress
```

다른 Agent가 조회했을 때 이미 실행 상태라면 가져가지 않는다.

### 코드 설계

구현은 단순하더라도 다음과 같은 명시적 abstraction을 둔다.

```text
claimJob(...)
```

현재 구현:

```text
claimJob
→ Jira workflow transition
```

향후 필요하면 내부 구현을 lease / lock 방식으로 교체할 수 있어야 한다.

완전한 distributed consistency를 이번 단계에서 해결하려고 하지 않는다.

---

# 5.5 Plan Mode

Plan Mode를 단순한 LLM 내부 planning 옵션으로 취급하지 않는다.

GGJira workflow의 공식 단계로 구현한다.

기본 흐름:

```text
Issue
 ↓
Planning
 ↓
Plan 생성
 ↓
실행 가능 여부 판단
```

결정이 필요하지 않은 경우:

```text
Plan
 ↓
Executable Tasks
 ↓
Ready for Execution
```

결정이 필요한 경우:

```text
Plan
 ↓
Needs Decision
 ↓
Human Decision
 ↓
Replan
 ↓
Executable Tasks
```

---

# 5.6 Human Decision

PM Agent가 중요한 설계 선택을 임의로 결정하면 안 되는 상황을 지원한다.

예:

```text
Option A
기존 FormationController 확장

Option B
별도 FormationAvoidance 모듈 생성
```

PM Agent는 Jira에 선택지와 판단에 필요한 정보를 기록하고 Issue를 `Needs Decision` 상태로 변경한다.

인간이 Jira에서 선택을 기록하면 PM Agent가 이를 입력으로 받아 다시 계획한다.

Human Decision에 포함될 수 있는 정보:

- 선택지
- 각 선택지의 장단점
- PM Agent 추천안 (필요한 경우)
- 결정이 필요한 이유
- 결정 이후 영향을 받는 작업

결정 UI를 위한 별도 Web UI는 만들지 않는다.

Jira의 기존 Issue / Comment / Field / Workflow 기능을 우선 활용한다.

---

# 5.7 Replan

Human Decision 또는 기존 계획의 변경으로 인해 PM Agent가 계획을 다시 생성할 수 있어야 한다.

Replan 시 고려사항:

- 기존 완료 Task를 불필요하게 다시 만들지 않는다.
- 아직 시작되지 않은 Task는 수정/취소할 수 있다.
- 인간이 내린 결정은 새로운 planning context에 반드시 포함한다.
- Jira가 최종 프로젝트 상태의 source of truth라는 원칙을 유지한다.

초기 구현에서는 복잡한 plan diff engine까지 만들 필요는 없다.

---

# 5.8 Multi-Machine 실행

동일 GGJira 프로그램을 여러 머신에 설치할 수 있어야 한다.

예:

```text
Machine A
- role: pm
- agent: ggjira-pm

Machine B
- role: implement
- agent: ggjira-implement

Machine C
- role: implement
- agent: ggjira-implement
```

각 머신은 중앙 GGJira 서버가 직접 명령을 push하는 방식보다 Jira에서 자신에게 할당된 작업을 발견하는 구조를 우선한다.

Machine 상태를 Jira에 상세하게 기록할 필요는 없다.

---

# 6. Jira와 내부 상태의 경계

Jira에는 인간과 Agent 모두가 알아야 하는 프로젝트 상태를 기록한다.

예:

```text
Issue
Assignee
Workflow State
Plan
Human Decision
Execution Result
Failure / Blocking information
```

로컬 Agent configuration에는 실행 환경 정보를 둔다.

예:

```text
Machine Identity
Workspace
Provider
Local Tool Configuration
Credentials
System Prompt
```

다음과 같은 머신 내부 정보를 Jira 프로젝트 모델에 억지로 넣지 않는다.

```text
CPU
RAM
Process ID
Heartbeat
Local path details
Runtime internals
```

필요성이 확인되기 전에는 Agent Registry도 만들지 않는다.

---

# 7. 2차 구현에서 제외할 것

다음 항목은 의도적으로 구현 범위에서 제외한다.

- 중앙 Agent Scheduler
- Agent Registry 서버
- Redis 기반 Job Queue
- Kafka
- Kubernetes Worker 관리
- 복잡한 capability matching
- Agent 간 직접 통신
- 자동 failover
- 완전한 distributed locking
- 복잡한 lease infrastructure
- Agent Jira 계정 자동 provisioning
- 조직 사용자 자동 생성
- 자체 Web UI
- 범용 multi-agent framework
- 과도한 역할 hierarchy

실제 사용 후 필요성이 확인되면 3차 이후에서 검토한다.

---

# 8. 구현 우선순위

## Phase 0. 기존 코드베이스 분석

구현을 시작하기 전에 반드시 현재 MVP 구조를 분석한다.

확인할 항목:

1. PM Agent entry point
2. Worker/Implement 실행 경로
3. Jira API abstraction
4. Jira authentication
5. Issue workflow 처리
6. LLM provider abstraction
7. System Prompt 구성 방식
8. Workspace / Git 처리
9. Agent 결과 기록 방식
10. Configuration 구조
11. CLI entry point
12. 테스트 구조

### 분석 결과로 먼저 작성할 것

- 현재 구조 요약
- 그대로 재사용 가능한 컴포넌트
- 수정해야 하는 컴포넌트
- 신규 컴포넌트
- 예상 migration risk

코드를 확인하기 전에 새로운 framework나 architecture를 가정하지 않는다.

---

## Phase 1. Agent Runtime 정리

목표:

```text
PM / Implement의 공통 실행 기반 확보
```

작업:

- 공통 Agent Runtime 추출
- Role configuration 도입
- System Prompt와 Runtime 분리
- PM → Implement 직접 실행 dependency 제거
- 기존 Jira / Provider / Workspace 코드 최대한 재사용

완료 조건:

```text
동일 Runtime이 설정 변경만으로
PM 또는 Implement 역할로 실행 가능
```

---

## Phase 2. Setup

작업:

- `ggjira setup`
- Jira connection validation
- Authentication configuration
- Agent Identity 설정
- Role 설정
- Machine Identity 설정
- Workspace 설정
- Provider 설정
- 설정 저장 및 재로딩
- credential 분리

완료 조건:

```text
새 머신에서 repository clone/install 후
config 파일 수동 수정 없이
ggjira setup만으로 Agent 실행 가능
```

---

## Phase 3. Jira Dispatch

작업:

- Agent Identity와 Jira Assignee 연결
- assigned work query
- Ready 상태 검색
- `claimJob`
- Jira workflow transition
- Agent execution
- standardized result reporting
- 완료 / 실패 상태 처리

완료 조건:

```text
Jira에서 Agent에게 Issue를 assign
        ↓
Agent가 발견
        ↓
claim
        ↓
execute
        ↓
결과 기록
```

이 E2E 흐름이 동작한다.

---

## Phase 4. Plan Mode

작업:

- Planning workflow
- Plan artifact 생성
- 실행 가능한 task 분해
- Assignee 지정
- Needs Decision
- Human Decision 입력
- Replan
- 최종 execution task 생성

완료 조건:

PM Agent가 단순 작업은 자동으로 실행 티켓까지 만들고, 중요한 선택이 필요한 작업은 인간의 결정을 기다린다.

---

## Phase 5. Multi-Machine E2E

최소 두 대 이상의 독립 실행 환경으로 검증한다.

예:

```text
Machine A
PM Agent

Machine B
Implement Agent
```

가능하면 추가로:

```text
Machine C
Implement Agent
```

를 실행하여 동일 역할 Agent가 여러 머신에서 동작할 때 기본적인 중복 실행 방지가 작동하는지 확인한다.

---

# 9. Definition of Done

2차 구현은 다음 시나리오가 처음부터 끝까지 성공하면 완료로 본다.

## Scenario A: 자동 계획 및 구현

```text
1. Human이 Jira에 요구사항 Issue 생성
2. ggjira-pm에게 할당
3. PM Agent가 Issue 발견
4. Plan 생성
5. Human Decision이 필요 없다고 판단
6. 실행 가능한 하위 Issue 생성
7. ggjira-implement를 Assignee로 지정
8. 다른 머신의 Implement Agent가 Issue 발견
9. Issue Claim
10. 구현 수행
11. Validation 수행
12. 결과 / commit / validation 정보를 Jira에 기록
13. Issue 완료
```

---

## Scenario B: Human Decision

```text
1. Human이 Jira에 요구사항 Issue 생성
2. PM Agent가 Plan 생성
3. 두 개 이상의 중요한 구현 선택지 발견
4. Jira에 선택지 기록
5. Needs Decision으로 전환
6. PM Agent 실행 중단
7. Human이 Jira에서 선택
8. PM Agent가 결정 확인
9. Replan
10. 실행 Task 생성
11. Implement Agent에게 할당
12. 구현 완료
```

---

## Scenario C: Multi-Machine

```text
Machine A:
ggjira-pm

Machine B:
ggjira-implement

Machine C:
ggjira-implement
```

검증:

- 각 머신이 독립적으로 setup 가능
- 동일 코드베이스 사용
- 역할은 configuration/system prompt로 결정
- PM이 Worker process를 직접 실행하지 않음
- Jira를 통해 작업 전달
- 동일 Issue가 의도치 않게 중복 실행되지 않음
- 결과가 Jira에서 확인 가능

---

# 10. 테스트 전략

## Unit Tests

우선 테스트 대상:

- config load/save
- role resolution
- system prompt resolution
- assigned issue filtering
- job claim
- result formatting
- workflow state validation
- human decision parsing
- replan input construction

## Integration Tests

Mock 또는 test Jira environment를 이용해 검증한다.

```text
Jira Issue
→ discovery
→ claim
→ execute mock
→ result report
→ transition
```

Plan Mode:

```text
Issue
→ PM
→ plan
→ needs decision
→ decision
→ replan
→ subtasks
```

## E2E Tests

실제 Jira test project를 사용하여 최소:

- PM 머신 1대
- Implement 머신 1대

로 전체 workflow를 검증한다.

Multi-machine claim은 가능하면 Implement 머신 2대로 검증한다.

---

# 11. 구현 시 지켜야 할 원칙

## 기존 구현 우선

MVP는 이미 동작하고 있다.

따라서:

```text
Rewrite < Refactor < Reuse
```

순으로 판단하지 말고, 실제 우선순위는:

```text
Reuse
→ 필요한 부분만 Refactor
→ 불가피할 때만 Rewrite
```

로 한다.

---

## Jira 중심 구조 유지

새로운 기능을 구현하기 위해 별도의 중앙 상태 저장소를 성급하게 만들지 않는다.

가능하면:

```text
Jira = Project / Work State
Local Config = Agent Execution State
```

경계를 유지한다.

---

## 분산 시스템을 미리 만들지 않는다

Multi-Machine 지원이 필요하다고 해서 곧바로 Scheduler / Registry / Queue architecture를 도입하지 않는다.

2차 구현의 목적은:

```text
Jira
  ↓
independent GGJira Agents
```

가 실제로 충분히 동작하는지 확인하는 것이다.

---

## 확장 가능한 경계만 확보

현재 구현은 단순하게 하되 향후 교체 가능성이 높은 부분에는 작은 abstraction을 둔다.

특히:

```text
authenticate()
findAssignedJobs()
claimJob()
executeJob()
reportResult()
loadRole()
```

등.

하지만 미래 기능을 위한 대규모 framework를 미리 구현하지 않는다.

---

# 12. Claude 구현 진행 지침

이 문서를 받은 뒤 바로 코드를 수정하지 말고 다음 순서로 진행한다.

## Step 1. Repository 분석

현재 repository 전체 구조를 확인한다.

특히 다음 구현을 찾아라.

- PM Agent
- Implement/Worker 실행
- Jira client
- Jira webhook/polling
- Jira workflow
- configuration
- authentication
- CLI
- LLM provider
- system prompt
- workspace
- Git
- result reporting
- tests

---

## Step 2. 현재 구현과 본 문서의 차이 분석

다음 형식으로 정리한다.

```text
Already Implemented
Needs Modification
Needs Addition
Can Be Reused As-Is
Potential Breaking Changes
```

추측하지 말고 실제 코드를 근거로 판단한다.

---

## Step 3. 구현 Plan 작성

파일 및 모듈 단위의 구체적인 변경 계획을 작성한다.

각 단계에 다음을 포함한다.

```text
Purpose
Existing Code Used
Files Changed
New Files
Behavior Change
Tests
Migration Risk
```

Plan은 가능한 한 작은 단계로 나누되 Jira에 불필요할 정도로 세분화하지 않는다.

---

## Step 4. 구현

승인된 Plan에 따라 순차적으로 구현한다.

우선순위:

```text
Runtime separation
→ Setup
→ Assignee Dispatch
→ Job Claim
→ Result Reporting
→ Plan Mode
→ Human Decision / Replan
→ Multi-Machine validation
```

각 단계에서 기존 테스트가 깨지지 않는지 확인한다.

---

## Step 5. 완료 보고

구현 후 다음을 정리한다.

```text
Implemented
Modified Existing Behavior
New Configuration
Jira Configuration Required
Migration Steps
Tests Performed
Known Limitations
Deferred to Phase 3
```

---

# 13. 3차 이후 후보

2차 구현 중 실제 필요성이 확인된 경우에만 다음 기능을 후보로 기록한다.

```text
Agent Registry
Capability Matching
Scheduler
Job Lease
Heartbeat
Failover
Agent Affinity
Parallel Plan Execution
Review Agent
Test Agent
Model Routing
Cost Routing
Remote Agent Monitoring
```

2차 구현 도중 이 기능들이 편리해 보인다는 이유만으로 scope에 포함하지 않는다.

---

# 14. 최종 아키텍처 요약

2차 구현 완료 시 목표 구조:

```text
                         Jira
                           │
            ┌──────────────┴──────────────┐
            │                             │
        PM Agent                   Implement Agent
        Machine A                    Machine B
            │                             │
     System Prompt: PM           System Prompt: Implement
            │                             │
            └──────── Jira Workflow ──────┘
                           │
                    Implement Agent
                       Machine C
                           │
                 System Prompt: Implement
```

작업 전달:

```text
PM
 ↓
Jira Task + Assignee
 ↓
Implement Agent
```

사람의 개입:

```text
PM Plan
 ↓
Needs Decision
 ↓
Human via Jira
 ↓
Replan
```

머신 간 통신:

```text
직접 통신하지 않음
```

중앙 Scheduler:

```text
없음
```

공식 프로젝트 작업 상태:

```text
Jira
```

Agent 역할 결정:

```text
Agent configuration + System Prompt
```

---

# 15. 최종 원칙

GGJira 2차의 목표는 범용 Multi-Agent 플랫폼을 만드는 것이 아니다.

목표는 단순하다.

> **사람이 Jira에서 Agent에게 사람처럼 작업을 할당하고, 서로 다른 머신의 GGJira Agent들이 그 작업을 독립적으로 수행하며, PM Agent가 계획과 인간의 의사결정을 Jira workflow 안에서 조율할 수 있게 한다.**

이 구조가 실제 사용에서 한계에 도달했을 때만 Scheduler, Registry, Queue 등의 다음 계층을 추가한다.
