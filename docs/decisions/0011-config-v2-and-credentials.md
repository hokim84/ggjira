# 0011: Config v2 스키마 + credentials 분리

## Context

MVP의 `ggjira.config.json`은 `jira.jql`, `targetRepo`, `worker` 필드를 가진 단일 프로세스
전제의 스키마였다. 2차는 Agent Identity/Role/Machine, 여러 Jira workflow 이름(claim/done/
needs-decision/planned), 여러 Provider(claude-code/codex), pm 전용 설정(assignee, subtask
타입 등)을 표현해야 한다(`GGJira_Phase2_Implementation_Plan.md` §5.1, §6). §6은 또한
"Jira 인증 정보가 일반 설정이나 로그에 노출되지 않도록" 인증과 일반 설정을 분리할 것을
요구한다.

## Decision

- `src/config.ts`를 새 스키마(v2)로 전면 교체했다: `jira`(baseUrl만, 자격증명 제외),
  `agent`(identity/role/machine), `workflow`(readyStatus/claimTransitionName/
  doneTransitionName/failureLabel/needsDecisionTransitionName/plannedTransitionName),
  `workspace`(path/baseBranch/validateCommand), `provider`(type/command/model/timeoutMs +
  provider별 옵션), `pm`(implementAssignee/subtaskIssueType/taskReadyTransitionName/
  maxTasksPerPlan), `polling`. `agent.role === "pm"`이면 `pm.implementAssignee`와
  `workflow.needsDecisionTransitionName`을 zod `superRefine`으로 필수화한다.
- **하위 호환은 만들지 않는다.** `agent` 키가 없는 config(v1)를 읽으면 `ConfigError`로
  `ggjira setup` 실행을 안내한다(`isLikelyV1Config`) — 자동 마이그레이션 코드를 별도로
  두지 않고, 사용자와 사전에 이 방향으로 합의했다.
- `.env`는 `JIRA_EMAIL`/`JIRA_API_TOKEN`만 담는다. `JIRA_BASE_URL`은 config의
  `jira.baseUrl`을 override하는 선택적 환경변수로만 남긴다(머신마다 다른 Jira 사이트를
  가리켜야 하는 드문 경우 대비). `loadJiraSecretsFromEnv()`와 `resolveJiraSecrets(config,
  envSecrets)`로 "일반 설정"과 "비밀"의 병합 지점을 명시적으로 분리했다.
- `ggjira setup`(ADR 없음, `src/setup/`)이 `.env`를 0600 권한으로 쓰고, 기존 파일은
  덮어쓰지 않고 `.bak`으로 보존한다.

## Consequences

- config 파일(`ggjira.config.json`)은 커밋해도 안전한 형태를 유지한다(어차피
  `.gitignore`에 포함) — 비밀은 항상 `.env`에만 있다.
- v1→v2 자동 마이그레이션이 없으므로, 기존 MVP 사용자는 `ggjira setup`을 다시 실행해야
  한다. 인증 정보(`JIRA_EMAIL`/`JIRA_API_TOKEN`)는 재입력이 필요하다 — 마이그레이션
  스크립트를 만들 만큼 사용자가 많지 않다고 판단했다(필요해지면 재검토).
- pm 역할 전용 필드를 부팅 시점에 즉시 검증하므로, 설정 실수로 인한 실패가 폴링 도중이
  아니라 시작 시점에 드러난다.
