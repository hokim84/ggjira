# GGJIRA

Jira를 인간과 AI Agent가 공유하는 작업 인터페이스로 사용하는 경량 프로젝트 오케스트레이션 시스템이다.
MVP는 다음 vertical slice를 완성하는 것을 목표로 한다.

```
Jira Issue → Poller → Job → Worker(Claude Code CLI) → 결과 → Jira 기록
```

자세한 배경과 설계는 [`PLAN.md`](./PLAN.md), 아키텍처는 [`docs/architecture.md`](./docs/architecture.md)를 참고한다.

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

## 실행 (개발 중 검증용)

```bash
npm run dev -- jira:smoke <ISSUE-KEY>   # Jira 연동 확인
npm run dev -- worker:run                # Worker 단독 실행
npm run dev -- once                      # 폴링 1회 실행
npm run dev -- run                       # 폴링 데몬 실행
npm run dev -- status                    # 현재 Job 상태 확인
```

각 명령은 `PLAN.md`의 milestone 순서(M0 → M4)대로 구현된다. 아직 구현되지 않은 명령은
"not implemented yet"을 출력한다.

## 개발

```bash
npm run check   # typecheck + lint + format:check + test (CI와 동일)
```
