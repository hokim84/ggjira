# Runbook

GGJIRA가 실패하거나 예상과 다르게 동작할 때, 어디를 보고 무엇을 하면 되는지 정리한다.
아키텍처와 계층 구분은 [`architecture.md`](./architecture.md), 설계 결정 배경은
[`decisions/`](./decisions/)를 참고한다.

## 1. 어디를 먼저 볼 것인가

문제를 발견하면 이 순서로 확인한다.

1. **`ggjira status`** — 현재 claim 상태와 각 이슈의 최근 실행(runId, status, 요약)을 보여준다.
   `[reporting to Jira failed]` 표시가 있으면 Job 자체는 끝났지만 Jira 쓰기가 실패한 것이다(§4).
2. **`data/runs/<ISSUE-KEY>/<runId>/job.json`** — 그 실행의 최종 상태를 그대로 담고 있다.
   `status`, `failureStage`, `error`, `reportingFailed`/`reportingError` 필드를 먼저 본다.
   `status: "cancelled"`는 실패가 아니라 다른 Agent/사람이 먼저 claim했다는 뜻이다(§8).
3. **`data/runs/<ISSUE-KEY>/<runId>/summary.md`** — 사람이 읽기 좋은 요약(브랜치, 변경 파일,
   검증 결과, worker 로그 경로 포함).
4. **`data/runs/<ISSUE-KEY>/<runId>/worker.jsonl`** — Worker(Claude Code CLI 또는 Codex CLI)가
   실제로 보낸 이벤트 원문. 각 줄이 하나의 이벤트.
5. **`data/state.json`의 `claims`** — 지금 어떤 이슈가 어떤 runId에 의해 "진행 중"으로 표시돼
   있는지. 데몬이 정상이라면 여기 남은 이슈는 실제로 실행 중이거나(최근에 갱신됨), 곧
   재시작 복구 로직이 정리할 대상이다.
6. **구조화 로그** — `layer` 필드로 계층을 구분한다: `jira`, `poller`, `agent`, `job`,
   `implement`, `pm`, `reporter`, `setup`. `LOG_LEVEL=debug npm run dev -- once`로 더 자세히
   볼 수 있다. `layer:"job"`에서 `"claim lost to another agent"`가 자주 반복되면 §8 참고.

## 2. 계층별 실패 신호 (architecture.md §"계층과 실패 추적" 대응)

| 계층 | 무엇이 실패했다는 뜻인가 | 어디서 확인 |
|---|---|---|
| jira | REST 호출 자체가 실패(인증, 404, 5xx) | 로그의 `layer:"jira"`, `JiraApiError`의 status/endpoint |
| poller | assignee+status JQL 조회 실패 (Jira 5xx가 재시도로도 회복 안 됨) | 로그의 `layer:"poller"`, "failed to fetch assigned issues" — 이 사이클은 빈 결과로 넘어가고 다음 폴링에서 재시도된다 |
| agent | 인증(`getMyself`) 실패, claim 관련 처리 | 부팅 시 즉시 에러 종료(인증) / `job.json`의 `failureStage:"jira"`(claim이 진짜 실패한 경우만 — 단순 경쟁 패배는 `status:"cancelled"`, §8) |
| job | GGJIRA 자체 로직 실패(핸들러가 예외를 던짐 등) | `job.json`의 `failureStage:"job"` 또는 `"worker"` |
| implement | worktree 생성 실패, Worker 실행 실패/timeout/비정상 종료, `workspace.validateCommand` 실패 | `job.json`의 `failureStage:"worker"`, `worker.jsonl`의 마지막 줄, `summary.md`의 Validation 절 |
| pm | Plan provider 실행 실패, plan JSON 파싱 실패, Jira에 하위 티켓 적용 실패(`pm.implementAssignee` 미매칭 등) | `job.json`의 `error`(`"failed to parse plan output"` / `"Could not apply the plan to Jira"`) |
| reporter | Job은 끝났지만 결과를 Jira에 쓰지 못함 | `job.json`의 `reportingFailed:true`, `reportingError` |
| setup | Jira 연결/워크스페이스/Provider 검증 실패 | `ggjira setup` 또는 `ggjira setup --check` 출력 |

