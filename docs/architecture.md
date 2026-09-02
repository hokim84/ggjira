# 아키텍처

## MVP 흐름

```
Human (Jira에서 이슈 생성 + 트리거 라벨/상태 지정)
  → Jira Cloud
  → [Poller] JQL 주기 조회 (예: project = X AND labels = ggjira AND status = "To Do")
  → [Job] 생성(queued) → claim: Jira transition "In Progress" + 댓글 "GGJIRA 시작"
     (claim 실패 = 다른 주체가 이미 처리 → skip)
  → [WorkerProvider: ClaudeCodeCli] git worktree 생성 → claude -p 실행
     → stream-json 이벤트 수집 → timeout/kill
  → [Reporter] 결과 요약 + 브랜치명 + 변경 파일 + 실행 로그 위치를 Jira 댓글로 기록,
     성공 시 transition(설정값), 실패 시 라벨 `ggjira-failed` + 댓글
  → runs/ 디렉터리에 전체 기록 저장
```

## Webhook이 아닌 Polling을 쓰는 이유

원래 합의된 기본 구조는 `Jira → Webhook → GGJIRA`였다. 개발 머신이 외부에서 접근 불가능해
MVP는 `Jira → JQL Polling → GGJIRA`로 시작한다. 자세한 배경은
[`decisions/0001-polling-over-webhook.md`](./decisions/0001-polling-over-webhook.md) 참고.

수신 경로는 `IssueSource`(핵심: 폴링해서 후보 이슈를 반환하는 함수) 하나의 경계로만 분리되어
있어서, Post-MVP에 Webhook 수신 서버를 추가해도 Job 이후 흐름은 바뀌지 않는다.

## 계층과 실패 추적

| 계층 | 책임 | 실패 신호 |
|---|---|---|
| jira | REST 호출, 인증, 에러 매핑 | `JiraApiError`(status, endpoint) |
| poller | JQL 조회 → 후보 이슈 → Job 큐 | 로그 `poll.error` |
| job | 상태 머신, claim, 재시작 복구, 디스크 기록 | `job.json.status` + `failureStage` 필드 |
| worker | 프로세스 spawn, 이벤트 스트림, timeout/kill, worktree | `WorkerResult.exitReason`(completed/timeout/crashed/nonzero) |
| reporter | 결과 → Jira 댓글/transition/라벨 | `reporter.error` (Worker 성공이라도 Jira 기록 실패를 별도 상태로) |

각 계층은 `src/<layer>/` 디렉터리와 로그의 `layer` 필드로 1:1 대응한다 (`CLAUDE.md` 참고).

## Job 상태 머신

```
queued → claimed → running → succeeded
                          → failed
                          → timed_out
                          → cancelled
```

claim은 Jira transition이 성공한 주체만 진행권을 갖는 방식으로 구현한다 (동시성 절 참고).

## 동시성 (MVP)

- `maxConcurrentJobs = 1`. 큐는 메모리 배열.
- 재시작 시 `data/state.json`과 Jira 상태로 복구한다.
- 이중 처리 방지:
  1. claim 시 Jira transition이 성공한 주체만 진행
  2. 로컬 `data/state.json`에 `issueKey → runId` 기록
  3. JQL 자체가 "To Do"만 조회하므로 In Progress로 넘어간 이슈는 재조회되지 않음

## Provider 경계

`WorkerProvider` 인터페이스 하나에 `ClaudeCodeCliProvider`(실제 구현)와 `FakeWorkerProvider`(테스트용)를
둔다. 향후 다른 CLI 기반 Worker(예: Codex CLI)를 추가할 때 이 경계만 교체하면 된다.
자세한 배경은 [`decisions/0003-worker-provider-boundary.md`](./decisions/0003-worker-provider-boundary.md).
Worker 실행 방식을 실제로 검증한 스파이크 결과는
[`decisions/0005-worker-cli-spike-findings.md`](./decisions/0005-worker-cli-spike-findings.md) 참고.

## Persistence

파일 기반. `data/runs/<ISSUE-KEY>/<runId>/{job.json, worker.jsonl, summary.md}`와
`data/state.json`(claim 기록). 배경은
[`decisions/0004-file-based-persistence.md`](./decisions/0004-file-based-persistence.md).
