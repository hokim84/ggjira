# GGJIRA MVP 구현 계획

> 원문: `writing-block.md`. "Codex"는 모두 Claude Code로 읽는다. 구현 실행자는 Claude Code(Sonnet).
> 이 문서는 다른 Claude 세션이 그대로 받아 구현할 수 있도록 작성한다. 함수/클래스 단위 설계는 구현 단계에 남긴다.

---

## Context

GGJIRA는 인간과 AI Agent가 Jira를 공용 작업 인터페이스로 사용하는 경량 오케스트레이션 시스템이다. 현재 저장소는 `writing-block.md` 한 파일만 있고 git도 초기화되어 있지 않다. 이번 계획의 목표는 **Jira Issue → GGJIRA → Worker(Claude Code CLI) → 결과 → Jira 기록**의 vertical slice를 최단 경로로 완성하는 실행 가능한 로드맵을 확정하는 것이다.

계획 수립 중 사용자와 확정한 결정:

| 항목 | 결정 |
|---|---|
| 언어/런타임 | TypeScript, Node 20 |
| Jira | Jira Cloud |
| 이벤트 수신 | **JQL Polling으로 시작** (원문의 Webhook 구조와 다름, §4에서 차이 설명) |
| Worker 대상 | 단일 로컬 저장소(설정으로 경로 지정), 결과는 Jira 댓글로 기록. push/PR은 MVP 이후 |

---

## 1. Repository 조사 결과

- 파일: `writing-block.md` 1개. 코드/설정/CI/문서 없음. git 미초기화.
- 글로벌 `~/.claude/CLAUDE.md` 없음. 프로젝트 메모리 없음.
- 로컬 환경: Node v20.20.0, npm 11.10, Python 3.13 + uv 0.9, **Claude Code CLI 2.1.258**. pnpm/bun/go/docker/gh/codex 없음.
- Claude Code CLI headless 옵션 확인(`claude --help`): `-p/--print`, `--output-format json|stream-json`, `--permission-mode acceptEdits|dontAsk|bypassPermissions|...`, `--allowedTools`/`--disallowedTools`, `--tools`, `--json-schema`, `--session-id`, `--resume`, `--no-session-persistence`, `--model`, `--effort`, `--append-system-prompt`, `--add-dir`, `--worktree`, `--bare`(OAuth 미사용 → 구독 인증 시 사용 금지), `--max-budget-usd`(API key 전용). `--max-turns` 옵션은 이 버전에 없음 → 상한은 GGJIRA 쪽 timeout으로 통제.

기존 결정과 충돌하는 항목은 없다. 다만 원문은 Webhook 기반 흐름을 "합의된 기본 구조"로 명시했는데, 사용자 결정으로 MVP는 Polling으로 시작한다.

## 2. 현재 프로젝트 이해

- Jira = Human/Agent 공용의 **공식 작업 상태**. GGJIRA 내부 상태는 보조이며, 충돌 시 Jira를 우선한다.
- MVP의 가치는 "사람이 Jira에서 티켓을 AI에 넘기면, 잠시 후 결과와 변경 브랜치가 Jira 댓글로 돌아온다"이다.
- PM Agent(작업 분해)는 MVP 이후. 단, PM Agent도 결국 "이슈를 입력받아 Worker를 돌리는 Job"이므로 Job/Provider 경계만 잘 잡으면 자연스럽게 확장된다.
- 관찰 가능성: 실패 시 "Jira 수신 / Job 상태 전이 / Worker 프로세스 / Jira 기록" 중 어느 계층인지 로그와 디스크 기록으로 추적 가능해야 한다.

## 3. 제안 기술 스택