## 3. Jira 설정이 의심될 때

- **transition 이름 불일치**: `TransitionNotFoundError`가 뜨면 에러 메시지에 사용 가능한
  transition 이름 목록이 함께 나온다. `ggjira.config.json`의 `workflow.claimTransitionName`/
  `doneTransitionName`/`needsDecisionTransitionName`(pm)/`pm.taskReadyTransitionName`을 그
  목록에 맞춰 고친다(`ggjira setup`을 다시 실행해도 된다). 배경:
  [`decisions/0002-jira-rest-api-v2.md`](./decisions/0002-jira-rest-api-v2.md).
- **아무 이슈도 안 잡힘**: 기본 JQL은 `assignee = currentUser() AND status =
  "<workflow.readyStatus>"`다. 두 가지를 확인한다.
  - 이슈가 실제로 이 Agent의 Jira 계정에 assign되어 있는지 — `jira:smoke <KEY>`로 인증
    계정과 이슈의 assignee를 비교해본다.
  - **`workflow.readyStatus`가 Jira 보드에 보이는 "컬럼 이름"이 아니라, 그 이슈의 실제
    status 이름과 일치하는지.** Company-managed(클래식) 프로젝트의 칸반 보드는 컬럼 표시
    이름을 실제 워크플로우 status 이름과 독립적으로 커스터마이징할 수 있어서, 보드에는
    "To Do"라고 보여도 이슈 내부의 실제 status는 다른 이름(예: 로캘라이즈된 이름)일 수
    있다. `jira:smoke <KEY>` 출력의 `status:` 값(REST API가 그대로 돌려주는 값)이
    진짜 기준이다 — 보드가 아니라 이 값을 `workflow.readyStatus`에 그대로
    복사해 넣는다(손으로 다시 입력하면 한글 등 비-라틴 문자에서 미묘한 차이가 생기기
    쉽다).
  - 값을 정확히 맞춘 것 같은데도 계속 안 잡히면 Unicode 정규화 문제일 수 있었지만, 지금은
    `workflow.*`/`pm.subtaskIssueType`/`pm.taskReadyTransitionName`을 config 로딩 시점에
    자동으로 NFC로 정규화하므로(`config.ts`) 더는 원인이 아니다.
  - `jira.jql`을 config에 직접 지정하면 이 기본 JQL을 override할 수 있다.
- **claim이 계속 실패함(진짜 실패, `failureStage:"jira"`)**: 재조회/transition 과정에서
  claim이 안 되는 것 자체는 정상 동작(§8)이지만, `job.json`에 `status:"failed"` +
  `failureStage:"jira"`로 남았다면 transition 자체가 아니라 다른 이유(권한, 네트워크)로
  claim 시도가 예외를 던진 것이다 — 에러 메시지를 확인한다.

## 4. Worker가 성공했는데 Jira에 아무 변화가 없을 때

`job.json.status`가 `succeeded`/`failed`인데 Jira에 댓글/전이/라벨이 안 보이면
`job.json.reportingFailed`를 확인한다. `true`면 Job 자체(코드 실행, 커밋, 또는 pm의 하위
티켓 생성)는 끝났고 결과도 `summary.md`에 이미 남아 있지만, 마지막에 Jira에 쓰는 호출만
실패한 것이다(`reportingError`에 원인). 이 경우 사람이 직접 Jira에 반영하거나, 원인(네트워크,
권한 등)을 해결한 뒤 필요하면 수동으로 댓글/전이를 남긴다. GGJIRA는 이 상태를 자동으로
재시도하지 않는다(ADR 0006 — 쓰기 호출은 재시도하지 않는 정책).

## 5. 데몬이 죽었다가 재시작됐을 때

