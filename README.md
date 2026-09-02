# GGJIRA

Jira를 인간과 AI Agent가 공유하는 작업 인터페이스로 사용하는 경량 프로젝트 오케스트레이션 시스템이다.
MVP는 다음 vertical slice를 완성하는 것을 목표로 한다.

```
Jira Issue → Poller → Job → Worker(Claude Code CLI) → 결과 → Jira 기록
```

자세한 배경과 설계는 [`PLAN.md`](./PLAN.md), 아키텍처는 [`docs/architecture.md`](./docs/architecture.md)를,
문제 해결은 [`docs/runbook.md`](./docs/runbook.md)를 참고한다.

## 설치

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

## 실행 (개발 중 검증용)

```bash
npm run dev -- jira:smoke <ISSUE-KEY>                      # Jira 연동 확인
npm run dev -- worker:run --prompt "<지시문>" [--timeout <ms>]  # Worker 단독 실행
npm run dev -- once                                          # 폴링 1회 실행
npm run dev -- run                                            # 폴링 데몬 실행
npm run dev -- status                                         # 현재 Job 상태 확인
```

`worker:run`은 `ggjira.config.json`의 `targetRepo.path`에 새 git worktree
(`data/worktrees/ggjira-manual-<timestamp>`)를 만들고, 그 안에서 Worker(Claude Code CLI)를
실행한 뒤 변경 사항을 GGJIRA가 직접 커밋한다. 워크트리 정리는 아직 자동화되지 않았다(M4 예정)므로
수동 스파이크 실행 후에는 `git worktree remove --force <path>`로 직접 정리한다.

각 명령은 `PLAN.md`의 milestone 순서(M0 → M4)대로 구현된다. 아직 구현되지 않은 명령은
"not implemented yet"을 출력한다.

## 개발

```bash
npm run check   # typecheck + lint + format:check + test (CI와 동일)
```
