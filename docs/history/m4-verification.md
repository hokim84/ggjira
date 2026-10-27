# M4 검증 기록과 완료 보고 — label opt-in과 간소화된 작업 흐름

작성일: 2026-10-19 · 대상: `docs/history/M4_WORK_BACKLOG.md`의 M4-00 ~ M4-12 · 브랜치 `feat/m4-label-opt-in`

## 1. 기준선과 범위

- 기준선: 태그 `m3-baseline-2026-10-18`(원격에 있음) → `main` = `origin/main` = `2cca7fc`.
- M4 커밋(기준선 이후): `7c653e8`(백로그) → `a983bd3`(M4-01·02·05) → `27f1ee5`(M4-06) → `de17fa1`·`851a8f0`·
  `9155576`(M4-07) → `ae94697`(M4-03·04) → `5823cad`(M4-08) → `3355ed1`(M4-11) → `b50f97a`(M4-09) →
  `b33c2a4`(M4-12) → 이 문서의 커밋(M4-07 최종 검증, M4-10).
- 브랜치는 push했고 PR #1(`feat/m4-label-opt-in` → `main`)로 올렸다. DB·설정 백업은 Git 태그와 별개로 운영자가
  확보한다(runbook §17, §31).

## 2. 티켓별 결과

| 티켓 | 상태 | 근거 | 사용자에게 달라진 점 |
|---|---|---|---|
| M4-00 기준선 | 완료(이전 세션) | 원격 태그 `m3-baseline-2026-10-18` | 없음 |
| M4-01 의미 확정 | 완료 | ADR 0037 결정표 | label/legacy 모드 |
| M4-02 라벨 후보·철회 | 완료 | `router-label-mode`, `router-issue-opt-in` | 라벨 제거 = 취소·중단 요청, 재부착 = 새 승인 |
| M4-03 API 라벨 수정 | 완료 | ADR 0039, `router-issue-opt-in`(9) | `router issue show/opt-in`, 감사 기록 |
| M4-04 UI 토글 | 완료 | ADR 0039, 브라우저 수동 확인(§4) | 웹 UI "이슈" 화면 |
| M4-05 네 상태 전이 | 완료 | ADR 0037, `router-label-mode` | 결정·실패는 진행 상태 유지 |
| M4-06 웹훅 | 완료 | ADR 0038, `router-webhook`, `router-server` | 댓글·외부 프로젝트 이벤트는 깨우지 않음 |
| M4-07 전환·마이그레이션 | 완료 | ADR 0037 §8, `router-label-migration`, `router-db`(M4 migrations) | `migrate-labels plan/apply`, migration 11~13 |
| M4-08 범위 이탈 회귀 | 완료 | `router-label-mode`(T06·T07 3건), PM 프롬프트 크기 규칙 | label 모드의 재승인 안내 |
| M4-09 간결한 보고·주의 항목 | 완료 | ADR 0041, `router-attention`(4) | 확인 필요 항목, 반복 실패 댓글 억제 |
| M4-10 리허설·회귀·운영 | 이 문서 | §3, runbook §31 | 업그레이드·되돌리기 절차 |
| M4-11 책임 게이트 | 완료 | ADR 0040, `router-review-gate`(8), `router-github`(+4) | 검토 대상 고정, 머지 → 완료 조건 강화 |
| M4-12 실행·사용량 증거 | 완료 | ADR 0042, `router-execution-records`(5), `worker-call-usage`(6) | `router usage` |

기존 결정과 달라진 것: ADR 0027(머지 → 완료)은 ADR 0040 7항으로 보완됐다. head가 검토 커밋과 다르거나 같은
이슈의 새 결과가 있으면 완료로 옮기지 않는다. ADR 0036의 "`not_verified`는 성공으로 통과"는 그대로이되, 그런 결과는
개별 검토 대상(`immediate`)으로 분류된다.

## 3. 시나리오 검증표 (T01 ~ T23)

자동 = Fake Jira·Fake/스크립트 provider·loopback HTTP만 쓰는 vitest. 실제 Jira·GitHub·CLI 연동은 하지 않았다.

