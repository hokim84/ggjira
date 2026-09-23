# GGJIRA — Claude Code 작업 규칙

GGJIRA는 Jira를 인간/AI 공용 작업 인터페이스로 쓰는 경량 오케스트레이션 시스템이다.
configVersion 5에서는 **Router**(`ggjira router serve`, 단일 서버 + SQLite)가 Jira 웹훅·보완 조회로
승인된 이슈를 찾아 job을 만들고, capability·저장소·가용성으로 **Worker**(`ggjira worker run`,
각 머신)에 배정한다. 워커는 Router에만 HTTPS long polling으로 연결하며 Jira를 직접 호출하지 않는다.
Jira Assignee는 인간 책임자로만 남는다. PM(계획) 실행도 같은 워커가 하고 계획만 반환하며, Jira에
하위 이슈를 만드는 것은 Router다. 설계와 진행 상황은 `docs/router-service-implementation-plan.md`와
`docs/decisions/0018`~`0022`에 있다. `PLAN.md`·`GGJira_Phase2_Implementation_Plan.md`·
`writing-block.md`는 v4 이전 이력이다.

## 디렉터리 = 계층 규칙

`src/` 하위 디렉터리는 실행 계층과 1:1로 대응한다. 새 코드는 해당 계층 디렉터리에 두고,
로그는 `layer` 필드로 그 디렉터리 이름을 사용한다.

- `src/contracts/` — Router·Worker wire 계약(Zod): envelope, 결과, `/api/v1/*`, job/attempt 상태 머신
- `src/router/` — Router: 설정·비밀정보, SQLite(`db/`), 웹훅, 후보 조회·승인·라우팅·스케줄러,
  Worker API(`worker-service.ts`), 보고 저널(`report-*.ts`), 복구, 관리 API(`admin-service.ts`),
  `router serve` 데몬(`daemon.ts`), `router check`, `ggjira router …` CLI(`cli.ts`)
- `src/worker-runtime/` — Worker: 설정·credential, Router 클라이언트, runner·executor·planning,
  결과 spool, `ggjira worker …` CLI와 setup/check/prune(`ops.ts`). **Jira·Router DB를 import하지
  않는다**(`test/worker-runtime-no-jira.test.ts`가 검사)
- `src/worker/` — AI CLI provider(Claude Code, Codex), 프로세스 트리 종료, git worktree, 검증 명령
- `src/jira/` — Jira REST 호출, 인증, 에러 매핑, `FakeJiraGateway`. Router만 쓴다
- `src/pm/` — 계획 스키마·메타데이터(`ggjira.plan*`)·렌더링·PM 프롬프트·결정 답변 파싱(순수 로직)
- `src/issue/` — 이슈 설명의 GGJIRA 절 파싱, 요구 capability 읽기와 매칭(순수 로직)
- `src/cli.ts`·`cli-main.ts`·`cli-io.ts` — 진입점과 명령 분기

Router만 Jira에 쓴다. 워커는 Router가 준 envelope만 실행하고 결과를 돌려준다(ADR 0018).
v2~v4의 poller·claim·Agent Profile 경로는 5단계에서 삭제했다(ADR 0022). 되살리지 않는다.

미래 확장(Web UI, LLM `DecisionProvider`)을 위한 빈 디렉터리는 미리 만들지 않는다.

## 명령

```
npm run typecheck   # tsc --noEmit
npm run lint        # biome lint
npm run format       # biome format --write
npm run format:check
npm run test         # vitest run
npm run check         # 위 전부 (CI와 동일)
npm run dev -- <command>   # tsx로 CLI 실행 (예: npm run dev -- router check)
npm run build         # dist/ 빌드
docker compose -f docker-compose.test.yml run --rm --build check   # Linux에서 check 전체
```

이 Windows 개발 머신에서는 전체 vitest 실행이 가끔 멈춘다(`docs/runbook.md` §13). 그럴 때는
테스트 파일마다 따로 실행한다.

## 완료의 정의

작업을 완료로 보고하기 전에 다음을 모두 만족해야 한다.

1. `npm run check`가 통과한다.
2. 바꾼 동작을 실제 명령으로 확인했다(해당 테스트 파일, 필요하면 `docs/runbook.md`의 수동 절차).
3. 아키텍처나 결정이 바뀌었다면 `docs/architecture.md`, `docs/decisions/`, 실패 진단 방법이
   바뀌었다면 `docs/runbook.md`를 같은 커밋/PR에서 갱신했다.
4. 외부 서비스(Jira, Claude Code CLI)에 대한 실제 호출은 자동 테스트에 넣지 않는다.
   자동 테스트는 Fake(`FakeJiraGateway`, `FakeWorkerProvider`, fetch mock, loopback HTTP)만
   사용하고, 실제 연동 확인은 `router check`, `worker check` 같은 수동 CLI 명령으로 한다.

## 결정 기록

설계 결정을 바꾸거나 새로 내리면 `docs/decisions/NNNN-제목.md`에
Context / Decision / Consequences 3절로 남긴다. 기존 ADR을 삭제하지 않고,
필요하면 새 ADR로 이전 결정을 superseded 처리한다.

## 도구 사용 원칙

Memory, Skill, MCP, Subagent 등은 현재 구현 단계에서 실제 이득이 있을 때만 도입한다.
도구를 쓰는 것 자체를 목표로 삼지 않는다. Jira 접근은 Router의 `src/jira/client.ts`가 직접
REST를 호출하므로 별도 MCP 서버가 필요 없다.
