# ADR 0016: Human-approved PM 배포의 메타데이터·게이팅 규칙

## Context

`GGJira_Phase2_Implementation_Plan.md`가 요구하는 "PM이 계획을 세우면 사람이 검토·승인한
뒤에만 Implement Agent가 실행하고, 실행 Agent도 사람이 지정한다"는 흐름을
(`feat: add human-approved PM planning and Jira agent distribution`, 2026-09-17) 구현했다.
이 커밋은 코드와 테스트를 함께 들여왔지만 설계를 기록한 ADR이 없었고, 뒤이은 검토에서 다음
문제가 드러났다.

- **재계획 시 유지된(`keepTaskKeys`) 하위 이슈가 실행 시점에 좌초한다.** 부모의
  `ggjira.plan` property는 재계획마다 새 `version`으로 갱신되는데, 유지된 하위 이슈의
  `ggjira.plan-task.planVersion`은 그대로였다. 실행 직전 버전 비교(`agent/runtime.ts`)가
  둘을 비교해 불일치로 실패 처리한다 — 보드에는 승인된 것처럼 보이는데 실행은 항상 거부된다.
- **재계획 시 superseded 판정이 v4 배포 모드에서 사실상 동작하지 않는다.** 판정 기준이
  `workflow.readyStatus`(레거시 개념) 하나뿐이었는데, 배포 모드의 새 하위 이슈는
  `taskWaitingStatus`에 놓인다. 둘이 다른 값이면 오래된 하위 이슈가 절대 superseded 처리되지
  않는다.
- **`ggjira.plan-task` property가 있지만 스키마와 안 맞는 경우**(수동 편집, 스키마 진화 등)를
  "property가 아예 없음"(수동 생성 이슈, 게이팅 대상 아님)과 구분하지 않았다 — 깨진 데이터가
  조용히 "게이팅 없음"으로 취급돼 승인 확인 없이 실행될 수 있었다.
- **사람의 결정 답변이 인식되지 않을 수 있었다.** 결정 요청 댓글에 기계용 `decisionId:` 줄을
  넣었는데, 사람의 답변에도 같은 줄이 있어야만 매칭에 성공하도록 짜여 있었다 — 안내 문구도
  그 줄을 답변에 그대로 옮겨 적으라고 요구했지만, 실제 사람은 그렇게 하지 않는다.
- **`distribution.enabled` 설정이 Setup에서 로컬 config에만 쓰이고 공유
  `[GGJIRA] Workspace Configuration` 이슈로 전파되지 않았다** — 여러 머신이 각자 상태 이름을
  다르게 입력해 어긋나는, ADR 0015가 기본 3개 상태에 대해 이미 고친 것과 같은 종류의 사고를
  다시 열어 둔 상태였다.
- Setup의 `--check`가 `distribution.executionAgentFieldId`/`executionAgentOptionId`를 Jira에
  실제로 조회하지 않고 무조건 "OK"를 출력했다.

## Decision

**승인 게이트는 부모 이슈의 Jira status(`workflow.executionApprovedStatus`) 하나만 근거로
삼는다.** `ggjira.plan.status`는 PM이 재계획 때 `"review"`로 쓰지만, Implement Agent는 실행
직전에 이 값을 `"approved"`로 되돌려 쓰지 않는다 — 같은 계획의 형제 태스크를 여러 머신이
동시에 집어갈 수 있어 공유 property에 대한 그 쓰기가 경합하기 때문이다. 승인 여부를 판단할
때 property의 `status` 필드는 보지 않는다.

**재계획은 유지되는 하위 이슈의 `ggjira.plan-task.planVersion`도 새 버전으로 재기록한다.**
`applyPlan`이 `plan.keepTaskKeys`를 순회하며 기존 `ggjira.plan-task`를 읽어(없으면 손대지
않음 — 수동 생성 이슈) `planVersion`만 새 값으로 바꿔 다시 쓰고, 그 `taskId`를 부모의
`ggjira.plan.taskIds`에도 포함시킨다.

