# 0008: Jira Assignee 기반 Dispatch + Transition을 claim 메커니즘으로

## Context

`GGJira_Phase2_Implementation_Plan.md` §5.2는 "별도 중앙 Scheduler 없이 Jira의 Assignee를
Agent 작업 할당에 사용한다"를, §5.4는 "claim을 Jira workflow transition으로 구현하되 향후
교체 가능한 작은 abstraction(`claimJob`)을 둔다"를 요구한다. MVP는 이미 "JQL로 후보 조회 →
claim transition 성공 = claim 성공"이라는 형태였으므로, 2차는 이를 assignee 조건을 추가해
일반화하고 실패 시 정확히 무엇을 뜻하는지 다듬는 작업이다.

## Decision

- `src/poller/poller.ts`의 `findAssignedJobs`가 기본 JQL을 만든다: `assignee = currentUser()
  AND status = "<workflow.readyStatus>" ORDER BY created ASC`. `config.jira.jql`이 있으면
  그대로 override로 쓴다(마이그레이션/특수 케이스 대비).
- `src/agent/claim.ts`의 `claimJob()`이 claim을 수행한다: (1) 이슈를 재조회해 여전히
  `readyStatus`인지 확인 (2) `workflow.claimTransitionName`으로 transition (3) 시작 댓글.
  이 세 단계 중 (1)에서 상태가 다르거나 (2)가 실패하면 `ClaimLostError`를 던진다.
- `ClaimLostError`는 실패가 아니라 "다른 Agent나 사람이 먼저 처리함"으로 해석한다
  (`architecture.md`의 원래 문구: "claim 실패 = 다른 주체가 이미 처리 → skip"). `job/runner.ts`
  는 이를 `Job.status = "cancelled"`로 기록하고 **Jira에는 아무것도 쓰지 않는다** — 이미
  다른 Agent가 처리 중인 이슈에 댓글/라벨을 남기면 오히려 혼란을 준다.
- (3) 시작 댓글이 실패하는 경우는 별도로 취급한다: transition(진짜 claim)은 이미
  성공했으므로 실행을 중단하지 않고 경고만 로그에 남긴다.

## Consequences

- 여러 머신이 같은 Jira 계정으로 실행돼도(§5.8) 동일 이슈의 이중 실행은 transition 성공
  여부만으로 방지된다. 완전한 분산 락(lease, heartbeat)은 구현하지 않는다(§7 제외 목록).
- claim 경쟁이 반복적으로 같은 이슈에서 발생하면(정상적인 1회성 경쟁이 아니라) 설정 오류
  (`claimTransitionName`이 실제 워크플로우와 안 맞음)일 가능성이 높다 — 이 신호를
  구분하는 방법은 `runbook.md` §8에 정리했다.
- `job.job.ts`의 상태 머신에 `queued → cancelled` 전이를 추가했다(기존에는 `queued →
  claimed | failed`만 허용).