| 요소 | 선택 | 이유 |
|---|---|---|
| 언어 | TypeScript (strict, ESM) | 사용자 결정. stream-json 파싱/타입 기반 Job 모델에 적합, Sonnet 구현 안정성 높음 |
| Runtime | Node 20 (`.nvmrc`) | 설치되어 있음. 전역 `fetch` 내장 → HTTP 클라이언트 의존성 불필요 |
| 패키지 관리 | npm | 설치되어 있는 것 사용. lockfile 커밋 |
| Web server | **MVP에서는 없음** | Polling 방식이라 수신 서버 불필요. Webhook 단계(Post-MVP)에서 Hono 추가 |
| Jira 연동 | 직접 작성한 얇은 REST 클라이언트 (`fetch` + Basic auth: email + API token) | 필요한 호출은 4~5개(JQL search, get issue, add comment, get transitions, transition, label 수정). SDK는 추상화 비용만 늘림. **REST API v2 사용**: v3는 댓글 본문이 ADF(JSON 문서)라 복잡. v2는 Jira Cloud에서 여전히 지원되고 평문/wiki markup 댓글 가능. JQL 검색은 `/rest/api/2/search/jql`(구 `/search`는 deprecated) → M1 스파이크에서 검증 |
| 내부 Job 모델 | 명시적 상태 머신: `queued → claimed → running → succeeded / failed / timed_out / cancelled` | 어느 계층에서 실패했는지 상태로 드러나야 함. 상태 전이 함수 하나에 집중 |
| Worker 실행 | `child_process.spawn("claude", ["-p", ...])`, `--output-format stream-json`, GGJIRA가 만든 git worktree에서 실행 | 구독형 CLI 그대로 사용(원칙 8). 프로세스 제어(timeout/kill)를 GGJIRA가 소유 |
| Provider 경계 | `WorkerProvider` 인터페이스 1개 + `ClaudeCodeCliProvider` 구현 1개 + 테스트용 `FakeProvider` | 원칙 6·7. 향후 Codex CLI 등 교체 지점. 인터페이스는 `run(request, {signal, onEvent}) → WorkerResult` 수준으로만 |
| 설정 | `.env`(비밀: Jira 토큰) + `ggjira.config.json`(비밀 아님: JQL, 대상 repo, 폴링 주기, 상태 전이명 등). `zod`로 스키마 검증 후 부팅 | 비밀과 설정 분리. 부팅 시점에 잘못된 설정을 즉시 실패시킴 |
| Logging | `pino` (JSON 로그), `jobId`/`issueKey` child logger. 실행별 로그를 `runs/` 디렉터리에 파일로도 저장 | 계층별 추적(원칙 11). Claude가 실패 원인을 파일로 읽을 수 있음 |
| Persistence | **파일 기반**: `data/runs/<ISSUE-KEY>/<runId>/{job.json, worker.jsonl, summary.md}` + `data/state.json`(claim 기록) | SQLite는 Node 20에서 native 빌드 필요. MVP 동시성 1이면 파일로 충분. 사람이 읽을 수 있는 실행 기록 자체가 관찰 가능성 도구. 쿼리/동시성 필요 시 SQLite로 이전 |
| Test | `vitest` | TS 네이티브, 빠름. 외부 의존(Jira/claude)은 인터페이스 뒤에 두고 Fake로 대체 |
| Lint/Format | `biome` | 도구 하나로 lint+format. 설정 파일 하나. eslint+prettier 조합보다 단순 |
| CI | GitHub Actions: `npm ci && npm run check` (typecheck + lint + test) | 원격 저장소가 GitHub이라는 가정. 아니면 동일 명령을 로컬 pre-push로 대체 |
| CLI | `ggjira <command>` 진입점 (`commander` 또는 Node `util.parseArgs`) | `run`(데몬), `once`(1회 폴링), `jira:smoke`, `worker:run`, `status` 등 검증용 명령이 Claude의 자가 검증 수단 |

## 4. 시스템 아키텍처

### MVP 흐름

```
Human (Jira에서 이슈 생성 + 트리거 라벨/상태 지정)
  → Jira Cloud
  → [Poller] JQL 주기 조회 (예: project = X AND labels = ggjira AND status = "To Do")
  → [Job] 생성(queued) → claim: Jira transition "In Progress" + 댓글 "GGJIRA 시작"  (claim 실패 = 다른 주체가 이미 처리 → skip)
  → [WorkerProvider: ClaudeCodeCli] git worktree 생성 → claude -p 실행 → stream-json 이벤트 수집 → timeout/kill
  → [Reporter] 결과 요약 + 브랜치명 + 변경 파일 + 실행 로그 위치를 Jira 댓글로 기록, 성공 시 transition(설정값, 예 "In Review"), 실패 시 라벨 `ggjira-failed` + 댓글
  → runs/ 디렉터리에 전체 기록 저장
```