`ggjira once`/`ggjira run` 시작 시 `data/state.json`에 남은 claim을 자동으로 검사한다
(`recoverStaleClaims`).

- claim이 가리키는 `job.json`이 아직 종결 상태(`succeeded`/`failed`/`timed_out`/`cancelled`)
  가 아니면 → 이전 프로세스가 죽는 바람에 못 끝낸 것으로 보고 `failed`(`failureStage:"job"`)로
  정리하고, 가능하면 Jira에 표준 실패 댓글 + 실패 라벨을 남긴 뒤 claim을 해제한다.
- claim이 가리키는 `job.json`이 이미 종결 상태면 → claim만 해제한다(Jira 쓰기는 이미 끝났거나
  이미 실패로 기록됐을 것이므로 중복 댓글을 만들지 않는다).
- 이렇게 복구된 이슈는 Jira 상태가 이미 "진행 중"으로 전이돼 있으므로(claim 시점에 전이됨),
  같은 폴링 사이클의 JQL(`status = "<readyStatus>"`)에는 다시 잡히지 않는다 — **이중 실행이
  일어나지 않는다.**

## 6. 워크트리가 쌓일 때

`data/worktrees/`는 실행마다 새로 생기고 자동으로 지워지지 않는다(성공/실패 여부와 무관하게
결과를 나중에 검사할 수 있도록 유지하는 설계, [`decisions/0004-file-based-persistence.md`](./decisions/0004-file-based-persistence.md)).
`pm` 역할도 계획 수립을 위해 (읽기 전용) worktree를 만든다 — 워크트리 생성이 실패해도 pm은
base workspace로 폴백해 계속 진행한다.

오래된 것을 정리하려면:

```bash
npm run dev -- worktrees:prune                    # 7일 이상 된 것 정리 (기본값)
npm run dev -- worktrees:prune --olderThanDays 3   # 임계값 직접 지정
```

`worktrees:prune`는 워크트리 디렉터리만 지운다. `ggjira/<KEY>-<runId>` 브랜치 자체는 지우지
않는다 — 성공한 실행의 브랜치는 사람이 검토/머지할 수 있는 실제 산출물이므로, 자동으로 지워서
실수로 작업을 잃는 일이 없도록 한다. 더 이상 필요 없는 브랜치는 `git branch -D <branch>`로
직접 지운다.

## 7. Plan Mode / Needs Decision에서 멈췄을 때

- **이슈가 `Needs Decision`에서 안 움직임**: PM Agent는 상태가 `workflow.readyStatus`가 아닌
  이슈를 폴링에서 찾지 않으므로, 사람이 결정을 남기기 전까지는 정상적으로 아무 일도 하지
  않는다. Jira 댓글에서 `[GGJIRA:DECISION-REQUEST]`로 시작하는 댓글을 찾아 안내된 형식(
  `Decision: <option id>`)으로 답한 뒤, 이슈 상태를 `workflow.readyStatus`(기본 "To Do")로
  직접 되돌린다 — PM은 상태를 대신 되돌려주지 않는다.
- **Replan 후 이전 하위 이슈가 남아있음**: 아직 시작하지 않은(=`workflow.readyStatus`) 하위
  이슈만 `ggjira-superseded` 라벨이 붙고 할당 해제된다. 이미 진행 중이거나 완료된 하위
  이슈는 자동으로 건드리지 않으므로, 필요하면 사람이 직접 정리한다.
- **plan 파싱 실패**: `job.json.error`가 `"failed to parse plan output"`이면 provider가
  반환한 텍스트가 `pm/plan.ts`의 `PlanSchema`(JSON Schema로 요청한 형태)와 맞지 않은 것이다.
  `worker.jsonl`에서 provider의 원문 출력을 확인한다. Claude Code는 `--json-schema`를 그대로
  따르는 경우가 많지만, Codex는 스키마 강제 플래그가 없어(architecture.md 참고) 프롬프트
  안내만으로 형식이 어긋날 가능성이 더 높다.
