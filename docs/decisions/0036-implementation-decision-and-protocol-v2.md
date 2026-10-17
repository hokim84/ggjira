# 0036. 구현 결과 구조화, 범위 이탈 중단, 프로토콜 2

## Context

구현 워커는 provider의 자유 텍스트 summary만 돌려주었다. 결과 계약에는 `needs_decision`이 있었지만 보고
경로는 계획의 `plan.decision`만 읽었다. 그래서 구현 중에 결정이 필요하면 Jira에 "실패"로 보고됐다. 범위를
벗어난 변경도 일반 성공과 같은 commit → validate → push → PR 경로를 탔고, 커밋 전에 변경 경로를 계약과
대조하는 장치가 없었다(`changedFilesSince`는 커밋 후에만 동작한다). ADR 0034의 계약(`allowedPaths` 등)과
ADR 0035의 승인 고정은 구현 단계에서 이 경로가 있어야 의미가 생긴다.

## Decision

1. **공통 결정 형식**: `PlanDecisionSchema`를 `src/contracts/decision.ts`의 `DecisionRequestSchema`로
   옮기고 계획과 구현이 함께 쓴다. 구현 결과에 가짜 계획 객체를 끼워 넣지 않는다.
2. **구현 보고**(`ImplementationReportSchema`, `src/contracts/implementation.ts`): `outcome`
   (`completed | needs_decision`), `summary`, `scopeDeviations[{description, reason}]`, `decision`
   (`needs_decision`이면 필수), `verification[{acceptance, status: pass|fail|not_verified, evidence}]`.
   구현 provider 호출의 최종 구조화 응답으로 받는다. 추가 LLM 호출은 없다. 손으로 쓴
   `IMPLEMENTATION_REPORT_JSON_SCHEMA`를 테스트로 Zod와 맞춘다.
3. **provider**: Claude Code는 `--json-schema`를 쓰고, result 이벤트의 `structured_output`을 결과 텍스트보다
   우선한다. Codex CLI는 `--output-schema`를 지원하지만 OpenAI의 strict 스키마는 모든 속성을 required로
   요구하는데, 계획 스키마에는 선택 필드가 있다. 그래서 Codex는 지금처럼 스키마를 프롬프트에 접어 넣고
   마지막 메시지의 JSON 블록을 읽는다. 어느 쪽이든 최종 판정은 워커의 Zod 검증이다.
4. **실패로 보는 경우**: JSON이 없거나 스키마에 맞지 않는 보고, provider 오류, `completed`인데
   `verification`이 비어 있는 보고, `fail` 판정이 하나라도 있는 보고다. 성공으로 보지 않는다. 앞의 둘과
   뒤의 둘 모두 커밋하지 않고 변경을 증거로 보존한다(6항).
5. **경로 검사**(`src/issue/paths.ts`, `listWorkingTreeChanges`·`listCommittedChanges`): 커밋 전에
   `git status --porcelain=v1 -z --untracked-files=all`과 기준 브랜치 이후 커밋(에이전트가 지시를 어기고
   커밋한 경우)의 변경 경로를 모은다. 새 파일·삭제·rename을 포함하고, rename은 양쪽 경로를 모두 검사한다.
   glob은 저장소 루트 기준이다(`**`, `*`, `?`). `allowedPaths`가 비어 있거나 git 작업 공간이 아니면
   `checked: false`와 이유를 남긴다. "검사 안 함"이지 "이탈 없음"이 아니다.
6. **이탈 분기**: `needs_decision`, 에이전트가 보고한 의미상 이탈(`scopeDeviations`), 경로 이탈 중 하나라도
   있으면 commit·validate·push·PR을 모두 건너뛴다. `git add -A` 후 fork point 대비
   `git diff --cached --binary`를 `<logPath>/<jobId>-<attemptId>.patch`로 남기고 worktree도 그대로 둔다.
   결과의 `localEvidence`에 worktree·branch·patch 위치와 정리 방법을 적는다. 상태는 `needs_decision`이다.
   경로 이탈과 의미상 이탈을 따로 기록하는 이유는, 경로가 허용 범위 안이어도 공개 API나 데이터 모델을
   바꿀 수 있고(경로 검사로는 보이지 않는다), 반대로 경로 검사는 에이전트의 판단 없이도 확실하기 때문이다.
7. **Router 보고**: 구현 job의 `needs_decision`은 "구현 결정 요청" 댓글(`renderImplementationDecisionRequest`)을
   쓰고 `needsDecisionStatus ?? reviewStatus`로 옮긴다. 결정도 이탈도 없으면 실패로 보고한다. 계획 결정은
   기존 경로 그대로다. 댓글은 변화(멈춘 이유) → 선택지 → 영향 → 필요한 행동 → 증거 위치 순서이고 로그를
   복제하지 않는다. 계획용 `[GGJIRA:DECISION-REQUEST]` 마커는 쓰지 않는다. 답은 댓글이 아니라 설명의
   계약에 반영하고 요청 상태로 다시 옮겨야 한다. 댓글은 승인 입력에 들어가지 않기 때문이다(ADR 0035).
   그러면 새 승인 id와 v2 해시로 새 job·attempt가 만들어진다.
8. **job 상태**: 구현 `needs_decision`도 지금처럼 job을 `succeeded`로 닫는다(실행 자체는 끝났다). 구분은
   결과 payload와 보고 저널이 한다. `jobs` CHECK 제약 재작성(테이블 재생성 migration)을 피하려는 것이다.
   ADR 0020의 결과 상태 대응표는 그대로다.
9. **프로토콜 2**: envelope에 `executionContract`가 들어가고 결과의 의미가 바뀌므로 `PROTOCOL_VERSION`을
   2로 올린다. 버전이 다른 워커는 기존 426 `protocol_mismatch`로 실행 전에 거절된다. 워커 spool의 파싱할
   수 없는 결과(이전 버전이 쓴 결과 포함)는 지금처럼 건너뛰되 경고를 남기고 파일은 지우지 않는다.
10. 성공 결과에도 `implementation`과 `scopeCheck`를 붙인다. 성공 댓글에 acceptance별 판정과, 경로 검사를
    하지 않았다면 그 이유를 한 줄씩 적는다.

## Consequences

- 승인 범위 밖 변경이 필요하면 push·PR 없이 결정 대기로 멈춘다. 변경은 워커에만 남는다.
- 경로 검사는 `allowedPaths`를 쓴 계약에서만 동작한다. 의미상 이탈 판단은 구현 에이전트의 자기 보고에
  의존한다. 일반 코드로 완전히 판정할 수 없다.
- `verification`이 빈 `completed` 보고는 실패다. acceptance가 없는 이전 형식의 요청은 ADR 0034의 준비
  검사로 시작 자체가 막힌다.
- 업그레이드 순서가 정해진다: 워커 유휴 확인 → spool 비움 → Router·워커 동시 업그레이드(runbook §26).
  섞여 있으면 426으로 거절되고 실행되지 않는다.
- 보존한 worktree·patch는 자동으로 지우지 않는다. `worker worktrees prune`이나 수동 정리가 필요하다.
- `not_verified` 판정은 성공으로 통과한다. 묶음 검토에서 이를 어떻게 다룰지는 M4(책임 게이트)의 몫이다.