### 원문(Webhook)과의 차이

- 원문: Jira → Webhook → GGJIRA. 본 계획: Jira → **Polling** → GGJIRA.
- 이유: 개발 머신이 외부 접근 불가하고 터널 운영 비용이 MVP 가치와 무관. Polling은 놓친 이벤트 복구가 자연스럽고 재시작에 강함.
- 확장 대비: 수신 경로를 `IssueSource`(=`poll(): Issue[]`) 한 경계로만 분리한다. Post-MVP에 Webhook 수신 서버를 추가해도 Job 이후 흐름은 동일. 인터페이스를 미리 복잡하게 만들지 않는다.

### 계층과 실패 추적

| 계층 | 책임 | 실패 신호 |
|---|---|---|
| jira | REST 호출, 인증, 에러 매핑 | `JiraApiError`(status, endpoint) |
| poller | JQL 조회 → 후보 이슈 → Job 큐 | 로그 `poll.error` |
| job | 상태 머신, claim, 재시작 복구, 디스크 기록 | `job.json.status` + `failureStage` 필드 |
| worker | 프로세스 spawn, 이벤트 스트림, timeout/kill, worktree | `WorkerResult.exitReason`(completed/timeout/crashed/nonzero) |
| reporter | 결과 → Jira 댓글/transition/라벨 | `reporter.error` (Worker 성공이라도 Jira 기록 실패를 별도 상태로) |

### 동시성 (MVP)

- `maxConcurrentJobs = 1`. 큐는 메모리 배열. 재시작 시 `data/state.json`과 Jira 상태로 복구.
- 이중 처리 방지: (a) claim 시 Jira transition이 성공한 주체만 진행, (b) 로컬 `state.json`에 `issueKey → runId` 기록, (c) JQL 자체가 "To Do"만 조회하므로 In Progress로 넘어간 이슈는 재조회되지 않음.

## 5. Repository 구조

```
ggjira/
├── CLAUDE.md                 # Claude Code 작업 규칙, 명령, 완료 기준 (원문의 AGENTS.md 역할)
├── README.md                 # 무엇인지, 설치/설정/실행 3단계
├── docs/
│   ├── architecture.md       # §4 내용을 유지보수. 흐름도 + 계층 + 상태 머신
│   ├── decisions/            # ADR-lite: 0001-polling-over-webhook.md, 0002-jira-api-v2.md ...
│   └── runbook.md            # 실패 시 어디를 보는가 (runs/ 구조, 로그 필드)
├── .env.example
├── ggjira.config.example.json
├── package.json / tsconfig.json / biome.json / vitest.config.ts / .nvmrc
├── .github/workflows/ci.yml
├── src/
│   ├── cli.ts                # 진입점: run | once | jira:smoke | worker:run | status
│   ├── config.ts             # env + config.json 로드 + zod 검증
│   ├── logger.ts
│   ├── jira/                 # client.ts (REST), types.ts
│   ├── poller/               # jql 폴링 → 후보 이슈
│   ├── job/                  # job.ts (상태 머신), store.ts (runs/ 파일 기록), runner.ts (orchestration)
│   ├── worker/               # provider.ts (인터페이스), claude-code-cli.ts, fake.ts, worktree.ts, prompt.ts
│   └── reporter/             # 결과 → Jira 댓글/transition
├── test/                     # 단위 + Fake 기반 e2e
└── data/                     # .gitignore. runs/, state.json
```

- `src/` 하위 디렉터리는 §4의 계층과 1:1. 계층 = 디렉터리 = 로그 네임스페이스로 통일해 추적성을 확보한다.
- `pm/`, `providers/codex/`, `web/` 같은 미래 전용 디렉터리는 만들지 않는다.

## 6. Claude 개발 환경 (원문의 "Codex 개발 환경")

