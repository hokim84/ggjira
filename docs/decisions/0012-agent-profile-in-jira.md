# 0012: Agent Profile / Workspace Configuration을 Jira Issue로, 등록은 issue property로

## Context

`advanced_plan.md`는 Agent의 설정과 정체성을 사람이 Jira에서 정의·수정할 수 있게 하고,
새 머신이 `ggjira setup`에서 프로필을 선택해 자동 구성되도록 요구한다(§1, §3). 동시에
다음을 지켜야 한다.

- 기존 Jira Workflow(Status/Transition)를 확장하거나 강제하지 않는다(§2, §9, §17).
- 인증정보·로컬 저장소 경로·machine id 같은 민감/머신 종속 정보는 Jira에 저장하지 않는다
  (§4, §21).
- 동일 Agent Profile을 여러 머신이 동시에 점유하는 것을 최소한으로 막는다(§9, §19).
- 설치가 간단할 것을 최우선으로 한다(§27) — 새 Jira 프로젝트 설정 단계를 늘리지 않는다.

기존 코드(`src/jira/gateway.ts`)는 이슈 CRUD, 라벨, 코멘트, 전이만 다뤘고 project 조회나
issue property 읽기/쓰기가 없었다.

## Decision

- Agent Profile과 Workspace Configuration을 **일반 Jira Issue**로 표현한다
  (`src/profile/`). 새 이슈 타입이나 워크플로우를 만들지 않고, 프로젝트에 이미 있는
  이슈 타입(설정 시 선택) 하나를 재사용한다.
  - `[AGENT] <agentId>` + 라벨 `ggjira-agent` — Agent 하나당 이슈 하나.
  - `[GGJIRA] Workspace Configuration` + 라벨 `ggjira-workspace` — 프로젝트당 이슈 하나.
  - 검색은 항상 `project = "<KEY>" AND labels = "<라벨>"` JQL. Status는 관여하지 않는다.
- **사람이 읽고 고치는 값**(Role, Preset, Capabilities, Work Style, Human Instructions,
  Workflow 상태/전이 이름, Project Policy)은 이슈 **description**에 작은 wiki-markup
  섹션 형식(`h2. 제목`, `Key: value`, `* item`)으로 담는다(`src/profile/description.ts`).
  Jira Cloud REST v2는 ADF 에디터로 사람이 수정한 내용도 이 형식으로 돌려주므로
  round-trip이 된다. **GGJIRA는 생성 이후 description을 다시 쓰지 않는다** — 사람의
  편집을 프로그램이 덮어쓸 수 없다.
- **기계 전용 등록 정보**(machineId, jiraAccountId, registeredAt, claimToken,
  ggjiraVersion)는 새로 추가한 Jira **entity property** `GET/PUT
  /rest/api/2/issue/{key}/properties/ggjira.registration`에 JSON으로 저장한다
  (`JiraGateway.getIssueProperty`/`setIssueProperty`). Description과 분리한 이유:
  property는 Jira UI에 노출되지 않아 사람이 실수로 지우거나 description 서식을 깨뜨릴
  위험이 없고, "등록 여부"라는 사실 자체가 property 존재 여부로 자연스럽게 표현된다.
- **Enabled/Disabled**는 라벨 `ggjira-disabled` 유무로 표현한다 — 사람이 Jira UI에서
  라벨 하나로 켜고 끌 수 있고, 등록 상태와 독립적으로 동작한다.
- **Claim(등록)**은 `claimAgentProfile()`이 담당한다: property 읽기 → 다른 머신이 이미
  등록돼 있으면 명시적 `takeover` 없이는 거부 → property 쓰기 → 짧은 지연 후 재읽기로
  동시 claim을 감지(다르면 `ProfileClaimLostError`) → (등록이 실제로 바뀐 경우에만)
  안내 댓글. 완전한 분산 락이 아니라 **MVP 수준의 마지막-쓰기-승리 보호**이며, 이는
  advanced_plan.md §19가 명시적으로 허용한 범위다. Lease/heartbeat 기반 강한 보장은
  향후 과제로 남긴다.
- `[AGENT]`/`[GGJIRA]` 이슈는 생성 직후 담당자를 해제하고(`assignIssue(key, null)`),
  폴러가 이 두 라벨을 가진 이슈를 후보에서 제외한다 — 프로젝트 기본 담당자가 PM
  계정이면 GGJIRA 자신의 메타 이슈가 작업으로 오폴링될 수 있기 때문이다.

## Consequences

- Jira Workflow를 전혀 바꾸지 않으므로 기존 보드/자동화와 충돌하지 않는다. 대가로
  "Unregistered/Registered/Disabled"라는 논리 상태가 Jira UI에는 명시적인 컬럼으로
  보이지 않는다 — `ggjira agent:list`나 `ggjira setup --check`로 확인해야 한다.
- Description을 프로그램이 재작성하지 않기로 했으므로, `renderProfileDescription` /
  `renderWorkspaceDescription`은 **생성 시점에만** 쓰인다. 향후 PM이나 CLI가 필드를
  갱신해야 하는 기능(예: Capabilities 자동 업데이트)이 생기면 이 결정을 재검토해야
  한다.
- `JiraGateway`에 4개 메서드(`listProjects`, `getProject`, `getIssueProperty`,
  `setIssueProperty`)가 늘었다 — `JiraClient`/`FakeJiraGateway` 양쪽 구현 필요(CLAUDE.md
  §디렉터리=계층 규칙과 별개로, 인터페이스를 건드릴 때 항상 따라오는 비용).
- 실 Jira에서 issue property PUT의 정확한 상태 코드(200/201, 빈 body)는 Atlassian
  문서로만 확인했고 실사용 검증은 아직이다 — `docs/phase3-verification.md`(수동 검증)
  항목으로 남긴다.