**"아직 시작 안 함"(superseded 대상) 판정은 config 모드별로 다르게 정의한다.** legacy(v2)는
기존대로 `workflow.readyStatus`와의 동치 비교를 쓴다. v4는 반대로 뒤집어서,
`inProgressStatus`/`reviewStatus`/`completionStatus`/`planningInProgressStatus`/
`planReviewStatus` 중 어디에도 있지 않으면 아직 시작 안 한 것으로 본다 — v4의 "막 생성된
상태"는 `implementationStatus`, `taskWaitingStatus`, 또는 `pm.taskReadyTransitionName`이
이끄는 임의의 상태 등 설정마다 다르므로, 하나의 고정 상태와 비교하는 방식은 성립하지 않는다.

**`ggjira.plan-task` property는 "없음"과 "있지만 깨짐"을 구분해서 알린다.**
`readPlanTaskMetadata`는 property가 아예 없으면(404) `null`을 반환하고(게이팅 없음, 수동
생성 이슈로 취급), 있지만 스키마와 안 맞으면 `PlanMetadataError`를 던진다. 호출부
(`agent/runtime.ts`, `poller.ts`)는 이를 실행 거부/후보 제외로 처리한다 — 깨진 데이터를
조용히 통과시키지 않는다. `poller.ts`는 이 에러를 해당 이슈 하나만 제외하고 나머지 후보의
폴링은 계속한다.

**사람의 결정 답변은 `decisionId` 줄이 없어도 최신 요청에 대한 답으로 받아들인다.** 답변이
이미 "가장 최근 DECISION-REQUEST 이후"로 범위가 좁혀져 있으므로, `decisionId`가 없는 답은
그 요청에 대한 답일 수밖에 없다. 답변에 **다른** `decisionId`가 명시된 경우만 오래된 요청에
대한 응답(같은 범위 안에 우연히 섞여 들어온 답)으로 보고 무시한다. 사람에게 보여주는 안내
문구에서도 `decisionId`를 답변에 포함하라는 요구를 뺐다 — 댓글 본문의 기계용 헤더
(`decisionId:`, `planVersion:`)는 그대로 남지만 사람이 옮겨 적을 의무는 없다.

**`distribution` 설정(상태 8개 + `executionAgentFieldId` + `workspaceId`)은
Workspace Configuration 이슈의 새 "Distribution" 섹션에도 함께 기록한다**
(`profile/types.ts`의 `WorkspaceDistribution`, `profile/workspace.ts`). 단
`executionAgentOptionId`는 예외로 절대 공유 이슈에 쓰지 않는다 — 이 값은 "이 머신이
실행-Agent 필드에서 어떤 옵션인지"를 가리키는 머신별 값이기 때문이다(README
§Human-approved PM distribution: "Each implement machine stores its own option ID"). Join
흐름은 workspace 쪽 Distribution이 켜져 있으면 role이 implement인 새 머신에게만 이 값을
물어보고, 나머지(상태·필드ID·workspaceId)는 그대로 복사한다.

**Setup `--check`는 `executionAgentFieldId`를 Jira의 `GET /rest/api/2/field` 결과와
대조해 실제로 존재하는지 확인한다**(`JiraGateway.listFields()` 신설). `executionAgentOptionId`는
필드 컨텍스트별 옵션 조회 API가 필요해 이번에는 추가하지 않았고, 자동으로 확인되지
않는다는 것을 결과 문구에 명시한다("not verified automatically").

## Consequences

- 승인 게이트가 Jira status 하나뿐이라 다중 머신 경합에 안전하지만, `ggjira.plan.status`
  필드 자체는 이제 "review"에서 갱신되지 않는 장식적 값에 가깝다 — 필요해지면 PM이 부모
  status 변화를 관찰해 반영하는 별도 경로를 고려한다(이번 범위 밖).
- `executionAgentOptionId`의 실제 존재 여부(그 필드에 그 옵션이 실재하는지)는 여전히
  수동 확인이 필요하다 — Jira Cloud의 커스텀 필드 컨텍스트/옵션 API를 넣으면 해결되지만,
  이번 수정 범위에서는 비용 대비 이득이 낮다고 판단해 미룬다.
- 이 ADR이 다루는 automated 테스트는 전부 `FakeJiraGateway` 기반이다(CLAUDE.md §4). 실제
  Jira 프로젝트에서의 재계획→승인→배포 전체 흐름 수동 검증은 `docs/phase3-verification.md`에
  남아 있는 대기 항목을 따른다.