| 항목 | 계획 |
|---|---|
| `CLAUDE.md` | 프로젝트 목적 3줄, 디렉터리 = 계층 규칙, 명령(`npm run check`, `dev`, `test`), "완료의 정의"(check 통과 + 해당 milestone 검증 명령 실행 + 문서/ADR 갱신), 외부 호출 금지 규칙(테스트에서 실제 Jira/claude 호출 금지, smoke 명령으로만), 결정 변경 시 `docs/decisions/`에 기록 |
| README | 설치 → `.env`/config 작성 → `ggjira jira:smoke` → `ggjira once` 순서 |
| architecture 문서 | `docs/architecture.md`. 코드 변경으로 흐름이 바뀌면 같은 PR에서 갱신 |
| 설계 결정 기록 | `docs/decisions/NNNN-제목.md` (Context / Decision / Consequences 3절). 본 계획의 결정을 0001~0004로 초기 기록 |
| 환경변수 예제 | `.env.example`: `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`. 나머지는 `ggjira.config.example.json` |
| 명령 | `npm run typecheck` / `lint` / `format` / `test` / `check`(전부) / `dev`(tsx로 실행) / `build` |
| CI | `ci.yml`: Node 20, `npm ci`, `npm run check` |
| 자가 검증 방법 | (1) `npm run check` (2) Fake provider + Fake Jira로 도는 e2e 테스트 (3) 실환경 검증용 CLI: `jira:smoke <KEY>`, `worker:run --prompt`, `once --dry-run` (4) `data/runs/` 산출물 확인. 각 Jira Task의 AC가 이 중 무엇으로 확인되는지 명시 |
| Memory/Skill/MCP/Subagent | **지금은 도입하지 않음.** Jira 접근은 코드 자체가 클라이언트이므로 Atlassian MCP 불필요. 반복되는 검증 절차가 생기면 그때 `.claude/skills/`에 추가 검토 |

## 7. MVP 범위 / Non-goals

### MVP (반드시)

- Jira Cloud JQL 폴링으로 트리거 이슈 감지
- Job 상태 머신 + 디스크 기록 + 재시작 시 이중 실행 방지
- Claude Code CLI Worker 1개 Provider: worktree 격리, 프롬프트 생성(이슈 제목/설명/댓글 포함), timeout/kill, stream-json 수집, 커밋
- 결과를 Jira 댓글로 기록(요약, 브랜치, 변경 파일, 실행 ID) + 성공/실패 transition/라벨
- 관찰 가능성: 구조화 로그, `runs/` 산출물, `ggjira status`
- 문서/CI/자가 검증 명령

### MVP 이후 (근시일)

- Webhook 수신(Hono) + 터널, Polling은 복구용으로 유지
- 원격 push + PR 생성(GitHub API), PR 링크를 Jira에 기록
- 동시 실행 N개, 이슈별 대상 저장소 지정
- 인간이 Jira에서 취소(상태 되돌림) 시 실행 중 Worker 중단
- 실패 자동 재시도 정책, 비용/턴 상한

### 장기 확장 가능성

- PM Agent: Epic → Sub-task 분해, 의존성, Worker 선택
- 다중 Provider(Codex CLI 등), 검증 Agent 단계
- SQLite 등 저장소 교체, 대시보드 UI

### Non-goals

- Web UI/SaaS, 멀티 테넌트, 인증 서버
- Agent 내부 실행 계획을 Jira 티켓으로 생성
- Jira 워크플로우 자동 구성(상태/전이는 사람이 만들고 GGJIRA는 이름으로 참조)

## 8. Milestone별 구현 계획

### M0. 저장소 부트스트랩

- **목표**: Claude가 안정적으로 작업할 수 있는 뼈대와 검증 루프.
- **구현 대상**: `git init`, package.json(ESM, scripts), tsconfig(strict), biome, vitest, `.nvmrc`, `.gitignore`(data/, .env), `src/cli.ts`(help만), `config.ts`+zod 스키마, `logger.ts`, `CLAUDE.md`, README 골격, `docs/architecture.md`(본 §4 이식), ADR 0001~0004, `.env.example`, `ggjira.config.example.json`, CI.
- **완료 조건**: `npm run check` 통과. `npx ggjira --help` 출력. 잘못된 config로 부팅 시 zod 에러로 즉시 실패하는 테스트 존재.
- **테스트**: config 로드/검증 단위 테스트. CI green.
- **다음 단계 의존**: 모든 milestone이 이 검증 루프와 config/logger를 사용.