| ID | 자동 테스트 | 수동/미실행 |
|---|---|---|
| T01 | `router-label-mode` "picks up only To Do…", `router-issue-opt-in` "adds only the opt-in label…" | 실제 Jira JQL `labels =` 대소문자 동작 미실행 |
| T02 | `router-label-mode` "plans a request… holds a subtask", `router-attention` "counts every pass…" | — |
| T03 | `router-label-mode` "moves To Do → In Progress → Review…", "moves Review → Done when the reviewed pull request is merged" | 실제 GitHub 머지 미실행 |
| T04 | `router-label-mode` "implements a planned request…", `router-reporting` planning results | — |
| T05 | `router-label-mode` 라벨 제거 2건, `router-issue-opt-in` "removes the label…" | — |
| T06 | `router-label-mode` "cancels a run whose request was edited…", "holds a queued request edited…" | — |
| T07 | `router-label-mode` "stops on a path deviation…", `worker-scope`, `router-reporting` 검증 실패 증거 | — |
| T08 | `router-webhook`, `router-server`(웹훅), `router-label-mode` "creates nothing new when Router's own writes…" | 실제 Jira 웹훅 전송 미실행 |
| T09 | `router-issue-opt-in` 404·403·429·불명확한 쓰기, `router-reporting` uncertain 댓글, `jira-retry` | — |
| T10 | `router-issue-opt-in` 다른 라벨 보존(부분 수정 `update.labels`) | 실제 Jira에서 동시 수정 미실행 |
| T11 | `router-reporting` "never overrides a status a human set…", `router-github` "leaves an issue a human already moved…" | — |
| T12 | `router-reporting` "posts the decision once across a resend and a Router restart", `router-execution-records` 재전송·재시작, `router-daemon` | — |
| T13 | `router-label-migration` 8건 | 실제 프로젝트 이관 리허설 미실행 |
| T14 | `router-db` "upgrades a pre-M4 (version 10) database…", `contracts-implementation` "results from a protocol-2 worker before M4" | 운영 DB 사본으로 리허설 미실행 |
| T15 | `router-label-migration` "skips an issue that changed… and carries on after a failure" | 롤백 리허설 미실행(runbook §31 절차만) |
| T16 | `router-github` head 불일치·대체된 실행, `router-review-gate` | — |
| T17 | 전체 스위트(아래 §5) | 실제 setup·worker start·PR 흐름 미실행 |
| T18 | `router-review-gate` 추가·삭제·rename 양끝, 규칙 버전 | GitHub branch protection 강제 여부 미실행 |
| T19 | `router-review-gate` "asks for individual judgement of a result with no commit", `worker-scope` 비 git | — |
| T20 | `router-attention` "counts a repeated failure once, resolves it on success, links a recurrence" | — |
| T21 | `router-attention` "never starts anything when an item is resolved…" | — |
| T22 | `router-execution-records` 5건, `worker-call-usage` 6건 | 실제 Claude Code·Codex 스트림의 사용량 필드 미확인 |
| T23 | `router-no-llm` (보고·검토·주의 항목·사용량 모듈이 Jev·provider에 닿지 않음) | — |

자연어 작업 크기와 의미상 이탈의 판정 품질(M4-08)은 프롬프트 문구와 경로 검사만으로 입증되지 않는다. 대표 사례를
사람이 함께 검토해야 한다(미실행).

## 4. 수동 확인

- 웹 UI(Fake Jira를 붙인 로컬 Router, scratch 스크립트): 이슈 화면 조회 → AI 참여 켜기 → 재조회 확인 메시지 →
  다음 조회에서 구현 job 큐, 보류 이유(요청 상태 아님·담당자 없음)와 다음 행동, 범위 밖 프로젝트 키 오류,
  대시보드 "확인 필요" 카드·목록, 이슈 화면 검토 대상(개별 검토 필요·고위험 규칙 일치·미검증)과 주의 항목,
  실패한 job 표시. 콘솔 오류 없음. 확인 중 두 가지를 고쳤다: 검토 상태 이슈의 "요청 상태로 옮기라" 안내 문구,
  실패한 job이 정상처럼 보이던 배지.
- 실제 Jira·GitHub·Claude Code/Codex CLI 연동(`router check`, `worker check`, 실제 PR 머지)은 하지 않았다.

## 5. 자동 검사 결과와 남은 제약

- `npm run typecheck`, `npm run lint`, `npm run format:check`: 통과.
- `npx vitest run`(이 Windows 머신, Node 25.8): 607개 중 592 통과, 15 실패. 실패는 모두
  `worker-claude-code-cli`·`worker-codex-cli`·`worker-usage`의 `spawn EFTYPE`이다(셸 스크립트 가짜 CLI를 Windows에서
  spawn할 수 없음). M4 이전 커밋에서도 똑같이 실패한다.
