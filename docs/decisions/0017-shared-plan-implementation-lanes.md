# ADR 0017: 계획/구현 lane의 상태 공유, 부모 승인 상태 제거

## Context

ADR 0016이 도입한 human-approved 배포는 `distribution.enabled`를 켜면 Jira 상태 8개
(`implementationStatus`, `inProgressStatus`, `reviewStatus`, `planningStatus`,
`planningInProgressStatus`, `planReviewStatus`, `executionApprovedStatus`,
`taskWaitingStatus`)를 전부 서로 다른 값으로 요구했다. 사용자 피드백은 이 자체가
설정을 복잡하게 느끼게 만든다는 것이었다 — Jira 보드에 8개 컬럼을 새로 만들고 그 의미를
다 구분해서 기억해야 했다.

코드를 다시 보니 그중 상당수는 실제로 서로 구분할 필요가 없었다.

- **`inProgressStatus`/`planningInProgressStatus`**: 이 상태에 있는 동안 어떤 코드도
  "이게 계획 중인지 구현 중인지"를 상태값으로 다시 확인하지 않는다 — claim 시점에 한 번
  옮기고 끝이다(라우팅은 이미 그 앞 단계, 즉 요청 상태에서 끝났다). 이미 `claim.ts`는
  `planningInProgressStatus`가 없으면 `inProgressStatus`로 폴백하고 있었다 — 검증만
  별도로 강제했다.
- **`reviewStatus`/`planReviewStatus`**: 둘 다 "AI 작업 끝, 사람이 볼 차례"라는 같은
  의미이고, `poller.ts`의 `executableStatuses()`는 이 상태들을 다시 조회하지 않는다
  (에이전트가 재차 집어가지 않는 종점).
- **`executionApprovedStatus`(부모 단위 최종 승인)**: PM은 새 하위 티켓을
  `implementationStatus`로 자동 전이시키지 않는다(사람이 직접 옮겨야 한다) — 그래서
  "하위 티켓을 실행 상태로 옮기는 행위" 자체가 이미 충분한 승인 신호였다. 별도의
  부모 상태 확인은 "계획 전체를 다 검토한 뒤 한번에 승인"이라는 조금 더 엄격한 안전장치를
  추가할 뿐, 원래 막으려던 문제(승인 없는 자동 실행)에는 필수가 아니었다.
- **`taskWaitingStatus`**: `pm/apply.ts`는 이미 이 필드가 없으면 그냥 새 하위 티켓을
  Jira 기본 생성 상태에 둔다 — 코드는 optional로 다뤘는데 설정 검증만 무조건 요구했다.

반대로 **요청 상태**(`planningStatus`/`implementationStatus`)만큼은 합칠 수 없었다.
"이 이슈가 계획이 필요한지 바로 구현 대상인지"를 계층(`parentKey` 유무)이나 이슈 타입으로
추론하는 방법을 검토했지만, PM 계획 없이 사람이 최상위 Task를 만들어 바로 구현시키는
것은 GGJIRA의 원래 기본 사용법이다(Plan Mode는 opt-in) — 이런 티켓은 `parentKey`가 없는
최상위 이슈이면서 목적은 "바로 구현"이라, 계층 기반 추론과 정면으로 충돌한다. 그래서
요청 상태는 계획용/구현용을 반드시 분리해서 유지해야 한다.

## Decision

**`inProgressStatus`/`reviewStatus`는 계획 lane과 구현 lane이 공유한다.**
`planningInProgressStatus`/`planReviewStatus`라는 별도 필드 자체를 config 스키마에서
없앤다. `claim.ts`는 항상 `inProgressStatus`로 claim하고, `reporter.ts`는 계획이 끝났든
구현이 끝났든 항상 `reviewStatus`로 전이한다.

**`executionApprovedStatus`(부모 단위 최종 승인)를 없앤다.** 승인은 하위 티켓 각각을
`workflow.implementationStatus`로 옮기는 행위 그 자체다 — 부모의 Jira 상태를 별도로
확인하지 않는다. `agent/runtime.ts`와 `poller.ts`는 더 이상 부모 이슈를 조회하지
않는다(`ggjira.plan` issue property만 읽어 plan version이 맞는지만 확인한다) — Jira
API 호출도 하나 줄어든다.

**`taskWaitingStatus`를 없앤다.** 새로 생성된 하위 티켓은 배포 모드에서도 어떤 상태로도
전이시키지 않는다 — Jira가 만들어주는 기본 생성 상태에 그대로 둔다. 안전성은 그대로다:
어떤 상태에 있든 사람이 `implementationStatus`로 직접 옮기기 전까지는 실행되지 않는다.

**`distribution.enabled`가 요구하는 상태는 `planningStatus` 하나로 줄어든다.**
`implementationStatus`/`inProgressStatus`/`reviewStatus`는 이미 v4 전체가 무조건
요구하던 값이므로, 배포를 켜면서 새로 요구하는 건 사실상 `planningStatus`뿐이다. 총
상태 개수: 8 → 4(`implementationStatus`, `inProgressStatus`, `reviewStatus`,
`planningStatus`).

**`ggjira.plan` issue property의 `status`("review"/"approved") 필드를 없앤다.** 승인
여부를 이제 아무도 이 필드로 판단하지 않으므로 — ADR 0016에서 이미 "approved로 되쓰는
경합 위험한 쓰기"를 없앴을 때부터 사실상 쓰기 전용 죽은 필드였다.

이 결정은 ADR 0016의 다음 부분을 대체한다: 8개 상태 요구, `executionApprovedStatus`
기반 부모 승인 게이트, `ggjira.plan.status` 필드. ADR 0016의 나머지(계획 버전 관리,
`ggjira.plan-task` 메타데이터 스키마, workspace 격리, 재계획 시 재기록, decisionId
느슨한 매칭, Workspace Configuration 이슈로의 설정 전파)는 그대로 유효하다.

## Consequences

- Setup 5번(`PM approval & distribution`)이 묻는 질문이 8개 상태+2개 필드에서 4개
  상태+2개 필드로 줄었다. Jira 보드에 새로 만들어야 하는 컬럼도 4개(그중 3개는 배포를
  안 써도 어차피 필요한 컬럼)뿐이다.
- "계획 전체를 다 검토한 뒤 한번에 승인"이라는 조금 더 엄격한 안전장치는 사라졌다 — 하위
  티켓을 하나씩 `implementationStatus`로 옮기는 순간 그 하나는 바로 실행 후보가 된다.
  실사용에서 이게 문제가 되면(부분 검토 상태에서 실수로 하나를 옮기는 경우) 별도 안전장치를
  다시 논의한다.
- 이미 실제 Jira에 배포된 v4 config가 없는 상태에서 이 결정을 내렸다(`docs/phase3-verification.md`
  §9가 전부 미실행) — 그래서 `ggjira.plan.status`나 4개 필드 제거에 대한 마이그레이션
  경로를 따로 만들지 않았다. 기존 `ggjira.config.json`에 옛 필드가 남아 있어도 zod가
  조용히 무시하므로 설정 로딩 자체는 깨지지 않지만, `distribution.enabled`인 v4 config가
  옛 8-필드 형태로 저장돼 있었다면 `planningStatus`만 있으면 검증을 통과한다(나머지는
  단순히 무시된다).