### M1. Jira 클라이언트 + 실환경 스파이크

- **목표**: Jira Cloud 연동 4가지 호출의 실제 동작 확인 및 API 버전 결정 고정.
- **구현 대상**: `jira/client.ts` — `searchIssues(jql)`, `getIssue(key)`, `addComment(key, text)`, `getTransitions(key)`, `transition(key, name)`, `addLabel/removeLabel`. 에러 → `JiraApiError`. CLI `jira:smoke <KEY>`: 이슈 조회 → 테스트 댓글 → transition 목록 출력.
- **완료 조건**: 실제 프로젝트 이슈에 대해 `jira:smoke` 성공. `/search/jql` 엔드포인트와 v2 댓글이 동작함을 확인해 ADR 0002 확정. 클라이언트 단위 테스트(fetch mock)로 요청 형태/에러 매핑 검증.
- **테스트**: 단위(fetch mock) + 수동 smoke.
- **다음 단계 의존**: M3의 claim/reporter가 이 클라이언트 사용.

### M2. Worker Provider 스파이크 (Claude Code CLI)

- **목표**: 데몬 프로세스에서 `claude -p`를 안정적으로 spawn/수집/종료할 수 있음을 증명.
- **구현 대상**: `worker/provider.ts`(인터페이스 + `WorkerRequest`/`WorkerResult`/`WorkerEvent` 타입), `worker/claude-code-cli.ts`(spawn, stream-json 라인 파싱, 최종 `result` 메시지 추출, timeout → SIGTERM → 유예 후 SIGKILL, 프로세스 그룹 종료), `worker/worktree.ts`(대상 repo에 `git worktree add -b ggjira/<KEY>-<runId>` 생성/정리), `worker/prompt.ts`(이슈 → 프롬프트 템플릿), `worker/fake.ts`. CLI `worker:run --prompt "..." [--timeout]`.
  - 권장 실행 옵션: `-p --output-format stream-json --verbose --permission-mode acceptEdits --allowedTools "Edit Write Read Glob Grep Bash(git *) Bash(npm *)" --no-session-persistence --model sonnet --append-system-prompt <작업 규칙>`. 구체 값은 config로.
  - Worker가 작업 후 `git commit`까지 하도록 프롬프트에 명시하거나, GGJIRA가 실행 후 `git add -A && git commit`으로 마무리 (구현 시 결정, 후자 권장: 결정론적).
- **완료 조건**: 대상 repo 워크트리에서 간단한 작업(예: README에 한 줄 추가) 실행 → 커밋 생성 → `WorkerResult{summary, exitReason, changedFiles, branch, durationMs, costHint?}` 반환. timeout 시 프로세스가 남지 않음(`ps`로 확인). stdout 이벤트가 `worker.jsonl`로 저장됨.
- **테스트**: 파서 단위 테스트(샘플 stream-json 픽스처), timeout 테스트(가짜 실행 파일 `sleep`로 대체), 수동 `worker:run`.
- **다음 단계 의존**: M3 runner가 provider 인터페이스만 사용.

### M3. Vertical Slice (end-to-end)

- **목표**: Jira 이슈 → 폴링 → Job → Worker → Jira 댓글까지 실제 동작.
- **구현 대상**: `poller/`(JQL 주기 조회), `job/job.ts`(상태 머신), `job/store.ts`(runs/ 기록, state.json), `job/runner.ts`(claim → worktree → provider.run → reporter → 정리), `reporter/`(댓글 템플릿: 요약/브랜치/변경 파일/runId/로그 경로, transition, 실패 라벨). CLI `run`(데몬), `once`(한 사이클), `status`(state.json + 최근 runs 요약).
- **완료 조건**: 실제 이슈에 트리거 라벨을 달면 수 분 내 (1) In Progress 전이 + 시작 댓글 (2) 로컬 브랜치에 커밋 (3) 결과 댓글 + 성공 transition. 실패 케이스(Worker 비정상 종료)에서 실패 댓글 + `ggjira-failed` 라벨. Fake Jira + Fake Provider로 동일 흐름의 e2e 테스트 통과.
- **테스트**: e2e(Fake) 자동 + 실환경 수동 1회 성공/1회 실패 시나리오.
- **다음 단계 의존**: M4는 이 흐름을 깨지 않고 견고화.

