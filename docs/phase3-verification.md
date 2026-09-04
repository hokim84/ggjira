# GGJIRA 3차 구현(Agent Profile) 검증 체크리스트

`advanced_plan.md` 기반 3차 구현(S1~S7)의 코드·자동 테스트는 끝났다(`npm run check`,
238개 테스트, 전부 `FakeJiraGateway`/scripted ask만 사용 — CLAUDE.md §완료의 정의 4에
따라 실제 Jira 호출은 자동 테스트에 넣지 않는다). 이 문서는 실제 Jira 사이트/CLI로만
확인할 수 있는 항목의 체크리스트다(계획 §S8). **이 세션은 실제 Jira 접근 권한이 없어
아래 항목을 하나도 실행하지 못했다** — 사용자가 직접 실행하고 결과를 이 파일에
채워 넣어야 한다.

## Implemented (코드·자동 테스트 완료)

- `src/profile/`: Agent Profile / Workspace Configuration 파싱·렌더·검색·생성·claim.
- `src/jira/`: `listProjects`, `getProject`, `getIssueProperty`, `setIssueProperty`,
  `createIssue`의 `labels`. `request()`가 200/201 빈 body도 처리하도록 수정.
- `src/agent/context.ts`, `src/agent/prompt.ts`: Agent Profile 로드·검증, Prompt 레이어 합성.
- `src/setup/flows.ts`: Create GGJira Workspace / Join as Agent / Manual setup(legacy).
- `src/pm/`: `Plan.agentProfiles`/`disableAgentIds`/task별 `assigneeAgentId`, 로스터 기반
  라우팅.
- `src/cli.ts` + `src/profile/commands.ts`: `agent:list`/`agent:create`/`agent:disable`.
- ADR 0012(Agent Profile을 Jira Issue로), 0013(Prompt 레이어 합성).

## 체크리스트

각 항목을 실제로 실행한 뒤 결과(성공/실패, 이슈 키, 스크린샷 경로 등)를 이 파일에
직접 채워 넣는다. 순서대로 진행하되, 실패한 단계에서 멈추고 원인을 기록한다.

### 1. Create GGJira Workspace

- [ ] 빈 디렉터리(또는 `ggjira.config.json` 삭제) → `npm run dev` → Setup 메뉴 표시 →
      `1` 선택 → 실제 Jira 프로젝트(예: `KAN`)에 `[GGJIRA] Workspace Configuration`,
      `[AGENT] pm-01` 이슈가 생성되는지 확인.
- [ ] `[AGENT] pm-01` 이슈에 `ggjira.registration` issue property가 실제로 저장됐는지
      확인 — Jira REST를 직접 호출하거나(`curl -u email:token
      https://<site>/rest/api/2/issue/<KEY>/properties/ggjira.registration`),
      `ggjira setup --check`의 `profile:` 줄이 "registered to this machine"인지로 확인.
- [ ] `[AGENT]`/`[GGJIRA]` 이슈가 담당자 미지정 상태인지, 이후 `once`를 돌려도 작업으로
      폴링되지 않는지 확인(§2.11 오폴링 방지).

### 2. 멱등성

- [ ] 같은 명령을 다시 실행 → `[GGJIRA]`/`[AGENT]` 이슈가 중복 생성되지 않는지, 등록
      코멘트가 다시 달리지 않는지 확인.

### 3. Human이 Agent Profile을 수정

- [ ] Jira UI에서 `pm-01` 프로필 description의 Human Instructions를 수정.
- [ ] `pm:plan <REQUIREMENT-KEY> --dry-run` 또는 실제 `once` 실행 중 worker에 전달되는
      systemPrompt에 수정한 내용이 반영되는지 확인(재시작 없이). 필요하면
      `worker.jsonl` 또는 임시로 프롬프트를 로그에 남겨 확인한다.

### 4. Join as Agent + Takeover

- [ ] 두 번째 clone(다른 디렉터리 = 다른 `machineId`)에서 `npm run dev` → `2` Join as
      Agent → implement Agent Profile 선택 → 등록 성공 확인.
- [ ] 첫 번째 clone에서 같은 프로필로 다시 Join 시도 → "already registered to another
      machine" 거부 메시지 확인 → takeover 확인(`y`) → 성공 확인.
- [ ] takeover 이후 두 번째 clone에서 `ggjira run`을 실행하면 `verifyRegistration`이
      등록 불일치를 감지해 즉시 에러로 멈추는지 확인.

### 5. Disabled

- [ ] Jira UI에서 한 Agent Profile 이슈에 `ggjira-disabled` 라벨 추가.
- [ ] 그 프로필로 등록된 머신에서 `once` 실행 → 로그에 `poll.skipped_disabled`가 남고
      실제 이슈 조회가 일어나지 않는지 확인.
- [ ] 라벨을 떼고 재시작 없이 다음 사이클부터 다시 폴링되는지 확인.

### 6. PM이 Agent Profile 생성

- [ ] 요구사항 이슈에 "Unity 구현 에이전트 하나 추가해줘" 같은 텍스트를 남기고 PM
      Agent 계정에 assign.
- [ ] PM `once` 실행 → `agentProfiles`를 포함한 Plan이 나오고 새 `[AGENT]` 이슈가
      생성되는지, 결과 댓글에 `agent profile created: <KEY>`가 남는지 확인.

### 7. 레거시 호환

- [ ] 기존 v2 `ggjira.config.json`(profile 필드 없음)을 쓰는 머신에서 `once`를 실행해
      이전과 동일하게 동작하는지(claim 전이 + 댓글 + 완료 전이) 확인.

### 8. Jira API 사실 재확인 (ADR 0012에 기록된 가정)

- [ ] `PUT /rest/api/2/issue/{key}/properties/{propertyKey}`의 실제 상태 코드(200 갱신 /
      201 생성)와 빈 body를 `jira:smoke` 또는 임시 로그로 확인.
- [ ] Jira Cloud UI(ADF 에디터)로 description을 수정한 뒤 GET한 값이 정말
      `src/profile/description.ts`가 파싱 가능한 wiki-markup 형태인지(`h2.`, `* `,
      `Key: value`) 확인 — 특히 한글 등 비-라틴 문자, 표/코드 블록처럼 예상 밖 서식을
      사람이 넣었을 때.

## 결과 기록

각 체크리스트 항목 실행 후 아래에 날짜/결과/이슈 키를 추가한다.

```
(비어 있음 — 사용자가 채워 넣는다)
```
