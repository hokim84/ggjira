# pstack의 GGJIRA 적용 가능성과 효용성 분석

- 분석일: 2026-10-26
- 대상: https://github.com/backnotprop/pstack (검토 commit `fad8d01`, 2026-10-25, plugin v0.15.32, MIT)
- 범위: 원본 저장소의 스킬·자동화·하네스 문서와 GGJIRA의 현재 구현 비교
- 검증 수준: 원본 저장소 파일을 직접 읽어 확인했다. 설치, 실제 Worker 연동, AI 실행, Unity 실행은 수행하지 않음

## 결론

GGJIRA에 적용할 수 있다. 다만 pstack을 각 Worker 호스트나 AI 에이전트에 설치하지 않는다. GGJIRA Worker는 Claude Code, Codex 등 여러 AI 에이전트를 지원하는 것이 목적이므로, 모든 에이전트가 공통으로 받는 Router 프롬프트와 결과 계약을 통해 필요한 절차만 이식한다.

기존 GGJIRA와 역할이 겹치는 부분이 많다. 가장 큰 기대 효과는 작업 배정 자동화가 아니라 **AI가 완료했다고 보고한 내용을 더 잘 검증하는 것**이다. 구체적으로는 AI의 자기 보고보다 GGJIRA가 직접 실행한 증거를 판정 기준으로 삼고, AI가 보고한 증거의 종류를 구분하는 것이다. 효과와 비용에 대한 정량적 개선은 아직 검증하지 않았다.

## pstack의 성격

분석 대상 저장소는 Cursor의 pstack을 다른 실행 환경에서도 쓰도록 수정한 미러다. 주된 구성은 `SKILL.md`에 작성된 작업 절차와 일부 보조 스크립트다. README는 Claude Code와 Codex 등에서도 사용할 수 있다고 설명한다.

따라서 설치하면 즉시 독립적인 분석 기능이 생기는 서버형 플러그인보다는 AI의 조사·설계·구현·검증 방식을 바꾸는 도구 모음에 가깝다. 전체 모드인 `poteto-mode`는 개별 스킬 연결, 서브 에이전트와 모델 배정, PR 관련 작업까지 다루므로 개별 검증 스킬보다 도입 범위가 크다.

원본을 직접 확인한 결과 다음 제약이 있다.

- `setup-pstack`을 제외한 모든 스킬이 `disable-model-invocation: true`를 선언한다. AI가 스스로 골라 쓰는 것을 가정할 수 없다.
- Claude Code용 하네스 문서는 "Skill 도구는 대부분의 pstack 스킬을 거부하므로 `SKILL.md`를 Read해서 따르라"고 안내한다. 비대화형(`-p`) 실행에서는 `AskUserQuestion`이 없다.
- 스킬이 지정하는 모델은 Cursor 기준 이름(`claude-opus-5-5-xhigh`, `grok-4.7-xhigh-fast` 등)이라 실행 환경마다 변환이 필요하다.
- 버전이 빠르게 바뀐다. 검토 시점의 마지막 push가 하루 전이었다.