### M4. 견고화 + 관찰 가능성 + 문서

- **목표**: 실제 사용 가능한 수준의 안정성.
- **구현 대상**: 재시작 복구(state.json에 running으로 남은 Job → Jira 상태 확인 후 failed 처리 및 댓글), Jira API 일시 오류 재시도(지수 백오프, idempotent 호출만), Worker 성공 + Jira 기록 실패 분리 상태, 워크트리 정리 정책(성공 시 유지/실패 시 유지, N일 후 정리 명령), `runbook.md`, `status` 출력 개선, 로그 필드 표준화(`layer`, `issueKey`, `runId`, `stage`).
- **완료 조건**: 데몬을 실행 중 kill → 재시작 시 이중 실행 없이 복구. 3개 이슈를 순차 처리하며 runs/ 기록이 각각 완결. runbook만 보고 실패 원인 계층을 찾을 수 있음.
- **테스트**: 복구 시나리오 단위/e2e, 수동 kill 테스트.
- **다음 단계 의존**: Post-MVP(Webhook, PR)는 poller/reporter 경계에 추가.

## 9. 초기 Jira Task 목록

**Epic: GGJIRA MVP — Jira → Claude Code Worker → Jira vertical slice**

| # | 제목 | 목적 | 구현 범위 | Acceptance Criteria | 의존 |
|---|---|---|---|---|---|
| T1 | 저장소 부트스트랩 및 개발 환경 | M0 | git init, TS/biome/vitest/CI, CLAUDE.md, README, architecture.md, ADR 0001~0004, config/logger | `npm run check` green(CI 포함), `ggjira --help`, 잘못된 config 부팅 실패 테스트 | 없음 |
| T2 | Jira Cloud REST 클라이언트 | M1 | search/get/comment/transitions/transition/label, 에러 매핑, `jira:smoke` | 실이슈 smoke 성공, fetch mock 단위 테스트, ADR 0002에 API 버전 확정 | T1 |
| T3 | Worker Provider 인터페이스 + Fake | M2 | provider.ts 타입, fake.ts, `WorkerResult` 규격 | Fake로 성공/실패/timeout 결과를 만들 수 있음, 타입 테스트 | T1 |
| T4 | Claude Code CLI Provider | M2 | spawn/stream-json 파싱/timeout·kill/worktree/prompt, `worker:run` | 실제 워크트리에서 커밋 생성, timeout 시 잔존 프로세스 0, worker.jsonl 저장, 파서 픽스처 테스트 | T3 |
| T5 | Job 상태 머신 + 파일 저장소 | M3 | job.ts, store.ts, state.json, `status` | 전이 규칙 단위 테스트, runs/ 레이아웃 문서화, 재시작 후 claimed 이슈 재실행 안 함 | T1 |
| T6 | Poller + Runner + Reporter (E2E) | M3 | poller, runner, reporter, `run`/`once` | Fake e2e 통과, 실이슈 성공/실패 시나리오 각 1회 확인(댓글·transition·라벨) | T2, T4, T5 |
| T7 | 재시작 복구 및 오류 처리 | M4 | running 잔존 복구, 백오프, 기록 실패 분리 상태 | kill→재시작 이중 실행 없음, 복구 테스트 | T6 |
| T8 | Runbook 및 관찰 가능성 정리 | M4 | runbook.md, 로그 필드 표준, status 개선 | runbook으로 실패 계층 식별 가능, 3건 순차 처리 기록 확인 | T6 |

## 10. 기술적 위험 및 검증 방법

### MVP에서 반드시 검증

