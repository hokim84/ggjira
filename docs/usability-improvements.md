# 사용자 사용성(UX) 개선 사항 정리

GGJIRA(`configVersion: 7`, `PROTOCOL_VERSION: 8`)의 전체 플로우와 실제 사용자 접점(**Jira 보드·댓글**, **Slack DM**, **Router 웹 UI**, **Worker CLI 온보딩**)을 검토하여 도출한 수정 필요 사항이다.

- 작성 형식은 [`docs/known-issues.md`](./known-issues.md)와 동일하게 **증상 → 근거(파일·줄) → 수정 방안 → 확인 방법** 순서를 따른다.
- 우선순위는 **P1**(초기 설정 누락·잦은 오작동 오해·핵심 동선 단절), **P2**(입력 실수 방지·원격 진단 편의성), **P3**(워크플로 정책·멘탈 모델 개선)으로 구분한다.

## 요약

| 번호 | 제목 | 분류 | 우선순위 | 난이도 | 상태 |
|---|---|---|---|---|---|
| 1 | `worker start` 첫 설정 시 `validateCommand` 질문이 빠져 첫 작업마다 경고 발생 | 워커 CLI | P1 | 낮음 | 해결 (`src/worker-runtime/start.ts`, `cli.ts`) |
| 2 | 워커 `worker start` 경로 입력에서 Windows `~`(홈 폴더) 확장이 동작하지 않음 | 워커 CLI | P1 | 낮음 | 해결 (`src/worker-runtime/start.ts`) |
| 3 | 웹 UI 작업 상세에서 사람 확인(`humanCheck`)이 필요할 때도 확인 기록 섹션이 접혀 있음 | 웹 UI | P1 | 낮음 | 해결 (`web/router-ui/views-issues.js`) |
| 4 | 웹 UI 대시보드·작업 상세에 즉시 동기화(`reconcile` / PR 확인) 버튼이 없음 | 웹 UI | P1 | 낮음 | 해결 (`web/router-ui/views-status.js`, `views-issues.js`) |
| 5 | Jira 댓글 명령(`재시도`, `재계획`, 선택지 번호)이 완전 일치만 허용하고 오입력 시 무응답 | Jira 댓글 | P2 | 낮음 | 해결 (`src/pm/context.ts`, `src/router/planning-requests.ts`, `issue-check.ts`) |
| 6 | 이슈 설명의 `[GGJIRA:PLAN:START]` 블록 안을 직접 고쳐도 무시된다는 안내가 본문에 없음 | Jira 설명 | P2 | 낮음 | 해결 (`src/pm/plan-render.ts`) |
| 7 | 원격 Router 환경에서 실패 상세 로그(`data/failure-logs/*.log`)를 웹 UI에서 볼 수 없음 | 웹 UI·API | P2 | 중간 | 해결 (`src/router/admin-service.ts`, `issue-view.ts`, `web/router-ui/views-issues.js`) |
| 8 | 계획 단계 질문과 구현 중 질문(`implementationDecision`)의 Jira 응답 방식이 다름 | 워크플로 | P3 | 중간 | 검토 필요 |
| 9 | 계획 완료 후 부모 이슈를 `AI 구현`으로 옮기면 자식 일괄 승인이 아니라 위임 철회가 됨 | 워크플로 | P3 | 중간 | 검토 필요 |

---

## 1. `worker start` 첫 설정 시 `validateCommand` 질문이 빠져 첫 작업마다 경고 발생

- **증상:** `ggjira worker start`로 처음 워커를 설정하면 Router 주소, LLM CLI, 페어링 코드, 저장소 폴더까지만 묻고 설정을 저장한다. 그 결과 모든 저장소의 `validateCommand`가 설정되지 않은 채 시작되어, 첫 구현 작업이 끝날 때마다 `"워커 검증 명령이 실행되지 않았습니다. AI 자체 보고만 근거입니다"`(`no_trusted_validation`) 주의 항목이 발생한다. 사용자는 뒤늦게 워커를 종료하고 `worker.config.json` 파일을 직접 찾아 편집해야 한다.
- **근거:**
  - `src/worker-runtime/start.ts:196-243` (`firstRunSetup`)
  - `src/worker-runtime/ops.ts` (`workerConfigFromProfile`에서 `validateCommand` 미포함)
  - `src/router/review-gate.ts` (`no_trusted_validation` 분류)
- **수정 방안:**
  - `firstRunSetup`의 `chooseRepositoryPaths` 직후, 각 저장소마다 검증 명령을 묻는 프롬프트(`저장소 "<id>" 검증 명령 (예: npm test, pytest / 건너뛰려면 Enter): `)를 추가한다.
  - 비대화형 실행을 위해 `--validate-command <cmd>`(또는 저장소 루트의 `package.json` 등 감지 후 기본값 제안) 옵션을 지원하고, 입력된 값을 `repositories[].validateCommand`에 기록한다.