- **`pm.implementAssignee`가 안 맞음**: `job.json.error`가 `"No Jira user found matching
  pm.implementAssignee"`면 `ggjira.config.json`의 `pm.implementAssignee` 값(이메일 등)이
  Jira의 사용자 검색(`/rest/api/2/user/search`)으로 정확히 매칭되지 않는 것이다. Jira
  관리자 화면에서 실제 이메일/표시 이름을 확인한다.

## 8. Claim 경쟁 (Multi-Machine)

여러 머신에서 같은 Agent Identity(같은 Jira 계정)로 실행 중이면, 같은 이슈를 동시에 발견할
수 있다. `claimJob`(agent/claim.ts)이 이슈를 재조회한 뒤 Jira transition을 시도하고, 실패
(또는 재조회 결과가 이미 다른 상태)하면 `ClaimLostError`로 처리된다 — 이 경우:

- Job 상태는 `cancelled`로 남고, `data/state.json`의 claim은 즉시 해제된다.
- **Jira에는 아무것도 기록하지 않는다** — 이미 다른 Agent가 처리 중인 이슈에 댓글/라벨을
  남기지 않기 위해서다. 로그에 `layer:"job"`이 남는데, 원인에 따라 메시지가 다르다:
  - `"claim transition ... is not a valid transition from this issue's current status"` —
    Jira가 실제로 "그 이름의 transition이 없다"고 응답한 경우다. 로그의
    `availableTransitions`에 실제 사용 가능한 이름 목록이 함께 찍힌다. **거의 항상**
    `workflow.claimTransitionName`이 실제 워크플로우와 다른(설정 오류) 경우이지 진짜
    경쟁이 아니다 — 이 로그가 뜨면 `jira:smoke <KEY>`를 별도로 실행할 필요 없이 바로
    `availableTransitions` 목록에 있는 이름으로 config를 고친다(`ggjira setup` 재실행,
    이제 기존 값이 기본값으로 채워지므로 이 필드만 새로 입력하면 된다).
  - `"claim lost to another agent"` — 재조회 시 상태가 이미 바뀌어 있었거나, transition은
    유효했지만 그 사이 다른 주체가 먼저 처리해 거부된 경우다. 이게 진짜 경쟁 패배다.
- 위 어느 쪽이든 같은 이슈에 대해 **한 번만** 나오면 정상(경쟁 패배). 첫 번째 메시지가
  **반복적으로** 나오면 설정 오류가 거의 확실하다.

완전한 분산 락은 구현하지 않는다 — Jira transition 성공 여부 자체가 claim 메커니즘이다
(`GGJira_Phase2_Implementation_Plan.md` §5.4).

## 9. 자주 하는 실수

- `.env`/`ggjira.config.json`을 안 만들고 실행 → `ConfigError`. `ggjira setup`을 먼저
  실행한다.
- 옛 버전(v1, `agent` 섹션이 없는) config를 그대로 씀 → `ConfigError`에 "looks like a
  GGJIRA v1 config" 안내가 뜬다. `ggjira setup`으로 마이그레이션한다.
- `role: pm`인데 `pm.implementAssignee` 또는 `workflow.needsDecisionTransitionName`을
  안 채움 → 부팅 시 `ConfigError`로 즉시 실패한다(§3, §7).
- 실제 Jira 프로젝트에 연결하기 전에 `jira:smoke <KEY>`를 먼저 실행해 인증 계정, transition
  이름, JQL이 실제로 원하는 이슈를 잡는지 확인하지 않음 — README §"처음 실행할 때" 참고.
- Codex Provider(`provider.type: "codex"`)를 실제 검증 없이 프로덕션에 씀 — Codex Provider는
  이 저장소에서 실제 `codex` CLI로 검증되지 않았다(architecture.md 참고). 먼저 `worker:run
  --prompt "..." --schema <file>`으로 단독 확인한다.
