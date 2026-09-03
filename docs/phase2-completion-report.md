# GGJIRA 2차 구현 완료 보고서

`GGJira_Phase2_Implementation_Plan.md` §12 Step 5 형식. 작업 계획 원본은
`/Users/hodolkim/.claude/plans/delegated-frolicking-cray.md`(세션 로컬)에 있었고, 이 문서는
그 계획의 S1~S7 구현이 끝난 시점의 스냅샷이다.

## Implemented

- **Config v2** (`src/config.ts`): `agent`(identity/role/machine), `workflow`(claim/done/
  needs-decision/planned 전이 이름 등), `workspace`, `provider`(claude-code/codex),
  `pm`(implementAssignee 등) 스키마. `agent.role === "pm"`이면 pm 전용 필드를 zod로 필수화.
  v1 config(구 스키마) 감지 시 `ggjira setup` 안내 에러.
- **Jira Gateway 확장** (`src/jira/`): `getMyself`, `searchUsers`, `getComments`,
  `createIssue`, `assignIssue`. `JiraIssue`에 `assigneeAccountId`/`issueTypeName`/
  `parentKey`/`projectKey` 추가. `FakeJiraGateway`가 최소 JQL(assignee/status/parent/
  project/labels) 매칭을 지원하도록 확장.
- **Agent Runtime** (`src/agent/`): `bootstrapAgent()`가 인증 후 역할별 `JobHandler`를
  선택. `claimJob()`이 재조회 + transition + 시작 댓글로 claim을 수행하고, 경쟁 패배는
  `ClaimLostError` → `Job.status:"cancelled"`(Jira에 기록하지 않음)로 처리.
- **표준 실행 결과** (`src/agent/result.ts`, `src/reporter/reporter.ts`): 모든 역할이
  `ExecutionResult`로 결과를 표현하고, 하나의 포맷(Summary/Changes/Validation/Artifacts
  또는 Failure Reason/Blocking Issue)으로 Jira에 기록.
- **Implement 역할** (`src/implement/`): 기존 MVP 러너 로직을 `JobHandler`로 이전. worktree
  → worker 실행 → 커밋 → (선택) `workspace.validateCommand` 실행 → 결과.
- **PM 역할 / Plan Mode** (`src/pm/`): Plan 스키마+파싱(`plan.ts`), 컨텍스트 구성과 Human
  Decision 파싱(`context.ts`), 프롬프트/결정 요청 렌더링(`prompt.ts`), Jira 적용
  (`apply.ts`: 하위 이슈 생성/할당, superseded 처리), 핸들러(`executor.ts`).
- **Provider 일반화 + Codex** (`src/worker/`): `WorkerRequest`를 provider-무관 필드로
  일반화(`prompt/cwd/timeoutMs/systemPrompt/outputSchema/readOnly`). 공통 프로세스 제어를
  `spawn.ts`로 추출. `CodexCliProvider` 신규 추가(미검증, 아래 Known Limitations 참고).
  `factory.ts`의 `createProvider()`가 config로 구현체 선택.
- **`ggjira setup`** (`src/setup/`): 대화형 위저드(Jira 연결 확인 → identity/role/machine
  → workspace → provider → workflow 이름 → pm 전용 필드) + `.env`(0600)/config 생성,
  기존 파일 `.bak` 보존. `--check`로 비대화형 검증.
- **CLI** (`src/cli.ts`): `setup`, `pm:plan <KEY> [--dry-run]` 추가. `jira:smoke`에 인증
  계정 표시 추가. `worker:run`에 `--schema`/`--read-only` 추가.
- **문서**: `CLAUDE.md`, `docs/architecture.md`, `docs/runbook.md`, `README.md` 갱신.
  ADR 0007~0011 신규.

## Modified Existing Behavior

- claim transition 실패의 의미가 바뀌었다: MVP는 `Job.status:"failed"` +
  `failureStage:"jira"`로 기록했지만, 2차는 `Job.status:"cancelled"`로 기록하고 Jira에
  아무것도 쓰지 않는다(ADR 0008). 이는 `architecture.md`에 원래 있던 "claim 실패 = skip"
  문서 의도에 더 가깝다.
- Jira 댓글 포맷이 한국어 3종 템플릿에서 영어 표준 포맷(Summary/Changes/Validation/
  Artifacts 또는 Failure Reason/Blocking Issue)으로 바뀌었다(CLAUDE.md §4.4 요구사항).
- 기본 JQL이 `project = X AND labels = ggjira AND status = "To Do"`에서 `assignee =
  currentUser() AND status = "<readyStatus>"`로 바뀌었다 — 라벨이 아니라 Jira Assignee로
  대상을 정한다.

## New Configuration

