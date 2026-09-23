# 0021. Router 4단계(PM·보고·복구) 구현 판단

## Context

`docs/router-service-implementation-plan.md`의 4단계(PM context 분리와 계획 적용, Jira 반영
저널, 결과 재전송, 불명확한 작업 복구)를 구현하면서 계획 §2·§3만으로 정해지지 않는 지점이
생겼다. Jira에 보이는 동작 두 가지(실패 시 상태, 결정 요청 상태 미설정 시 동작)는 사용자와
확정했고, 나머지는 구현 판단이다. [`0019`](./0019-router-stage2-decisions.md)의 "Router 자신의
전이가 승인 철회 감지를 오작동시킨다"는 Consequence도 여기서 해소한다.
[`0020`](./0020-router-stage3-worker-protocol.md)을 구체화하며, 7번 결정(planning 실행 보류)과
Consequences의 "`recovery_required` 해제 경로 없음"·"결과 수신이 Jira 반영 작업을 만들지
않음"을 대체한다.

## Decision

1. **실행 실패·타임아웃은 이슈를 `inProgressStatus`에 둔다(사용자 확정).** 실패 댓글과
   `reporting.failureLabel`(기본 `ggjira-failed`) 라벨만 남긴다. v4 reporter와 같은 의미다.
   재실행은 사람이 요청 상태로 다시 옮기는 것(새 승인)이다. 이때 닫히지 않은 `failed`/
   `timed_out` job은 `cancelled`로 닫고 현재 Jira 상태로 새 job을 판단한다(job 상태 머신에
   `failed|timed_out → cancelled` 추가). 이후 성공하면 실패 라벨을 제거한다.

2. **`needsDecisionStatus`가 없으면 결정 요청은 `reviewStatus`로 옮긴다(사용자 확정).** 결정
   요청 댓글 형식은 v4와 같다(`src/pm/decision-render.ts`). 사람은 `Decision: <id>`로 답하고
   `planningStatus`로 되돌린다. 다음 planning job의 envelope에 그 답(`humanDecision`)이 들어간다.

3. **Router의 Jira 쓰기는 모두 `report_steps` 저널을 거친다.** migration 3은 쓰이지 않던
   `jira_writes`를 버리고 `report_steps`를 만든다. SQLite는 CHECK 제약을 바꿀 수 없어서다.
   저널은 배치로 묶는다.
   - `start:<attemptId>` — 실행 허가 트랜잭션 안에서 만든다. 승인 상태에서 `inProgressStatus`로
     전이한다(§2 "실행 직전 ... 진행 상태로 전이").
   - `<resultId>` — 결과를 저장하는 트랜잭션 안에서 만든다(§3).
   - `recovered:<attemptId>` — 중단 확인 후 "적용된 것 없음" 댓글.

   Jira 호출은 트랜잭션 밖의 `processReportJournal`(`src/router/report-processor.ts`)이 한다.
   한 job의 단계는 삽입 순서대로 실행한다. 막힌 단계(`failed`/`recovery_required`)는 그 배치의
   나머지만 막고, 뒤 배치는 막지 않는다. 시작 전이가 실패해도 결과 보고는 진행된다.

4. **모든 단계는 쓰기 전에 Jira를 다시 읽는다.**
   - 댓글과 생성하는 하위 이슈에는 단계 id 마커(`[GGJIRA:REPORT:<batch>:<seq>]`)를 넣고, 쓰기
     전에 찾는다.
   - 전이는 현재 상태가 `from` 중 하나이고 승인 id가 job의 것과 같을 때만 한다. 아니면
     `skipped`로 둔다. 사람이 바꾼 상태를 덮어쓰지 않는다.
   - 라벨·설명·issue property는 값 설정이라 반복해도 같다.

   쓰기 결과가 불명확하면(네트워크 오류·5xx) 단계를 `uncertain`으로 두고 다음 패스에서 재조회로
   확정한다. 하위 이슈 생성만은 Jira 검색이 즉시 반영되지 않을 수 있어 재조회로 확정할 수 없다.
   그래서 마커를 못 찾으면 `recovery_required`로 보류하고 다시 보내지 않는다. 명확한 거부(4xx,
   도달 불가 상태)는 `failed`다. 429는 쓰지 않은 것이 확실하므로 그대로 두고 나중에 다시 한다.
   생성 마커는 설명 **맨 앞**에 둔다. 뒤에 두면 `parseSections`가 마지막 절(Required
   Capabilities)의 항목으로 읽어 하위 작업이 "알 수 없는 capability"로 보류된다.

