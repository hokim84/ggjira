# 0034. 작업 범위 계약과 구현 요청 준비 보류

## Context

계획(`PlanTaskSchema`)에는 acceptance·dependencies·constraints가 있었고 PM 프롬프트도 "독립 완료
단위"를 요구했다. 하지만 작업마다 무엇을 하고 무엇을 하지 않는지, 어디를 건드려도 되는지, acceptance를
어떻게 확인하는지는 적지 않았다. Router도 acceptance가 비어 있는 구현 요청을 그대로 워커에 보냈다.
`maxTasksPerPlan`은 티켓 수 제한일 뿐 작업 크기를 제한하지 않는다.

사람이 직접 만든 티켓과 PM이 만든 티켓은 모두 같은 Jira 설명 절(h2)로 읽힌다(`src/issue/requirements.ts`).
"human" 보류는 지금까지 로그에만 남아서, 요청한 사람은 왜 아무 일도 일어나지 않는지 알 수 없었다.

## Decision

1. **계약 필드**를 계획 스키마, provider JSON Schema, Jira 절에 같은 이름으로 추가한다.
   `acceptance`(기존)에 더해 `verification`(Verification), `inScope`(In Scope),
   `outOfScope`(Out of Scope), `affectedAreas`(Affected Areas), `allowedPaths`(Allowed Paths)다.
   `affectedAreas`는 참고용이고, `allowedPaths`(glob)는 비어 있지 않을 때만 워커가 강제한다(ADR 0036).
   부모를 실행 단위로 남기는 계획(하위 작업 없음)도 부모에 같은 계약을 쓴다.
2. **준비 검사**(`src/issue/readiness.ts`): 구현 요청은 Acceptance Criteria와 Verification이 각각 한 줄
   이상 있어야 시작한다. 내용의 질은 판단하지 않는다(존재 검사). 계획 요청은 검사하지 않는다. 불완전한
   요구를 분석·보완하는 것이 계획의 일이기 때문이다. `RuleDecisionProvider`는 capability 검사 다음에 이
   규칙을 적용하고, 실패하면 `{target: "human", code: "not_ready", missing}`을 돌려준다.
3. **보류 기록과 안내 댓글**: job이 없는 보류라 job 단위 보고 저널(`report_steps`)을 쓸 수 없다. migration
   10의 `readiness_holds`에 기록한다. 행 id는 `issue|approvalId|inputHash|missing`의 해시다. 같은 요청을
   다시 조회하면 `seen_count`만 오르고, 설명을 고치면(입력 해시가 바뀌면) 새 행이 된다. 행마다 Jira
   댓글을 한 번 쓴다. 댓글에는 `[GGJIRA:HOLD:<id>]` 마커가 있고, 쓰기 전에 댓글을 다시 읽으므로 불확실한
   쓰기나 재시작 뒤에도 두 번 쓰지 않는다. 오류 분류는 보고 저널과 같다(명확한 4xx는 `failed`, 그 밖은
   `pending`으로 다음 패스). 보완되어 배정되거나 이슈가 요청 상태를 떠나면 보류는 해소된다.
   보완 뒤에는 이슈를 옮길 필요 없이 다음 조회에서 시작된다. job이 만들어진 적이 없으므로 ADR 0035의
   "같은 승인으로 재실행 금지"에 해당하지 않는다.
4. **PM 프롬프트**: 작업 하나 = 독립적으로 검증 가능한 결과 하나. 결과가 하나면(문구 변경 등) 하위
   티켓을 만들지 않고 부모 계약만 채운다. 독립 결과가 섞여 있으면 분해하거나 decision을 반환한다.
   계약은 기존 PM 호출의 같은 구조화 응답에 담는다. LLM 호출은 늘지 않는다.
5. 관리 API `GET /api/v1/admin/holds/readiness`로 미해결 보류를 본다.
6. `PLAN_JSON_SCHEMA`와 `PlanSchema`의 일치를 테스트로 지킨다(`test/pm-plan-schema.test.ts`). 이때
   decision `options`의 `minItems: 2` 누락을 바로잡았다.
7. 설명 파서 두 가지를 바로잡았다. 한 줄짜리 `{noformat}…{noformat}`(Router 마커)는 내용으로 읽지 않는다.
   전에는 계획 블록 끝 마커가 마지막 절(Required Capabilities)의 항목으로 읽혔다. 글머리 기호는 기호 뒤에
   공백이 있을 때만 떼어 낸다. 그래서 `* **/*.md` 같은 glob 항목이 `/*.md`로 잘리지 않는다.

## Consequences

- 기존 티켓 중 Acceptance Criteria나 Verification이 없는 구현 요청은 업그레이드 뒤 시작되지 않고 안내
  댓글을 한 번 받는다. 보완 절차는 runbook "구현 요청 준비 보류"에 있다.
- 준비 검사는 문구의 존재만 본다. "의미 있는 acceptance인가"는 PM 프롬프트와 사람의 검토 몫이다.
  프롬프트 테스트는 문구가 들어 있는지만 확인하며, 분해 품질을 입증하지 않는다.
- 안내 댓글이 Jira에서 명확히 거부되면(`failed`) 보류는 남고 댓글만 빠진다. 관리 API 목록에서 보인다.
- `*item`처럼 기호 뒤에 공백이 없는 줄은 이제 글머리 기호로 보지 않는다. Jira 위키 마크업의 목록은 기호
  뒤에 공백이 있으므로 Jira에서 편집한 설명에는 영향이 없다.
