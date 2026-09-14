# ADR 0015: 상태 기반 Workflow 설정 (전이 이름을 설정에서 제거)

## Context

Setup은 Jira workflow를 **전이(transition) 이름**으로 받아 저장했다
(`claimTransitionName`, `doneTransitionName`, `needsDecisionTransitionName`).
문제는 세 가지였다.

- **사람은 전이 이름을 모른다.** Jira 보드에서 보이는 건 상태(컬럼)이고, 전이 이름은
  워크플로우 편집기를 열어야 보인다. 둘은 다른 값일 수 있고(같은 이동이 "검토 중"이라는
  상태로 가면서 전이 이름은 "검토 요청"), 프로젝트 언어에 따라 영어 기본값과 전혀 다르다.
- **틀려도 Setup이 알 수 없었다.** Jira REST는 전이를 프로젝트 단위로 노출하지 않는다
  (`GET /issue/{key}/transitions`는 특정 이슈의 현재 상태 기준이다). 그래서 입력값 검증이
  구조적으로 어려웠고, 오류는 한참 뒤 실행 중에야 드러났다. 실제로 KAN-18에서 구현과 커밋이
  모두 끝난 뒤 `doneTransitionName: "IN REVIEW"`가 실제 전이("검토 중")와 달라 상태 전이가
  실패했다 — 결과물은 worktree에 있는데 Jira에는 코멘트만 남아, 사람이 보기엔 "완료라는데
  아무것도 없는" 상태가 됐다.
- **질문이 많았다.** ready/claim/done/needs-decision/planned/task-ready까지 물어보니, 정작
  필요한 건 "AI에 맡길 상태"와 "다 됐으니 사람이 볼 상태" 두 가지뿐인 사용자에게 과했다.

## Decision

- **설정에는 상태만 저장하고, 전이는 런타임에 해석한다.** `transitionIssueToStatus(key,
  targetStatus)`(`src/jira/client.ts`)가 그 이슈의 현재 가능한 전이 중 도착 상태가 목표와
  같은 것을 찾아 실행한다. 이미 그 상태면 no-op이고, 도달할 수 없으면 현재 상태와 도달 가능한
  상태들을 담은 `StatusNotReachableError`를 던진다. 전이 이름은 설정 어디에도 남지 않으므로
  프로젝트의 전이 라벨이 어떤 언어든, 나중에 바뀌든 설정이 틀어지지 않는다.
- **Workflow는 상태 3개다** (`workflow.implementationStatus` / `inProgressStatus` /
  `reviewStatus`):

  ```text
  사람: 이슈를 [AI 작업 요청]으로 이동
    -> agent가 발견해 claim하면서 [진행 중]으로 이동
    -> 구현/커밋이 끝나면 [검토 중]으로 이동
    -> 사람이 검토하고 [완료]로 이동  (GGJIRA는 완료 상태로 전이하지 않는다)
  ```

- **Setup은 이 3개만 묻고, 실제 Jira 상태 목록에서 번호로 고르게 한다**
  (`listStatuses`/`askStatus`/`askWorkflowStatuses`, `src/setup/flows.ts`).
  `listProjectStatuses`로 받은 실제 값이라 존재하지 않는 상태를 저장할 수 없고, 세 값이
  서로 다른지도 검사한다. 이미 workspace가 있으면 현재 3개를 보여주고 "Change these
  statuses? (y/N)"만 물어, 동의할 때 `updateWorkspaceConfig`로 Jira 이슈 description을
  갱신한다. Join 흐름은 workflow를 아예 묻지 않는다(Workspace Configuration에서 읽는다).
- **PM(계획) 설정은 Setup에서 숨긴다.** `planningStatus`/`needsDecisionStatus`는 선택값이고,
  없으면 planning 라우팅 자체가 꺼진다(poller JQL에서도 빠지므로, 존재하지 않는 상태 이름
  때문에 JQL 전체가 거부되는 일이 없다). 계획 기능을 쓰려면 Workspace Configuration 이슈에
  직접 적는다.
- **claim은 다시 상태를 옮긴다.** ADR 0014는 "AI Implementation 자체가 사람의 승인 신호이므로
  claim이 그 상태를 지우면 안 된다"고 보고 구현 작업에서는 전이를 생략했다. 상태가 3개로
  분리된 지금은 `inProgressStatus`로 옮기는 것이 곧 claim이고(멀티 머신 중복 방지, ADR 0008),
  실행 중 "승인 철회" 판정 기준도 request 상태가 아니라 `inProgressStatus`에 그대로 있는지로
  바뀐다(`implement/executor.ts`, `job/runner.ts`).
- **v4 config는 세 상태가 없으면 로딩을 실패시킨다.** 옛 전이 이름만 있는 v4 config는 조용히
  넘어가지 않고 `ggjira setup` 재실행을 안내하는 검증 오류를 낸다. 자동 매핑은 하지 않는다 —
  전이 이름에서 상태를 유추할 수 없고, 잘못 추측하면 애초에 고치려던 그 사고가 반복된다.
  v2/v3(레거시) config는 기존 전이 이름 경로를 그대로 쓴다.

## Consequences

- Setup에서 workflow 관련 질문이 6개에서 **3개**로 줄고, 전부 실제 Jira 값 중에서 번호로
  고르는 형태다. 존재하지 않는 값이나 언어가 다른 값이 저장될 경로가 사라진다.
- 전이가 실패할 수 있는 지점은 남아 있지만(해당 상태로 가는 전이가 워크플로우에 없는 경우),
  오류 메시지가 "전이 이름을 못 찾음"이 아니라 "현재 상태 X에서 Y로 갈 수 없음, 갈 수 있는
  곳은 …"이 되어 사람이 Jira에서 바로 고칠 수 있다.
- 이동 1회당 `getTransitions` 호출이 1회 필요하다(기존 `transitionIssue`도 이미 그랬다).
  실패로 보이는 경우에만 현재 상태 확인용 읽기가 1회 추가된다.
- 기존 v4 설치는 `ggjira setup`을 한 번 재실행해야 한다. 여러 머신이 같은 워크스페이스를
  참조한다면 각 머신이 "Join as Agent"를 다시 실행해야 새 상태를 받는다.
- ADR 0014의 "claim이 구현 이슈의 상태를 옮기지 않는다"는 결정은 이 ADR로 대체된다.