`ggjira.config.example.json` 참고. 핵심 신규 필드: `agent.{identity,role,machine}`,
`workflow.{claimTransitionName,doneTransitionName,needsDecisionTransitionName,
plannedTransitionName}`, `provider.{type,claudeCode,codex}`, `pm.{implementAssignee,
subtaskIssueType,taskReadyTransitionName,maxTasksPerPlan}`. `.env`는 `JIRA_EMAIL`/
`JIRA_API_TOKEN`만(baseUrl은 config로 이동, `JIRA_BASE_URL` env는 선택적 override).

## Jira Configuration Required

실제 운영 전 Jira 사이트에서 사람이 준비해야 하는 것(README "Jira 준비" 절과 동일):

1. 역할별 Jira 계정(예: `ggjira-pm`, `ggjira-implement`)과 각각의 API 토큰.
2. (pm 역할 사용 시) 워크플로우에 `Needs Decision` 상태 + `<진행 중> ↔ Needs Decision ↔
   <준비 상태>` 전이.
3. (pm 역할 사용 시) 프로젝트의 Sub-task 이슈 타입 활성화.

## Migration Steps

기존 v1 `ggjira.config.json`/`.env`를 쓰던 설치는:

1. `ggjira setup` 실행 — Jira URL/이메일/토큰, agent identity/role/machine, workspace,
   provider, workflow 이름을 다시 입력한다(하위 호환 자동 마이그레이션 없음, ADR 0011).
2. `jira:smoke <KEY>`로 인증 계정과 workflow 이름을 확인한다.
3. Jira에서 대상 이슈를 이 Agent의 계정에 assign한다(기존의 라벨 기반 트리거는 더 이상
   동작하지 않는다).

## Tests Performed

- `npm run check`(typecheck + lint + format:check + vitest) — 19개 파일, 142개 테스트
  전부 통과.
- 신규/변경 테스트 하이라이트: `agent-claim.test.ts`(claim 성공/경쟁 패배/댓글 실패 허용),
  `job-runner.test.ts`(claim 경쟁 패배 시 `cancelled`로 변경된 것 포함 implement E2E),
  `pm-plan.test.ts`/`pm-context.test.ts`/`pm-apply.test.ts`/`pm-executor.test.ts`(Plan
  파싱, Human Decision 추출, Jira 적용, pm 역할 E2E 성공/결정요청/파싱실패 3케이스),
  `agent-runtime.test.ts`(역할별 핸들러 선택이 실제로 다른 동작을 만드는지),
  `worker-codex-cli.test.ts`(가짜 codex 스크립트로 성공/실패/timeout/구조화출력),
  `setup-wizard.test.ts`/`setup-validators.test.ts`(전체 위저드 흐름, 백업, 연결 실패 시
  파일 미생성, `--check`).
- **자동 테스트 밖에서 수행하지 못한 것**: 실제 Jira 사이트 연동(`jira:smoke`), 실제
  `claude`/`codex` CLI를 통한 `worker:run`, 실제 다중 머신 E2E(Scenario A/B/C) — 전부
  실제 Jira 프로젝트와 CLI 로그인이 필요해 이번 세션에서는 수행하지 않았다. README/
  runbook의 절차대로 사용자가 직접 실행해 확인해야 한다.

## Known Limitations

- **Codex Provider 미검증**: 개발 환경에 `codex` CLI가 없어 실제 동작을 확인하지 못했다.
  인자 형식과 결과 파싱은 공개 문서 기준 추정이며, ADR 0010에 명시했다. 프로덕션에 쓰기
  전 `worker:run --prompt ... --schema ...`로 반드시 단독 확인해야 한다.
- **Claim 경쟁 판별의 한계**: 재조회 후 transition이 실패하면 항상 "경쟁 패배"로
  해석한다(ADR 0008). `claimTransitionName` 설정 자체가 잘못된 경우도 같은 신호로
  나타나므로, runbook §8의 "반복 여부"로 구분해야 한다 — 완전한 원자적 claim은 아니다.
- **Plan diff 없음**: replan 시 superseded 처리는 "아직 시작 안 한 것만" 기준으로 한다.
  더 정교한 diff(예: 내용이 바뀐 task를 자동 업데이트)는 지원하지 않는다.
- **Multi-Machine 실측 미실행**: 코드는 여러 머신에서 같은/다른 역할로 독립 실행되도록
  작성했지만, 실제 두 대 이상의 머신으로 Scenario C를 검증하지는 않았다.

## Deferred to Phase 3

`GGJira_Phase2_Implementation_Plan.md` §13에 나열된 항목 그대로 유지: Agent Registry,
Capability Matching, Scheduler, Job Lease, Heartbeat, Failover, Agent Affinity, Parallel
Plan Execution, Review Agent, Test Agent, Model Routing, Cost Routing, Remote Agent
Monitoring. 이번 구현 중 새로 발견된 후보는 없다.