- **확인 방법:**
  - `test/worker-start.test.ts`에 대화형 첫 설정 시 검증 명령을 입력하면 `worker.config.json`의 `repositories[0].validateCommand`에 저장되는지 확인하는 테스트를 추가한다.

## 2. 워커 `worker start` 경로 입력에서 Windows `~`(홈 폴더) 확장이 동작하지 않음

- **증상:** Windows PowerShell이나 명령 프롬프트에서 `worker start`의 저장소 폴더 질문에 `~/repos/my-app`을 입력하면 홈 디렉터리로 확장되지 않고 현재 작업 폴더 기준의 상대 경로(`...\~\repos\my-app`)로 해석되어 `"폴더가 없습니다"` 오류가 난다.
- **근거:**
  - `src/worker-runtime/start.ts:40-44`의 `expandHome` 함수가 `process.env.HOME`만 참조하고 Windows 기본 환경변수(`USERPROFILE`)나 `os.homedir()`를 사용하지 않는다.
- **수정 방안:**
  - `node:os`의 `homedir()`(환경변수 오버라이드가 필요하면 `process.env.HOME ?? process.env.USERPROFILE ?? homedir()`)를 사용하도록 `expandHome`을 수정한다.
- **확인 방법:**
  - `test/worker-start.test.ts`에서 `HOME` 환경변수가 없을 때도 `~/repo` 입력이 홈 디렉터리 아래 경로로 해석되는지 검증한다.

## 3. 웹 UI 작업 상세에서 사람 확인(`humanCheck`)이 필요할 때도 확인 기록 섹션이 접혀 있음

- **증상:** AI가 직접 확인할 수 없는 완료 조건(`not_verified`)이 있는 하위 작업은 Jira 댓글과 웹 UI 작업 상세 상단 배너에서 `아래 "결과 확인·의견 남기기"에서 "결과 확인 기록"을 남기세요`라고 안내한다. 그러나 작업 상세 화면 맨 아래의 `<details><summary>결과 확인·의견 남기기 (선택)</summary>`가 기본적으로 접혀 있어, 사용자가 직접 찾아 클릭하기 전까지는 내부 UI가 로드조차 되지 않는다.
- **근거:**
  - `web/router-ui/views-issues.js:186-187` (`nextAction` 안내 문구)
  - `web/router-ui/views-issues.js:515-528` (`<details>` 생성 및 `toggle` 이벤트 시 지연 로드)
  - `web/router-ui/views-reviews.js:98-103` (`기록자 이름` 필수 입력 검사)
- **수정 방안:**
  - `views-issues.js`의 `draw(view)` 또는 `load(key)`에서 `view.delegation.humanCheck?.length > 0`이거나 미해결 `review_required` 주의 항목이 있을 때는 해당 `<details>` 요소에 `open = true`를 설정하고 즉시 `renderIssueReview`를 호출한다.
- **확인 방법:**
  - `humanCheck` 항목이 있는 이슈를 웹 UI 작업 상세(`#/tasks?issue=KEY`)로 열었을 때 하단 `결과 확인·의견 남기기` 패널이 펼쳐진 상태로 바로 렌더링되는지 확인한다.

## 4. 웹 UI 대시보드·작업 상세에 즉시 동기화(`reconcile` / PR 확인) 버튼이 없음

- **증상:** 웹훅을 받을 수 없는 로컬 환경(60초 주기 보완 조회)이나 GitHub PR 병합 직후(기본 5분 주기 폴링)에 사용자가 Jira 상태를 옮기거나 PR을 병합한 뒤 대시보드를 보고 있으면 최대 1~5분 동안 아무 변화가 없다. 즉시 조회(`POST /api/v1/admin/reconcile`)는 CLI(`ggjira router reconcile`)에밖에 없고, PR 즉시 확인(`POST /api/v1/admin/github/poll`)은 `설정 > GitHub` 화면 깊숙이 숨어 있다.
- **근거:**
  - `web/router-ui/views-status.js:67-155` (`renderDashboard`)
  - `web/router-ui/views-issues.js:598-617` (`renderIssues` 상단 타이틀 영역)
  - `web/router-ui/views-config.js:211-280` (`pullRequestList`의 `지금 확인` 버튼)
- **수정 방안:**
  - 대시보드(`views-status.js`)와 작업 상세(`views-issues.js`) 상단 타이틀 행에 **"지금 동기화"** 버튼을 추가한다.
  - 클릭 시 `POST /api/v1/admin/reconcile`(및 열린 PR이 있으면 `POST /api/v1/admin/github/poll`)을 호출한 뒤 화면을 갱신한다.
