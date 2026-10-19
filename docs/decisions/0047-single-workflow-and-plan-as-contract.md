# 0047. 워크플로 하나와 승인된 계획을 실행 계약으로

## Context

ADR 0044는 상태 기반 위임(delegation 모드)을 legacy 모드 옆에 추가했다. ADR 0046은 label 모드를 제거했다. 그래도
두 가지가 남아 있었다.

- legacy 모드: 사람이 구현 요청 상태와 계획 요청 상태를 골랐다. 계획은 선택 사항이었다. 계획을 사람이 승인하는
  사건도 없었다.
- 구현 계약: Router는 이슈 설명의 h2 절 이름(`Acceptance Criteria`, `Verification`, `Allowed Paths`,
  `Required Capabilities`, `Dependencies` …)을 파싱해 계약으로 썼다(ADR 0034). 그래서 사람이 정해진 키워드로
  설명을 써야 했다. 두 절이 없으면 구현 요청을 보류하고 안내 댓글을 달았다. delegation 모드에서도 같은 검사를
  거쳤다. 그 결과 사람이 승인한 계획이 승인 뒤에야 계약 절이 비었다는 이유로 멈출 수 있었다.

사용자는 키워드로 맥락을 전달하는 방식을 없애고, 쓰이지 않거나 호환되지 않는 부분은 억지로 지원하지 않기로 했다.

## Decision

1. **워크플로는 하나다.** delegation 흐름만 남긴다. `workflow.mode`, legacy의 구현 요청 의미, `planningStatus`,
   `needsDecisionStatus`를 제거한다. 설정 키는 `requestStatus`·`planReviewStatus`·`inProgressStatus`·
   `reviewStatus`·`doneStatus`(선택)다. 상태는 서로 달라야 한다. 제거한 키는 `.strict()` 검증 오류로 거절한다.
   예전 설정을 자동으로 바꾸지 않는다.
2. **실행 계약은 승인된 계획이다.** 구현의 완료 조건·검증·범위·영향 영역·허용 경로·제약·capability·실행 전략은
   Router가 저장한 계획 결과(`plan_reviews` → `results.payload.plan`)에서 읽는다(`src/pm/contract.ts`).
   - 하위 작업이 없는 계획: 부모의 계약은 계획 자체의 필드다.
   - 하위 작업: 그 taskId를 정의한 계획(새 작업은 승인된 계획, 재계획에서 유지한 작업은 이전 계획)의 해당 작업이다.
   - 의존성: Router가 하위 작업을 만들 때 이슈 키로 바꿔 `ggjira.plan-task`에 기록한 값이다.
   - 계획 요청: 계약이 없다. 의존성도 기다리지 않는다.
   Router는 설명에 렌더링한 계획 블록이나 하위 이슈 설명을 다시 파싱하지 않는다. 렌더링은 사람이 읽기 위한
   것이다. 설명 파서(`parseSections`·`readIssueRequirements`)를 제거한다.
3. **완료 정의 없는 계획은 적용하지 않는다.** 실행 단위(하위 작업, 없으면 부모)에 완료 조건이나 검증이 비어 있으면
   계획을 적용하지 않고 실패로 보고한다. 그런 계획은 계획 검토로 가지 않으므로 승인될 수 없다. PM 프롬프트도 두
   항목을 비우지 말라고 말한다. 결정이 필요한 계획은 이 검사를 하지 않는다.
4. **구현 요청 준비 보류(ADR 0034의 보류 부분)를 제거한다.** `not_ready` 결정, `readiness_holds` 기록·안내 댓글,
   `GET /admin/holds/readiness`, `readiness_hold` 주의 항목을 없앤다. migration 15가 열려 있던 보류와 그 주의
   항목을 닫는다. 테이블과 migration 10은 이력으로 남긴다. ADR 0034의 범위 계약 필드 자체와 Worker의 경로 검사는
   유지한다.
5. **v1 입력 해시 호환을 제거한다(ADR 0035의 전환 규칙).** 승인 snapshot은 v1 해시를 담지 않는다. v1으로 찍힌
   job은 입력이 바뀐 것으로 보고 취소·보류한다.
6. **legacy → delegation 이관 도구를 제거한다.** `migrate-delegation`, `/migrations/delegation/*`, 기준선 hold
   actor `migration:delegation`의 안내를 없앤다. 전환은 runbook §34의 수동 절차로 한다. 이전 버전에서 배정을
   멈추고, 새 요청 상태를 새로 만든 뒤, 설정을 바꿔 업그레이드한다.
7. **이슈 조회는 위임 단계만 보여 준다.** legacy의 시작 차단 이유 목록(`blockers`)과 `mode`를 응답에서 뺀다.
8. **실행 기록의 재작업 구분**(ADR 0042): 같은 종류의 이전 job이 있을 때만 rework다. 모든 요청이 계획부터 하므로,
   계획 뒤 첫 구현은 initial이다.
9. Worker 프로토콜 2와 envelope 형식은 바꾸지 않는다. envelope의 `executionContract`는 승인 snapshot의
   계약을 복사한다.

대체 범위: ADR 0044의 "delegation 모드는 legacy와 함께 둔다"와 이관 도구·기준선, ADR 0034의 "설명 절을 파싱해
계약으로 쓴다"와 "준비 보류", ADR 0035의 v1 비교 규칙을 대체한다. ADR 0044의 위임·계획 승인·배포·철회 규칙과
ADR 0040~0043·0046은 그대로다.

## Consequences

- 사람은 이슈 설명을 자유롭게 쓴다. 범위를 바꾸려면 설명을 고쳐 다시 계획한다. 승인 뒤 설명을 고치면 계약은
  바뀌지 않고 입력 변경으로 취소된다(ADR 0035).
- 예전 legacy·label 설정으로는 Router가 시작하지 않는다. 이전 버전에서 정리한 뒤 전환해야 한다(runbook §34).
  이전 요청·계획 요청 상태에 남은 이슈는 다시 맡기기 전까지 아무도 가져가지 않는다.
- 하위 작업의 계약은 Router DB의 계획 결과에 달려 있다. 결과가 없거나 읽을 수 없으면 그 작업은 승인되지 않은 것으로
  본다(`NotDelegatedError`).
- 승인 뒤 구현 단계에서 계약이 비었다는 이유로 멈추는 일은 없다. 그 검사는 계획을 적용할 때 한 번 한다.
- 테스트 하네스는 실제 흐름과 같은 기록(계획 job·결과·계획 기록·활성 승인)을 만들어 승인된 이슈를 시드한다
  (`test/helpers/approved-plan.ts`).