- Linux: PR #1의 GitHub Actions CI(`npm run check`, ubuntu-latest)에서 607개 모두 통과했다. M4-12가 바꾼 두
  provider의 스트림 파싱 테스트(`worker-claude-code-cli`·`worker-codex-cli`·`worker-usage`)가 여기서 실행됐다.
- 전체 실행 중 한 번 17개 실패가 보고됐으나 이어서 세 번 돌렸을 때 재현되지 않았다(15개만 실패).
- DB: migration 11~13 추가(append-only). 이전 바이너리는 새 DB로 동작한다(schema 버전 검사 없음, 새 테이블 무시).
- Worker 호환: 프로토콜 2 유지. 새 필드는 모두 선택이고 양방향으로 무시·기본값 처리된다.
- 라벨 제거 후 최대 5초 동안 commit·push 허가가 남을 수 있다(ADR 0037).
- 상태는 아직 이름으로 식별한다(상태 ID 전환은 후속).
- 추가 LLM 호출: 없음(T23).

## 6. 승계표 기준 누락과 후속

| 기존 작업 | M4에서 한 것 | 후속으로 남은 것 |
|---|---|---|
| 책임 게이트·검토 대상 고정 | 검토 대상·고위험 근거·커밋 없음·머지 조건(ADR 0040) | F01 검토 대기 화면과 항목별 판단, F02 묶음 검토 |
| 보고 정책·사람 주의 필터 | 즉시 확인/일반 검토 대기/내부 기록, 주의 항목(ADR 0041) | F07 digest |
| 검토 대기·묶음 검토 | 댓글·UI에서 보류 이유와 다음 행동 | F01 → F02 |
| 부채·변경 저항 증거 | 실행·사용량·원인 분류 보존(ADR 0042) | F03 부채 후보, F04 후속 티켓, F05 비교·분석 |

F01~F07은 하나도 구현하지 않았다. 고위험 PR의 필수 리뷰를 GitHub branch protection으로 강제하는 설정과 그 확인은
운영자 작업이다.

## 7. M4 이후 조정: 상태 위임과 계획 우선 (ADR 0044)

`docs/history/M4_STATUS_DELEGATION_CHANGE_REVIEW.md`의 방향을 새 모드 `workflow.mode: "delegation"`으로 구현했다.
legacy·label 모드와 M4의 기록·검토·보호 기능은 그대로다(label 모드는 뒤이어 §8에서 제거했다). 세부 규칙은
사용자가 정했다.

- 계획 승인 = 계획 검토 대기 → 작업 중.
- 하위 티켓은 승인 전에 생성(실행만 승인 뒤).

| 문서 §5 시나리오 | 확인한 테스트 |
|---|---|
| 1 라벨 조작 무효 | `router-delegation-mode` "never plans, runs or withdraws anything because of a label" |
| 2 요청 1건 = PM job 1개, 실패 후 재시도 없음 | "makes one planning job for a request…" |
| 3 요청→철회→재요청, 중복·재시작 | "treats request → withdraw → request as two delegations…" |
| 4 계획 성공 → 계획 검토 대기, 자동 구현 없음 | "puts a finished plan in plan review…" |
| 5 할 일 → 작업 중(사람) 무효 | "runs nothing when a human moves their own issue…" |
| 6 유효한 승인만 배포 | "deploys the current plan…", "does not approve a plan that waits for a decision", "…for an earlier request" |
| 7 승인 재전송·부분 반영·재시작 | "waits for a plan still being applied, then deploys it once, through restarts" |
| 8 말단 재계획 없음, 사람 하위 작업 제외 | "runs the tasks of an approved plan without planning them again…" |
| 9 공용 작업 중의 유효 실행 유지 | "deploys the current plan…"(verify 무취소) |
| 10 철회·완료 뒤 늦은 결과 | "withdraws a plan when its parent leaves in progress…", "asks a running implementation to stop…" |
| 11 이유·다음 행동, 라벨 제거로 재개 없음 | "says why a run failed and what to do…" |
| 12 결과 검토·PR 머지·완료 | "moves review → done when the reviewed pull request is merged" |
| 13 M4 이슈 이관 뒤 자동 재실행 없음 | `router-delegation-migration` |

- 단위 테스트: `router-config`(delegation 검증), `router-workflow-mode`, `router-approval`
  (`computeDelegationApprovalIds`), `router-workflow-check`(delegation hop), `router-db`(migration 14).