- **확인 방법:**
  - 웹 UI 대시보드와 작업 상세 화면에서 버튼을 누르면 `/api/v1/admin/reconcile` 요청이 전송되고 최신 상태가 즉시 반영되는지 확인한다.

## 5. Jira 댓글 명령(`재시도`, `재계획`, 선택지 번호)이 완전 일치만 허용하고 오입력 시 무응답

- **증상:**
  1. 계획 질문(`needs_decision`)에 담당자가 `"2번으로 해주세요"`나 `"2."`처럼 번호 외의 글자·마침표를 함께 적으면 정규식(`/^(?:\d+\s*(?:번)?|Decision:\s*\S+)$/i`)에 걸러져 아무 일도 일어나지 않는다.
  2. 실패 후 `재시도`나 자식 실행 후 `재계획` 댓글도 `comment.body.trim() === "재시도"`처럼 완전 일치만 허용하여 `"재시도."`, `"재시도합니다"` 등은 조용히 무시된다.
  3. 담당자가 아닌 사람이 답변이나 `재시도`를 남긴 경우에도 왜 실행되지 않았는지 알 수 없다.
- **근거:**
  - `src/router/planning-requests.ts:98-103` (`재계획` 완전 일치 검사)
  - `src/router/planning-requests.ts:191` (선택지 번호 댓글 정규식)
  - `src/router/planning-requests.ts:210-212` (`재시도` 완전 일치 검사)
  - `src/router/scheduler.ts` (`recovery_required` 및 실패 단계의 `재시도` 댓글 확인 로직)
- **수정 방안:**
  - `재시도`, `재계획`, 선택지 번호(`2`, `2번`) 파싱 시 앞뒤 마침표(`.`, `!`)나 공백을 허용하도록 정규식을 완화한다(일반 대화 댓글과 섞이지 않도록 단일 줄·짧은 명령 형태는 유지).
  - 질문 대기(`needs_decision`) 상태에서 질문 이후 새로운 댓글이 달렸으나 유효한 답변으로 채택되지 않은 경우, 웹 UI 작업 상세(`views-issues.js`)에 `"최근 댓글이 선택지 번호 형식(예: 2)이 아니거나 담당자 댓글이 아니어서 반영되지 않았습니다"` 힌트를 표시한다.
- **확인 방법:**
  - `test/router-board-workflow.test.ts` 및 `test/router-single-review.test.ts`에 `"2번."`, `"재시도."` 형태의 댓글이 정상 처리되는지 확인하는 테스트를 추가한다.

## 6. 이슈 설명의 `[GGJIRA:PLAN:START]` 블록 안을 직접 고쳐도 무시된다는 안내가 본문에 없음

- **증상:** 계획이 완료되면 부모 이슈 설명 아래에 `[GGJIRA:PLAN:START] ... [GGJIRA:PLAN:END]` 블록이 붙는다. 사용자가 Jira에서 계획의 완료 조건(Acceptance Criteria)이나 범위를 수정하려고 이 블록 내부 텍스트를 직접 편집하면, Router는 블록 내부를 제외한 본문으로만 입력 해시를 계산하고 계약은 DB에서 읽으므로 **재계획도 일어나지 않고 계약도 바뀌지 않는다**.
- **근거:**
  - `src/pm/plan-render.ts:95-138` (`PLAN_START`, `requirementDescription`, `renderParentPlan`)
  - `src/router/planning-requests.ts:18-27` (`planningFingerprint`)
- **수정 방안:**
  - `renderParentPlan`(`src/pm/plan-render.ts:110-138`)이 생성하는 관리 블록 첫머리에 표시 전용 안내 문구(예: `_이 영역은 GGJIRA가 자동 갱신하는 표시 전용 블록입니다. 요구사항을 수정해 다시 계획하려면 이 블록 밖(위쪽 설명)을 고치세요._`)를 추가한다.
  - 하위 작업 설명(`renderTaskDescription`)에도 계약을 바꾸려면 설명의 요구사항 부분을 수정 후 다시 요청해야 함을 명시한다.
- **확인 방법:**
  - `test/pm-plan-render.test.ts`에서 렌더링된 부모 계획 블록에 안내 문구가 포함되는지, 그리고 `requirementDescription()`이 기존과 동일하게 블록 전체를 제거하는지 확인한다.

## 7. 원격 Router 환경에서 실패 상세 로그(`data/failure-logs/*.log`)를 웹 UI에서 볼 수 없음