출처: [저장소 소개](https://github.com/backnotprop/pstack), [미러 관리 방식](https://github.com/backnotprop/pstack/blob/main/MIRROR.md), [전체 모드 정의](https://github.com/backnotprop/pstack/blob/main/skills/poteto-mode/SKILL.md), [Claude Code 하네스 문서](https://github.com/backnotprop/pstack/blob/main/docs/harness/claude-code.md)

## 후보별 효용성

"에이전트 이식성"은 모든 Worker 에이전트에 프롬프트로 전달할 수 있는지를 뜻한다. 특정 하네스 기능(서브 에이전트, 스킬 탐색, 보조 스크립트)에 의존하는 항목은 GGJIRA 개발자가 수동으로 쓰는 용도로만 남긴다.

| 후보 | GGJIRA에서의 용도 | 에이전트 이식성 | 판단 |
| --- | --- | --- | --- |
| `tdd` | 재현 가능한 버그에 실패→수정→통과 증거 확보 | 프롬프트로 이식 가능 | 구현 지침으로 이식 권장 |
| `blast-radius` | 다른 기능·DB·wire 계약에 미치는 변경 영향 확인 | 확신 단계는 이식 가능, `arena` 연계는 하네스 의존 | 확신 단계만 이식 |
| `automations/benny` | 재현·기존 수정 확인·PR 조건 규칙 | 규칙은 이식 가능, 자동화 자체는 Cursor·Slack 전용 | 규칙만 이식 |
| `interrogate` | 여러 모델의 적대적 리뷰 | 서브 에이전트 의존 | 제외(ADR 0055에서 범용 AI 리뷰 폐지) |
| `create-verification-skill` | 실제 웹 UI·CLI를 조작하는 프로젝트 전용 검증 절차 작성 | 스킬 위치가 하네스마다 다름 | 개발용으로 검토 |
| `create-formal-verification-skill`, `statechart` | 재시도·취소·상태 전이의 잘못된 순서 탐색 | Node·Java/TLC 실행 환경 필요 | 중요 영역에 한정해 별도 실험 |
| `typescript-best-practices` | 계약·경계 검증·타입 모델링 보강 | TypeScript 전용 | 개발 시 기존 규칙과 맞는 부분만 참고 |
| `how` | 복잡한 실행 흐름과 책임 경계 조사 | 서브 에이전트 의존 | 필요할 때 수동 사용 |
| `poteto-mode`, `orchestrate` | 작업 분할·에이전트 배정·진행 추적·PR 처리 | 하네스 의존, GGJIRA와 역할 충돌 | 전체 도입 비추천 |

### benny 자동화에서 가져올 규칙

`automations/benny`는 Slack 이슈 보고를 분류하고, 확인된 버그를 실제 UI로 재현하고, 범위를 제한한 수정과 draft PR까지 진행하는 Cursor 자동화다. 구조가 GGJIRA와 가장 비슷하다. Cursor Automations와 Slack 전용이라 그대로 도입할 수는 없지만 다음 규칙은 이식할 수 있다.

- 재현이 확인되지 않으면 수정 코드를 작성하지 않는다.
- 이미 고치는 PR이나 커밋이 있으면 검증 모드로 바꾸고 경쟁하는 패치를 만들지 않는다.
- 사람이 수정을 맡았다고 밝혔으면 중단한다.
- 수정 전·후 증거가 모두 있어야 PR을 연다. 컴파일, 단위 테스트, 그럴듯한 diff는 수정 후 증거가 아니다.
- 외부 게시는 coordinator만 하고 하위 작업자에게 자격 증명을 주지 않는다. 설정이 없거나 불확실하면 진행하지 않는다.

마지막 규칙은 Router만 Jira에 쓰고 Worker는 envelope만 실행하는 GGJIRA의 경계([ADR 0018](decisions/0018-router-centric-architecture.md))와 같은 원칙이다.

출처: [benny 의도 문서](https://github.com/backnotprop/pstack/blob/main/automations/benny/FOR_AGENTS.md), [재현·수정 절차](https://github.com/backnotprop/pstack/blob/main/automations/benny/skills/reproduce-and-fix-issues/SKILL.md)

### 증거 수준

`blast-radius`는 안전 근거마다 확신 단계를 밝히도록 한다. 말만 함 → 코드 줄 제시 → 실패 경로를 따라가 도달하지 않음을 보임 → 실제 코드를 실행 → 실행 중인 앱에서 재현 순서다. `orchestrate`의 검증 기록은 PR 번호와 head SHA를 키로 `live-ui-verified | unit-test-verified | type-check-only | verifier-blocked | verifier-failed` 중 하나를 남기고, head SHA가 바뀌면 기록을 무효로 본다.

GGJIRA 구현 결과의 `verification` 항목은 `{acceptance, status, evidence}`이고 `status`는 `pass | fail | not_verified`다. 테스트를 실제로 실행한 `pass`와 코드만 읽고 판단한 `pass`를 구분하지 못한다. Worker는 이 자기 보고에 검증 항목이 없거나 실패가 있으면 결과를 거절하지만, 증거의 종류는 보지 않는다.

근거: [구현 결과 계약](../src/contracts/implementation.ts), [Worker executor](../src/worker-runtime/executor.ts)

### 변경 영향 분석

`blast-radius`는 diff와 호출자 목록을 넘어 DB 필드, 직렬화 형식, 다른 언어의 소비자 등으로 추적을 넓히고 안전하다는 핵심 가정을 실제 코드로 확인하도록 한다. GGJIRA에서는 Router–Worker 계약, DB 마이그레이션, 취소·재시도 처리 변경에 유용할 것으로 판단한다.

출처: [변경 영향 분석 절차](https://github.com/backnotprop/pstack/blob/main/skills/blast-radius/SKILL.md)

### 회귀 재현과 타입 규칙

`tdd`는 명확하고 저렴한 재현 경로가 있는 버그에 집중하며, 불필요하게 큰 테스트 환경 구축을 강제하지 않는다. 실패 전 증거를 보일 수 없으면 그 이유와 대신 사용한 검증을 보고하도록 한다. GGJIRA의 기존 테스트에 작은 회귀 사례를 추가하는 방식과 잘 맞는다. TypeScript 규칙은 현재 저장소의 계약·Zod 경계 검증과 겹치는 부분이 있으므로 중복 지침이나 불필요한 전체 리팩터링을 피해야 한다.

출처: [TDD 스킬](https://github.com/backnotprop/pstack/blob/main/skills/tdd/SKILL.md), [TypeScript 스킬](https://github.com/backnotprop/pstack/blob/main/skills/typescript-best-practices/SKILL.md)

## 전체 자동화 모드와의 충돌

현재 GGJIRA는 작업의 권한과 생명주기를 이미 관리한다.

- 계획 AI는 계획만 반환하고 Router가 Jira 하위 이슈를 만든다.
- 구현은 사람이 승인한 작업 범위 안에서 진행한다.
- Git 커밋·푸시와 PR 생성은 GGJIRA가 담당한다.
- 자식 작업이 모두 끝나면 부모 통합 PR을 만들고 사람이 병합한다.
- Worker는 Jira에 직접 쓰지 않는다.

근거: [README](../README.md), [저장소 작업 규칙](../CLAUDE.md), [계획 프롬프트](../src/pm/prompt.ts), [구현 프롬프트](../src/worker/prompt.ts), [부모 통합 PR ADR](decisions/0056-parent-aggregate-pr.md)

pstack의 `orchestrate`는 자체 coordinator, 작업 상태 파일(`units.tsv`), 검증 장부(`ledger.tsv`), 에이전트 배정과 PR 진행 체계를 갖는다. 이를 그대로 넣으면 Jira/Router와 pstack 양쪽에 작업 상태와 판단 주체가 생긴다. 취소·재시도·승인 대기 시 어느 상태를 기준으로 삼을지도 해결해야 한다.

`poteto-mode`의 Autonomy 절은 "external actions (team chat, ticket updates) proceed without asking"이라고 명시한다. 이는 Router만 Jira에 쓰는 GGJIRA 원칙과 정면으로 충돌한다. 원본 전체 모드에 GGJIRA 예외를 계속 추가하면 유지 부담이 커진다. 기존 Jira 승인, Router의 웹훅·보완 조회, Worker의 long polling, 상태 전이 정책은 유지하는 것이 전제다.

출처: [오케스트레이션 정의](https://github.com/backnotprop/pstack/blob/main/skills/poteto-mode/playbooks/orchestrate.md), [전체 모드의 자율 실행 지침](https://github.com/backnotprop/pstack/blob/main/skills/poteto-mode/SKILL.md)

## 현재 Worker에 적용할 때 필요한 사항

설치만으로 현재 Worker에 적용된다고 볼 수는 없다. 기준은 특정 에이전트가 아니라 모든 Worker 에이전트가 공통으로 받는 입력이다. GGJIRA가 에이전트에게 주는 것은 Router가 envelope에 담아 보내는 역할 지침(`systemPrompt`)과 작업 프롬프트, 결과 JSON schema, 작업용 worktree뿐이다.

에이전트마다 다른 부분은 다음과 같다.

| 항목 | Claude Code | Codex |
| --- | --- | --- |
| 역할 지침 전달 | `--append-system-prompt` | 작업 프롬프트 앞에 이어 붙임 |
| JSON 결과 강제 | `--json-schema` | 프롬프트 안내 후 fenced JSON 파싱 |
| 명령 실행 | 기본 도구(`Edit, Write, Read, Glob, Grep`)로는 불가 | `workspace-write` 샌드박스에서 가능 |
| 스킬 탐색 위치 | `.claude/skills/` | `.agents/skills/` |

| 현재 구현에서 확인한 사실 | 도입 시 필요한 확인 |
| --- | --- |
| 모든 에이전트가 같은 Router 프롬프트와 결과 JSON 계약을 받음 | 이식한 절차의 보고 내용을 기존 출력 계약 안에 담음 |
| 에이전트마다 명령 실행 가능 여부가 다름 | 실행 증거를 무조건 요구하지 않고, 실행하지 못했으면 그렇다고 보고하게 함 |
| Worker는 Router에 provider의 실행 능력을 보고하지 않음(`providerId`, `providerType`, 사용량만 보고) | 실행 능력 협상을 새로 만들기보다 증거 종류를 결과에 표시하는 방식 우선 |
| 검토한 주요 스킬은 `disable-model-invocation: true` 선언 | 스킬 호출을 가정하지 않고 필요한 절차를 프롬프트에 직접 넣음 |
| 작업은 별도 worktree에서 실행됨 | 호스트 설치 스킬에 의존하지 않음 |

근거: [provider 설정](../src/contracts/provider.ts), [provider 인터페이스](../src/worker/provider.ts), [Claude Code 실행](../src/worker/claude-code-cli.ts), [Codex 실행](../src/worker/codex-cli.ts), [Worker API 계약](../src/contracts/api.ts), [Worker executor](../src/worker-runtime/executor.ts)

pstack을 각 호스트에 설치하는 방식은 권하지 않는다. 에이전트 종류와 머신에 따라 같은 job이 다르게 실행되고, 호스트 스킬이 자동 갱신되면 같은 입력에도 절차가 달라진다. 버전 고정과 재현성도 Worker 수만큼 따로 관리해야 한다. provider 설정에 스킬 선택·버전 항목을 추가하는 것도 같은 이유로 맞지 않는다. 이식한 지침은 Router 역할 지침으로 GGJIRA 저장소가 소유하고, 출처 commit을 함께 기록한다. 기존 취소·lease·timeout·결과 보고 경계도 유지해야 한다.

### GGJIRA 자체 개발과 Worker 기본 기능의 차이

**GGJIRA 자체 개발에 사용하는 것**은 비교적 간단하다. 개발자가 필요한 스킬을 명시적으로 호출하고 기존 저장소 규칙에 맞춰 결과를 검증하면 된다. 서브 에이전트를 쓰는 스킬(`arena`, `swarm`, `interrogate`, `how`, `why`), 스킬 탐색, `statechart` 스크립트는 이 용도로만 남긴다.

**모든 Jira 작업을 수행하는 Worker 기본 기능으로 넣는 것**은 추가 설계가 필요하다. 모든 에이전트에서 성립하는 절차만 골라 Router 프롬프트와 결과 계약으로 전달해야 한다. 우선 작은 지침으로 효용을 확인한 후 확대하는 편이 적절하다.

## 적용 상태

2026-10-26에 1·2·3·5단계를 [ADR 0059](decisions/0059-trusted-validation-and-evidence-method.md)로 구현했다.

| 단계 | 구현 |
| --- | --- |
| 1 | 구현 job의 `validateCommand`에 취소 신호·timeout 적용, 실행되지 않은 결과에 즉시 검토 사유 `no_trusted_validation` 추가(완료·조립 조건은 그대로), `worker check` 경고, 실패 로그에 검증 출력 기록 |
| 2 | 검증 항목에 `method`(`executed`·`inspected`) 추가. provider 스키마는 필수, Zod는 선택·관대. 검토 집계와 댓글·UI·CLI 표시 |
| 3 | 기본 구현 지침에 증거 방식·실행 불가 시 정직한 보고·버그 수정의 실패 먼저 확인·증거 밖 수정 금지·소비자 확인 추가(추가 지침이 아니라 기본 지침) |
| 4 | 제외. ADR 0055에서 범용 AI 품질 검토를 폐지했다 |
| 5 | Skill 대신 에이전트 공통 문서인 [runbook §46](runbook.md)으로 작성. Codex용 `AGENTS.md`가 CLAUDE.md와 §46을 가리킨다 |
| 6 | 미착수 |

## 권장 도입 순서

### 1. GGJIRA가 직접 실행한 증거를 판정 기준으로 강화

pstack의 핵심 원칙은 자기 보고를 믿지 말고 실제 결과로 확인하라는 것이다. 에이전트가 여럿이면 각 에이전트의 `pass`가 같은 의미라는 보장도 없다. 에이전트와 무관한 증거는 GGJIRA가 AI 실행 후 worktree에서 직접 실행하는 저장소별 `validateCommand`다. 이를 판정 기준으로 강화하고 AI의 `verification`은 보조 설명으로 둔다.

근거: [검증 명령 실행](../src/worker/validate.ts)

### 2. 검증 증거에 확인 방식 표시

`verification` 항목에 확인 방식(`executed | inspected`, 미검증은 기존 `status`의 `not_verified`)을 추가하는 것을 검토한다. 명령을 실행할 수 없는 에이전트도 코드만 읽고 판단했다고 정직하게 보고할 수 있고, Router와 실행 능력을 협상하는 기능을 새로 만들 필요가 없다. provider별 실제 실행 비율도 비교할 수 있다. Router–Worker wire 계약 변경이므로 실제 도입 시 ADR을 남긴다.

### 3. 구현 추가 지침에 이식 가능한 절차 적용

버그 작업에는 재현 증거, 계약 변경에는 변경 영향 확인을 요구한다. benny 규칙과 `tdd`의 실패 전 증거 원칙을 추린다. 2단계와 함께 "실행할 수 있으면 실행 증거를, 그렇지 않으면 코드 판단이라고 밝힌다"고 써야 모든 에이전트에서 성립한다. 실행 증거를 무조건 요구하면 명령 실행이 안 되는 에이전트에게 꾸며낸 증거를 유도한다.

기존 `설정 → 프롬프트`의 구현 추가 지침으로 시험할 수 있으므로 처음부터 새로운 설정 화면이나 실행 엔진을 추가할 필요는 없다. 다만 추가 지침은 모든 프로젝트와 Worker에 공통으로 적용된다. 작업 유형별로 지정할 수 없으므로 버그인지 계약 변경인지는 AI가 판단해야 한다. Git·PR·Jira 상태 조작 권한은 기존 GGJIRA가 계속 담당한다.

근거: [역할별 프롬프트 화면](../web/router-ui/views-prompts.js), [역할별 추가 지침 ADR](decisions/0054-role-prompt-additions.md)

### 4. 구현과 품질 검토를 다른 에이전트로 실행 (제외)

pstack은 검증을 맡는 에이전트를 구현 에이전트와 다른 계열 모델로 실행하라고 한다(`orchestrate`, `interrogate`). 그러나 GGJIRA는 [ADR 0055](decisions/0055-fci-and-pr-history.md)에서 범용 AI 품질 검토를 폐지했고, `quality_review`는 Router가 envelope를 만들지 않고 Worker도 거절한다. 현재 `integration_check`는 AI를 호출하지 않는 검증이다. 또 `providerId`는 job 종류가 아니라 Worker 정책 단위로 지정된다. AI 리뷰를 다시 도입하는 결정이 먼저 있어야 하므로 이번 범위에서 제외한다.

근거: [Router 설정의 Worker 정책](../src/router/config.ts), [Router envelope](../src/router/envelope.ts)

### 5. GGJIRA 개발용 검증 절차 작성

`create-verification-skill`을 참고해 격리된 테스트 인스턴스에서 UI·CLI를 확인하는 절차를 저장소에 둔다. Fake Jira만 사용하고, 실제 Jira 쓰기가 필요한 검증은 별도로 명시한다. `docs/runbook.md`의 수동 절차를 원재료로 삼아 실행 방법과 사용자 경로, 관찰 가능한 결과, 증거 위치, 정리 방법을 함께 기록한다. 한 번 실제로 실행해 본 뒤에 완성으로 본다. Worker 기능과는 무관한 개발자용이다.

출처: [검증 스킬 정의](https://github.com/backnotprop/pstack/blob/main/skills/create-verification-skill/SKILL.md)

### 6. 상태 전이 검증을 별도 실험으로 진행

다음과 같은 속성을 작은 모델로 검증할 수 있다.

- 승인 취소 후 푸시가 발생하지 않는다. 대응 코드: Worker executor의 `authorize("commit" | "validate" | "push")` 단계 확인
- 동일 결과 재전송으로 중복 처리가 발생하지 않는다. 대응 코드: Router의 결과 수신(`worker-service.ts`)과 보고 저널(`report-*.ts`)
- lease 만료와 결과 수신의 순서가 바뀌어도 권한 정책을 지킨다. 대응 코드: Router의 job/attempt 상태 머신(`src/contracts/`)과 복구

모델 검증 통과는 실제 구현 전체의 정확성을 보증하지 않는다. 모델의 가정·범위와 실제 코드의 대응을 확인해야 한다. `statechart`는 첫 실행 시 mise로 Java와 TLC(약 305MB)를 내려받으므로 추가 실행 환경과 네트워크가 필요하다.

출처: [형식 검증 절차](https://github.com/backnotprop/pstack/blob/main/skills/create-formal-verification-skill/SKILL.md), [상태도 도구](https://github.com/backnotprop/pstack/blob/main/skills/statechart/SKILL.md)

## C#·Unity에 대한 적용성

조사·재현·영향 분석 절차 자체는 C#·Unity 작업에도 적용할 수 있다. 하지만 Unity Editor 실행, EditMode/PlayMode 테스트, 빌드 검증은 해당 프로젝트의 도구와 절차를 별도로 준비해야 한다. TypeScript 전용 스킬의 규칙이 C# 지원을 제공하는 것은 아니다. 구현 추가 지침은 모든 프로젝트에 공통 적용되므로, 이식한 절차는 C#·Unity 프로젝트에서도 성립하는 표현으로 써야 한다.

## 기술부채 추이와의 관계

pstack의 AI 판단을 기존 구조 부채 지수에 섞는 것은 권하지 않는다. 변경 영향 설명과 개선 제안을 보강하는 데 활용하되 결정적 측정값, 평가 버전, 기존 시계열은 유지한다.

FCI는 실험적 상대 지표이며 검증된 개발 시간·비용 증가율이나 장애 확률이 아니다. pstack의 평가나 분석 실패를 PR 승인·병합·Jira 상태 전이의 새로운 차단 조건으로 추가하지 않는다.

근거: [현재 FCI 계산·운영 문서](fci.md), [정적 FCI 이력 ADR](decisions/0057-static-fci-history.md)

## 효용성 검증과 미검증 항목

권장 판단은 **GGJIRA가 직접 실행한 증거와 증거 종류 표시를 먼저 갖추고, 그 위에서 이식한 구현 지침의 효과를 확인**하는 것이다.

파일 수나 스킬 사용 횟수보다 다음을 비교해야 한다.

- 실패 전·수정 후 재현 증거가 충분한가.
- 기존 검증에서 놓친 회귀나 계약 위반을 발견했는가.
- 결과 보고가 기존 JSON 계약을 지키는가.
- 추가 실행 시간과 토큰 사용량이 얻은 효과에 비해 적절한가.
- 취소·timeout·재시도와 기존 승인 경계를 유지하는가.

같은 지침이라도 에이전트마다 효과가 다를 수 있으므로 도입 전후를 provider(`providerType`)별로 나눠 비교한다. 실행 기록(provider, model, usage)과 품질 검토 findings가 이미 있으므로 이를 측정에 사용할 수 있다.

이번 분석은 원본 저장소 파일과 현재 저장소 코드 비교까지 수행했다. 플러그인 설치, 실제 Worker의 지침 적용·실행, 서브 에이전트 권한·사용량 집계, 형식 검증 도구 실행, Unity 실행 및 비용·품질 개선은 검증하지 않았다.

외부 링크는 변경 가능한 `main` 브랜치를 가리킨다. 이 분석은 commit `fad8d01` 기준이다. 실제 도입 시 선택한 원본 commit과 의존 스킬을 고정하고 재검토해야 한다.
