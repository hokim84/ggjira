# GGJIRA

Jira를 인간과 AI Agent가 공유하는 작업 인터페이스로 사용하는 경량 프로젝트 오케스트레이션 시스템이다.
MVP는 다음 vertical slice를 완성하는 것을 목표로 한다.

```
Jira Issue → Poller → Job → Worker(Claude Code CLI) → 결과 → Jira 기록
```

자세한 배경과 설계는 [`PLAN.md`](./PLAN.md), 아키텍처는 [`docs/architecture.md`](./docs/architecture.md)를,
문제 해결은 [`docs/runbook.md`](./docs/runbook.md)를 참고한다.

## 설치

### 요구 사항

- Node 20 (`.nvmrc`에 고정)
- git
- [Claude Code CLI](https://claude.com/claude-code)가 설치되어 있고, `claude` 명령으로 로그인된
  상태 — GGJIRA는 이 CLI를 subprocess로 실행해 Worker로 쓴다 (`claude --version`으로 확인)
- Jira Cloud 사이트 접근 권한과 API 토큰 (아래 [설정](#설정) 참고)

### 저장소 받기

```bash
git clone https://github.com/hokim84/ggjira.git
cd ggjira
```

### 의존성 설치

```bash
nvm use        # Node 20 (.nvmrc)
npm install
```

## 설정

1. Jira 자격증명을 `.env`에 채운다.

   ```bash
   cp .env.example .env
   # JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN 채우기
   ```

2. 프로젝트/트리거/대상 저장소 설정을 `ggjira.config.json`에 채운다.

   ```bash
   cp ggjira.config.example.json ggjira.config.json
   # jira.jql, targetRepo.path 등 채우기
   ```

   **주의**: Jira의 상태/transition 이름은 사이트 로케일에 따라 지역화되어 있을 수 있다
   (예: "In Progress"가 아니라 "진행 중"). `inProgressTransitionName` /
   `successTransitionName`을 채우기 전에 아래 `jira:smoke`를 실행해 실제 이름을 확인한다.

   **더 주의**: `jira.jql`의 `status = "..."` 절은 REST API가 보여주는 지역화된 이름이 아니라
   워크플로우의 실제(대개 영문) 상태 이름을 써야 한다 — 틀려도 에러 없이 조용히 0건을 반환한다.
   확실하지 않으면 `statusCategory = "To Do"`처럼 카테고리로 걸러도 된다. `jira:smoke` 또는
   `once`를 한 번 실행해 후보 이슈가 실제로 잡히는지 반드시 확인한다.

   자세한 내용은 [`docs/decisions/0002-jira-rest-api-v2.md`](./docs/decisions/0002-jira-rest-api-v2.md) 참고.

   `.env`와 마찬가지로 실제 `ggjira.config.json`은 머신/인스턴스별 설정(대상 저장소 경로 등)이라
   `.gitignore`에 포함되어 커밋되지 않는다.

## 처음 실행할 때: 3단계 검증 순서

설정을 끝냈다면 순서대로 실행해서 각 단계를 확인한다. 한 번에 `run`부터 돌리지 않는다 —
아래 순서대로 하면 문제가 생겨도 어느 단계인지 바로 알 수 있다.

```bash
# 1. Jira 연동 확인 (이슈 조회 → 테스트 댓글 → transition 목록 출력)
npm run dev -- jira:smoke <ISSUE-KEY>

# 2. Worker(Claude Code CLI) 단독 실행 확인 — 이 저장소가 target repo라면
#    npm run dev로 실행해도 되고, 실제 대상 repo를 향하게 하려면 dist를 빌드해 실행한다.
npm run dev -- worker:run --prompt "README.md 맨 끝에 한 줄만 추가해줘"

# 3. Jira 이슈에 ggjira.config.json의 jira.jql에 맞는 라벨/상태를 걸어둔 뒤, 폴링 1회 실행
npm run dev -- once
```

`once`가 기대한 대로 동작하면(이슈 상태 전이 + 댓글 + 로컬 브랜치 커밋) 데몬으로 넘어간다.

## 평소 실행

```bash
npm run dev -- run       # 폴링 데몬. config의 polling.intervalMs 주기로 계속 돈다.
                          # Ctrl+C(SIGINT) 또는 SIGTERM을 보내면 진행 중인 사이클을 마치고 종료한다.
```

빌드해서 실행할 수도 있다.

```bash
npm run build
node dist/cli.js run
```

daemon(`run`)은 시작할 때마다 `data/state.json`에 남은 claim을 먼저 점검한다. 이전 실행이
비정상 종료(kill, 크래시)로 이슈를 "진행 중"으로 남겨뒀다면, 다시 실행하지 않고 실패로 정리한 뒤
Jira에 알리고 넘어간다 — 자세한 동작은 [`docs/runbook.md`](./docs/runbook.md) §5 참고.

## 그 밖의 명령

```bash
npm run dev -- status                                          # 현재 claim과 최근 실행 목록
npm run dev -- worktrees:prune [--olderThanDays N]              # 오래된 워크트리 정리 (기본 7일, 브랜치는 안 지움)
npm run dev -- worker:run --prompt "<지시문>" [--timeout <ms>]    # Worker만 단독 실행 (Jira 이슈 없이)
```

`worker:run`은 `ggjira.config.json`의 `targetRepo.path`에 새 git worktree
(`data/worktrees/ggjira-manual-<timestamp>`)를 만들고, 그 안에서 Worker를 실행한 뒤 변경
사항을 GGJIRA가 직접 커밋한다. `once`/`run`이 이슈별로 만드는 워크트리도 동일한 방식이다.

## 무엇을 확인하면 되는가

- 이슈에 댓글이 달리고 상태가 바뀌었는지 — Jira에서 직접 확인한다.
- 실제로 무슨 작업을 했는지 — `data/runs/<ISSUE-KEY>/<runId>/summary.md`.
- 실패했을 때 — `npm run dev -- status`로 어떤 이슈가 실패했는지 먼저 보고,
  [`docs/runbook.md`](./docs/runbook.md)의 계층별 진단 순서를 따라간다.

## 개발

```bash
npm run check   # typecheck + lint + format:check + test (CI와 동일)
```