- DB: migration 14(`plan_reviews`, `plan_deployments`) 추가. 1~13은 그대로다. Worker 프로토콜 2 유지.
- `npx vitest run`(이 Windows 머신): 651개 중 636 통과, 15 실패.
  - 실패는 기존과 같은 `spawn EFTYPE`이다(변경 전 main에서도 15개).
  - 앞선 두 번의 전체 실행에서는 `worker-push`·`worker-scope` 2개가 시간 초과로 더 실패했다. 이 둘은 git을 직접
    실행하는 Worker 테스트로 router 코드를 쓰지 않는다. 파일만 따로 돌리거나 다시 전체를 돌리면 통과한다.
  - `typecheck`·`lint`·`format:check`는 통과.
- Linux 전체 검사: 이 PC에서는 Docker 데몬이 꺼져 있어 돌리지 못했다. PR #3의 CI(`cd166f3`)에서
  `npm run check`가 통과했다(테스트 651개 전부 통과). Windows의 `spawn EFTYPE` 15개도 Linux에서는 통과한다.
- 실제 Jira에서의 확인(`router check`, 보드 드래그)은 수동 절차(runbook §34)로 남는다.

## 8. 라벨 기반 위임 제거 (ADR 0046)와 프롬프트 조회 (ADR 0045)

같은 PR #3에서 label 모드를 없앴다. 남은 모드는 legacy와 delegation이고, 둘 다 상태로만 요청·승인·철회한다.

- 제거: `mode: "label"`·`optInLabel` 설정(설정 오류로 거절), 라벨 조건의 후보 조회·승인 id·철회, label 이관
  (`migrate-labels`, `/migrations/label/*`), opt-in API·CLI·웹 토글.
- 남은 라벨: Router가 붙이는 `ggjira-failed`·`ggjira-superseded`(표시만, 떼도 다시 실행하지 않음)와 v4 메타
  이슈(`ggjira-agent`·`ggjira-workspace`)를 후보에서 빼는 필터.
- 예전 라벨 승인 정보가 남은 미완료 상태 이동은 다시 실행하지 않고 `skipped`로 둔다.
- 이슈 조회는 읽기 전용 `GET /api/v1/admin/issues/:key`(`issue show`)로 남았다.
- 테스트: `router-label-removal`(설정 거절, 라벨로 후보·승인 불변, 제거된 경로 404, 옛 저널 skipped),
  `router-issue-view`(보류 이유, 다른 프로젝트·잘못된 키 거절, Jira 404·403·429 구분),
  `router-prompts`(프롬프트 조회).
- PR #3의 CI(`408a0e5`)에서 `npm run check`가 통과했다.

## 9. 워크플로 하나와 승인된 계획을 실행 계약으로 (ADR 0047)

legacy 모드와 이관 도구를 지우고, 구현 계약을 이슈 설명의 절 대신 승인된 계획에서 읽게 했다.

- 설정: `mode`·`planningStatus`·`needsDecisionStatus`는 `Unrecognized key`로 거절하고, `planReviewStatus`는
  필수다(`router-config`).
- 계약: 하위 작업·부모의 계약을 계획에서 만들고, 완료 정의가 빈 실행 단위를 찾는다(`pm-plan-render`). 그런 계획은
  적용하지 않는다(`router-reporting` "refuses a plan whose executable unit has no definition of done").
  envelope의 계약은 승인된 계획과 같다(`router-reporting`, `router-worker-api`).
- 승인·배정: 요청 상태만 후보이고, 사람이 작업 중으로 옮긴 이슈는 가져가지 않는다. 승인된 계획의 구현만 배정한다.
  v1 해시로 찍힌 job은 취소된다(`router-scheduler`).
- readiness 보류 제거: migration 15가 열린 보류와 주의 항목을 닫는다(`router-db`).
- 실행 기록: 계획 뒤 첫 구현은 `initial`, 같은 계획의 재승인은 `rework`다(`router-execution-records`).
- 통합: Router 하나와 Fake 워커 둘이 실제 HTTP로 요청 → 계획 → 사람 승인 → 구현 → 결과 검토를 끝까지
  돈다(`router-integration`).
- `npx vitest run`(이 Windows 머신): 580개 중 565 통과, 15 실패. 15개는 기존과 같은 `spawn EFTYPE`이다.
  `typecheck`·`lint`·`format:check`는 통과.