| 위험 | 내용 | 검증 (어느 milestone) |
|---|---|---|
| 구독 인증의 비대화형 실행 | 데몬(비TTY)에서 spawn된 `claude -p`가 키체인 OAuth 자격증명을 읽을 수 있는지. `--bare`는 OAuth를 읽지 않으므로 사용 불가 | M2 `worker:run`을 `nohup`/launchd 하에서 실행해 확인 |
| 권한 프롬프트로 인한 hang | headless에서 허용되지 않은 도구 사용 시 멈춤/거부 동작 | M2: `--permission-mode` + `allowedTools` 조합 테스트, 거부 이벤트가 stream-json에 어떻게 나오는지 픽스처화 |
| 프로세스 제어 | timeout 시 자식 프로세스(git, npm 등) 포함 종료, 좀비 방지 | M2: `detached` + 프로세스 그룹 kill, `ps` 확인 테스트 |
| stream-json 형식 안정성 | CLI 버전 업으로 이벤트 스키마 변경 | M2: 파서를 관대한 방식(알 수 없는 타입 무시, `result`만 필수)으로, 버전을 로그에 기록 |
| Jira 검색 엔드포인트/ADF | `/search` deprecated, v3 댓글 ADF 필요 | M1 smoke로 v2 `search/jql` + v2 댓글 확정 |
| Transition 이름 불일치 | 프로젝트별 워크플로우가 달라 "In Progress"가 없을 수 있음 | M1: `getTransitions`로 이름 조회 후 매칭, 없으면 부팅/claim 시 명확한 에러 |
| 이중 claim / 상태 불일치 | 재시작·중복 폴링으로 같은 이슈 2회 실행 | M3·M4: transition 성공을 claim 조건으로 + state.json + 복구 테스트 |
| Worker 성공·Jira 기록 실패 | 결과가 유실되면 사람이 알 수 없음 | M4: `reporting_failed` 상태 + runs/summary.md는 항상 먼저 기록 |

### 나중에 해결 가능

- 동시 실행 N개와 worktree 충돌, 실행 비용 상한, 인간의 중간 취소 반영, Webhook 서명 검증, 대상 repo 다중화, 원격 push 인증, 장기 실행 세션 resume(`--session-id`/`--resume` 활용 가능), 로그 보존 정책.

## 11. 아직 결정이 필요한 사항 (구현 착수 전 사용자 입력)

1. Jira 프로젝트 키, 트리거 방식(라벨 `ggjira` vs 전용 상태 "AI Ready"), 성공 시 전이할 상태명.
2. 대상 저장소 로컬 경로와 기본 브랜치(worktree 분기 기준).
3. Worker 모델/effort 기본값(제안: `sonnet`, effort 기본) 및 허용 도구 목록.
4. Worker timeout 기본값(제안: 30분).
5. 원격 저장소가 GitHub인지(CI 실행 여부).
6. 데몬 실행 형태: 터미널 수동 실행으로 시작하고 launchd 등록은 M4 이후 검토.

위 항목은 모두 config 값이므로 구현 착수를 막지 않는다. 미정이면 `ggjira.config.example.json`에 제안 기본값을 넣고 진행한다.

## 12. 구현을 시작한다면 가장 먼저 수행할 작업

1. T1(M0): `git init` → 뼈대/검증 루프/문서/ADR. 첫 커밋.
2. T2(M1) 스파이크를 T1 직후 즉시: Jira 자격증명으로 `jira:smoke` 실행해 API 위험을 가장 먼저 소거.
3. T3→T4(M2) 스파이크: `worker:run`으로 비대화형 인증·권한·프로세스 제어 위험 소거.
4. 그 다음 T5→T6로 vertical slice 연결.

T2와 T4는 서로 독립이라 문제 발생 시 순서를 바꿔도 된다.

## 검증 (계획 전체)

- 각 milestone 완료 조건을 CLI 명령(`jira:smoke`, `worker:run`, `once`, `status`)과 `npm run check`로 확인.
- 최종: 실제 Jira 이슈 1건에 라벨 부여 → 결과 댓글과 로컬 브랜치 커밋 확인 → 데몬 kill/재시작 후 중복 실행 없음 확인.