- **증상:** 작업이 실패하면 Jira 댓글에는 짧은 실패 코드(`GGJ-xxx`)와 함께 `자세한 내용: Router 머신의 data/failure-logs/KAN-1-<attemptId>.log` 경로만 적힌다. Docker 컨테이너나 원격 서버에서 Router를 운영하는 경우, 사용자는 실패 원인(stderr 전문, 검증 명령 실패 출력)을 보려면 서버에 접속해 파일을 직접 열어야 한다.
- **근거:**
  - `src/router/comment-text.ts:135` (`details` 문구)
  - `src/router/report-journal.ts` (`failure-log` 기록 단계)
  - `src/router/admin-service.ts` 및 `web/router-ui/views-issues.js` (실패 로그 조회 API 및 표시 UI 없음)
- **수정 방안:**
  - 관리 API에 `GET /api/v1/admin/issues/:key/failure-log`(또는 `GET /api/v1/admin/jobs/:id` 응답 내 최근 실패 로그 본문 포함, 크기 제한 적용)를 추가한다.
  - 웹 UI 작업 상세(`views-issues.js`)에서 실패한 작업이 있을 때 `<details><summary>실패 상세 로그 보기</summary><pre>...</pre></details>`로 바로 열람할 수 있게 한다.
- **확인 방법:**
  - `test/router-admin-api.test.ts`에 실패 로그 조회 API 테스트(경로 순회 방지 포함)를 추가하고, 웹 UI 작업 상세에서 렌더링을 확인한다.

## 8. 계획 단계 질문과 구현 중 질문(`implementationDecision`)의 Jira 응답 방식이 다름

- **증상:**
  - 계획 단계 질문(`decision`)은 담당자가 Jira 댓글에 선택지 번호(`2`)만 달면 자동으로 재계획된다.
  - 반면 구현 중 에이전트가 결정을 요청한 경우(`implementationDecision`)는 똑같이 질문과 선택지를 댓글로 보여주면서, **Jira 댓글로 번호를 달아도 아무 동작을 하지 않고** 반드시 이슈 설명을 수정한 뒤 상태를 `AI 계획`으로 옮겨야 한다(Slack 연동 시에는 구현 중 질문도 스레드 답변만으로 자동 재계획됨).
- **근거:**
  - `src/router/comment-text.ts:301-302` vs `317-318`
  - `src/router/planning-requests.ts:119-139` (Slack의 `implementation` 질문 답변은 재계획으로 연결하나 Jira 댓글은 미지원)
- **수정 방안 (설계 검토 후 ADR 기록 필요):**
  - 구현 중 결정 요청(`implementationDecision`) 댓글에도 `decisionOptions` 마커를 포함하고, 담당자가 Jira 댓글로 선택지 번호를 남기거나 상태를 `AI 계획`으로 옮기면 해당 답변을 포함해 재계획이 시작되도록 Jira와 Slack의 동작을 통일한다.
- **확인 방법:**
  - `test/router-board-workflow.test.ts`에서 구현 중 `needs_decision` 발생 시 담당자의 번호 댓글로 재계획이 시작되는지 검증한다.

## 9. 계획 완료 후 부모 이슈를 `AI 구현`으로 옮기면 자식 일괄 승인이 아니라 위임 철회가 됨

- **증상:** 칸반 보드에서 `AI 계획중` 바로 오른쪽 열이 `AI 구현`이다. 계획과 하위 작업이 생성된 뒤 사용자가 "계획을 승인해 구현을 시작한다"는 의도로 **부모 이슈를 `AI 구현`으로 옮기면**, 하위 작업들이 실행되는 것이 아니라 오히려 **위임 철회**로 처리된다(하위 작업을 하나씩 `AI 구현`으로 옮겨야만 실행됨).
- **근거:**
  - `docs/runbook.md:874` (§37: "부모를 작업 중으로 옮기면 새 흐름의 위임 철회로 처리된다")
  - `src/router/scheduler.ts` 및 `src/router/delegation.ts`
- **수정 방안 (설계 검토 후 ADR 기록 필요):**
  - 선택지 A(보조 안내): 부모가 `AI 계획중`에서 `AI 구현`으로 직접 옮겨졌을 때 아직 승인된 자식이 하나도 없다면, 조용히 철회하는 대신 `"구현을 시작하려면 부모가 아니라 실행할 하위 작업을 'AI 구현'으로 옮기세요"`라는 안내 댓글과 주의 항목을 남긴다.
  - 선택지 B(일괄 승인): 부모를 `AI 구현`으로 옮기면 미실행 대기 자식을 모두 승인하여 의존성 순서대로 실행한다.
- **확인 방법:**
  - 결정된 정책(선택지 A 또는 B)에 맞춰 `test/router-board-workflow.test.ts`에 부모 상태 이동 시나리오 테스트를 추가한다.