5. **계획 적용은 Router가 하고, 워커는 계획만 반환한다.** 워커는 envelope의 이슈 스냅샷과
   `planningContext`(댓글·기존 하위 이슈·결정 답변)로 PM 프롬프트를 만든다. 실행은 읽기 전용이고
   가능하면 임시 worktree에서 한다(`src/worker-runtime/planning.ts`). Router는 결과 저장 시
   계획을 검증한다(작업 수 `planning.maxTasksPerPlan`, taskId 유일성, 의존성 그래프). 적용할 수
   없는 계획은 일부만 적용하지 않고 실패로 보고한다. 적용 단계는 다음 순서다.
   1. 부모 설명의 계획 블록
   2. 하위 이슈 생성. 하위 이슈 Assignee는 부모의 인간 책임자다.
   3. `ggjira.plan-task` 기록과 의존성 키 치환
   4. 유지 작업 재기록
   5. 부모 `ggjira.plan`
   6. 시작 전 기존 하위 이슈 superseded 처리
   7. 요약 댓글 → 실패 라벨 제거 → `reviewStatus`

   계획 버전은 `plan-<attemptId>`이고, 설정은 `planning.subtaskIssueType`을 쓴다.
   `assigneeAgentId`, Agent Profile 요청 필드는 무시한다.

6. **하위 작업은 부모의 현재 계획 버전일 때만 승인된 것으로 본다.** v4 runtime에 있던 검사를
   `readIssueApproval`로 옮겼다. 버전이 다르거나 손상된 메타데이터는 `PlanMetadataError`로 fail
   closed한다. 새 배정을 막고, 이미 열린 job도 취소한다.

7. **승인 재확인은 "후보 목록에 없음"이 아니라 Jira 재조회로 한다(ADR 0019 Consequence 해소).**
   Router가 이슈를 `inProgressStatus`로 옮기므로 후보 스캔에서 빠진 것을 철회로 볼 수 없다.
   `checkJobAgainstJira`는 이슈를 다시 읽어 다음을 확인한다.
   - 상태가 승인 상태나 `inProgressStatus`인지
   - 인간 Assignee가 있는지
   - 승인 id와 입력 hash가 같은지

   댓글은 입력 hash에 들어가지 않으므로 Router의 보고 댓글은 철회로 보지 않는다. Jira 조회
   실패는 철회로 보지 않는다. `verifyActiveJobs`는 leased/running job에 대해 이 확인을 한다.
   5초 주기 호출은 5단계 `router serve`가 붙인다.

8. **`recovery_required` 해제.** 워커 확인과 관리자 확인 두 경로가 있다.
   - 워커 확인: 현재 attempt의 결과가 늦게 도착하면 워커의 중단 확인으로 본다. 결과는 적용하지
     않고(`applied = 0`) job을 `cancelled`로 닫는다. 감사 기록 `recovery.stop_confirmed`와
     `recovered:` 댓글을 남긴다.
   - 관리자 확인: `resolveRecoveryJob`(`src/router/recovery.ts`)이 같은 일을 관리자 이름으로
     한다.

   `retryJob`은 `failed`/`timed_out`/`recovery_required` job을 새 attempt로 다시 대기시킨다.
   Jira에서 승인을 다시 확인하고, 철회·재승인·입력 변경이면 거부한다. 그런 변경은 reconcile이
   새 요청으로 처리한다. `retryReportBatch`는 막힌 보고 단계만 다시 대기시키고 워커는 다시
   실행하지 않는다. 세 동작 모두 `audit_log`에 남는다. HTTP·CLI 진입점은 5단계에서 붙인다.

## Consequences

- Jira 반영은 `processReportJournal`을 누가 주기적으로 부를 때만 진행된다. 5단계 `router
  serve`에 타이머를 붙이기 전까지는 코드(테스트 하네스)로만 돈다. 실행 허가와 실제
  `inProgressStatus` 전이 사이에 지연이 있을 수 있다. 허가 전 승인 확인은 SQLite의 최신 승인
  스냅샷으로 한다.
- 하위 이슈 생성이 불명확하면 관리자가 Jira를 확인한 뒤 `reports retry`를 해야 한다. 자동
  재전송이 없으니 중복 생성은 없지만, 계획 적용이 그 지점에서 멈춘다.
- 재계획에서 유지하는 작업은 계획 버전이 새로 기록되므로, 그 작업이 실행 중이면 입력 hash가
  바뀌어 취소 요청이 간다. v4에서도 같은 재기록을 했고, 실행 중 작업을 유지 목록에 넣는 경우는
  드물다고 보고 그대로 둔다.
- planning job의 `humanDecision`·기존 하위 이슈는 reconcile 시점의 스냅샷이다. 실행 중에 달린
  댓글은 다음 계획 요청에서 반영된다.
