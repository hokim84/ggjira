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
3. **`data/runs/<ISSUE-KEY>/<runId>/summary.md`** — 사람이 읽기 좋은 요약(브랜치, 변경 파일,
   worker 로그 경로 포함).
4. **`data/runs/<ISSUE-KEY>/<runId>/worker.jsonl`** — Worker(Claude Code CLI)가 실제로 보낸
   stream-json 원문. 각 줄이 하나의 이벤트. `result` 타입 줄의 `result`/`is_error` 필드가
   Worker의 최종 결론이다.
5. **`data/state.json`의 `claims`** — 지금 어떤 이슈가 어떤 runId에 의해 "진행 중"으로 표시돼
   있는지. 데몬이 정상이라면 여기 남은 이슈는 실제로 실행 중이거나(최근에 갱신됨), 곧 T7의
   재시작 복구 로직이 정리할 대상이다.
6. **구조화 로그** — `layer` 필드로 계층을 구분한다: `jira`, `poller`, `job`, `worker`,
   `reporter`. `LOG_LEVEL=debug npm run dev -- once`로 더 자세히 볼 수 있다.

## 2. 계층별 실패 신호 (architecture.md §"계층과 실패 추적" 대응)

| 계층 | 무엇이 실패했다는 뜻인가 | 어디서 확인 |
|---|---|---|
| jira | REST 호출 자체가 실패(인증, 404, 5xx) | 로그의 `layer:"jira"`, `JiraApiError`의 status/endpoint |
| poller | JQL 조회 실패 (Jira 5xx가 재시도로도 회복 안 됨) | 로그의 `layer:"poller"`, "failed to fetch candidate issues" — 이 사이클은 빈 결과로 넘어가고 다음 폴링에서 재시도된다 |
| job | claim/worktree 생성 등 GGJIRA 자체 로직 실패 | `job.json`의 `failureStage:"job"` |
| worker | Claude Code CLI 실행 실패/timeout/비정상 종료 | `job.json`의 `failureStage:"worker"`, `worker.jsonl`의 마지막 줄 |
| reporter | Job은 끝났지만 결과를 Jira에 쓰지 못함 | `job.json`의 `reportingFailed:true`, `reportingError` |

## 3. Jira 설정이 의심될 때

- **transition 이름 불일치**: `TransitionNotFoundError`가 뜨면 에러 메시지에 사용 가능한
  transition 이름 목록이 함께 나온다. `ggjira.config.json`의 `inProgressTransitionName`/
  `successTransitionName`을 그 목록에 맞춰 고친다. 배경: [`decisions/0002-jira-rest-api-v2.md`](./decisions/0002-jira-rest-api-v2.md).
- **JQL이 아무것도 안 잡음**: `jira.jql`의 `status = "..."`이 REST API가 보여주는 지역화된
  이름(예: "해야 할 일")으로 되어 있으면 에러 없이 0건만 반환한다. 워크플로우의 실제(대개 영문)
  상태 이름을 쓰거나 `statusCategory = "To Do"`로 바꾼다. 자세한 내용은 같은 ADR의
  "JQL `status =`는 지역화된 표시 이름을 인식하지 못함" 절.
- **claim이 계속 실패함**: `job.json`의 `failureStage:"jira"`이고 에러가 transition 관련이면,
  다른 프로세스나 사람이 먼저 그 이슈를 처리 중일 수 있다(정상 동작 — 원문 설계상 Jira transition
  성공 여부가 곧 claim 성공 여부다).

## 4. Worker가 성공했는데 Jira에 아무 변화가 없을 때

`job.json.status`가 `succeeded`/`failed`인데 Jira에 댓글/전이/라벨이 안 보이면
`job.json.reportingFailed`를 확인한다. `true`면 Job 자체(코드 실행, 커밋)는 끝났고
결과도 `summary.md`에 이미 남아 있지만, 마지막에 Jira에 쓰는 호출만 실패한 것이다
(`reportingError`에 원인). 이 경우 사람이 직접 Jira에 반영하거나, 원인(네트워크, 권한 등)을
해결한 뒤 필요하면 수동으로 댓글/전이를 남긴다. GGJIRA는 이 상태를 자동으로 재시도하지 않는다
(ADR 0006 — 쓰기 호출은 재시도하지 않는 정책).

## 5. 데몬이 죽었다가 재시작됐을 때

`ggjira once`/`ggjira run` 시작 시 `data/state.json`에 남은 claim을 자동으로 검사한다
(`recoverStaleClaims`, T7).

- claim이 가리키는 `job.json`이 아직 종결 상태(`succeeded`/`failed`/`timed_out`/`cancelled`)가
  아니면 → 이전 프로세스가 죽는 바람에 못 끝낸 것으로 보고 `failed`(`failureStage:"job"`)로
  정리하고, 가능하면 Jira에 실패 댓글 + 실패 라벨을 남긴 뒤 claim을 해제한다.
- claim이 가리키는 `job.json`이 이미 종결 상태면 → claim만 해제한다(Jira 쓰기는 이미 끝났거나
  이미 실패로 기록됐을 것이므로 중복 댓글을 만들지 않는다).
- 이렇게 복구된 이슈는 Jira 상태가 이미 "진행 중"으로 전이돼 있으므로(claim 시점에 전이됨),
  같은 폴링 사이클의 JQL(`status = "To Do"`)에는 다시 잡히지 않는다 — **이중 실행이 일어나지
  않는다.** 이 동작은 데몬을 강제 종료(`kill -9`)한 뒤 재시작하는 실측 테스트로 확인했다.

## 6. 워크트리가 쌓일 때

`data/worktrees/`는 실행마다 새로 생기고 자동으로 지워지지 않는다(성공/실패 여부와 무관하게
결과를 나중에 검사할 수 있도록 유지하는 설계, [`decisions/0004-file-based-persistence.md`](./decisions/0004-file-based-persistence.md)).
오래된 것을 정리하려면:

```bash
npm run dev -- worktrees:prune                    # 7일 이상 된 것 정리 (기본값)
npm run dev -- worktrees:prune --olderThanDays 3   # 임계값 직접 지정
```

`worktrees:prune`는 워크트리 디렉터리만 지운다. `ggjira/<KEY>-<runId>` 브랜치 자체는 지우지
않는다 — 성공한 실행의 브랜치는 사람이 검토/머지할 수 있는 실제 산출물이므로, 자동으로 지워서
실수로 작업을 잃는 일이 없도록 한다. 더 이상 필요 없는 브랜치는 `git branch -D <branch>`로
직접 지운다.

## 7. 자주 하는 실수

- `ggjira.config.json`을 안 만들고 실행 → `ConfigError`. `cp ggjira.config.example.json ggjira.config.json` 먼저.
- `.env`에 Jira 자격증명을 안 채움 → `jira:smoke`/`once`가 즉시 `ConfigError`로 실패.
- 실제 Jira 프로젝트에 연결하기 전에 `jira:smoke <KEY>`를 먼저 실행해 transition 이름과 JQL이
  실제로 원하는 이슈를 잡는지 확인하지 않음 — README §"주의"/"더 주의" 참고.
