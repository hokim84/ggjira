# 0004: 파일 기반 persistence (SQLite 대신)

## Context

MVP는 동시 실행 1개, Job 개수도 적다. SQLite는 Node 20에서 native 모듈 빌드가 필요해
설치 복잡도가 늘어난다. `writing-block.md` 원칙 12는 "설계 결정과 프로젝트 상태는 LLM의
대화 기억에 의존하지 않고 저장소/Jira에 남겨야 한다"고 요구한다.

## Decision

- 실행 기록은 `data/runs/<ISSUE-KEY>/<runId>/{job.json, worker.jsonl, summary.md}`에
  사람이 읽을 수 있는 형태로 남긴다.
- claim 상태는 `data/state.json`(`issueKey → runId` 매핑)에 기록한다.
- 둘 다 순수 파일 I/O로 구현하고 별도 DB 의존성을 두지 않는다.

## Consequences

- 사람이 직접 `data/runs/`를 열어 실패 원인을 계층별로 추적할 수 있다 (관찰 가능성 원칙과 부합).
- 동시성이나 쿼리 요구가 늘어나면(예: 여러 Job 동시 실행, 복잡한 필터링) SQLite 등으로
  이전을 검토한다. 그 전까지는 파일 기반으로 충분하다.
- `data/`는 `.gitignore`에 포함되어 커밋되지 않는다. 필요 시 백업/보존 정책은 별도로 정한다.

## 확정된 레이아웃 (T5, `src/job/job.ts` + `src/job/store.ts`)

```
data/
├── state.json                              # { "claims": { "<ISSUE-KEY>": "<runId>" } }
└── runs/
    └── <ISSUE-KEY>/
        └── <runId>/
            ├── job.json                    # Job 객체 (아래 스키마)
            ├── worker.jsonl                # Worker의 stream-json 원문, 한 줄에 하나
            └── summary.md                  # 사람이 읽는 실행 요약 (Reporter가 작성, T6)
```

`job.json`의 `Job` 스키마:

```ts
interface Job {
  runId: string;
  issueKey: string;
  status: "queued" | "claimed" | "running" | "succeeded" | "failed" | "timed_out" | "cancelled";
  createdAt: string;   // ISO 8601
  updatedAt: string;   // ISO 8601
  branch?: string;
  summary?: string;
  failureStage?: "jira" | "poller" | "job" | "worker" | "reporter";
  error?: string;
}
```

허용된 상태 전이는 `queued → claimed → running → {succeeded | failed | timed_out | cancelled}`이며,
`claimed`/`queued`에서 바로 `failed`로도 갈 수 있다(예: worktree 생성 실패). 그 외 전이는
`InvalidJobTransitionError`로 거부된다. 종결 상태(`succeeded`/`failed`/`timed_out`/`cancelled`)에서는
더 이상 전이할 수 없다.

`state.json`의 `claims`는 "이 이슈를 지금 어떤 runId가 처리 중인가"만 기록한다. `JobStore.claimIssue`는
디스크에 즉시(임시 파일 + rename으로 원자적) 반영되므로, 프로세스가 재시작돼도 같은 이슈를 두 번
claim하지 못한다 — `test/job-store.test.ts`의 "재시작 후 이중 claim 거부" 테스트로 검증했다.
`claimIssue`는 같은 `runId`로 다시 부르면 멱등이다(재시도 로직에서 안전하게 재호출 가능).

## 버그 수정 (T7): state.json이 없을 때의 fallback 객체 공유 문제

T7에서 `recoverStaleClaims`의 다중 이슈 시나리오를 테스트하다가 발견했다: `state.json` 파일이
아직 없는 상태에서 여러 `JobStore` 인스턴스가 존재하면(예: 같은 프로세스에서 서로 다른
`dataDir`를 가리키는 인스턴스 여러 개), `claimIssue`가 claim 기록을 **다른 인스턴스의 claim과
공유하는 하나의 객체에 직접 mutate**하는 버그가 있었다. `readState()`가 "파일 없음" 폴백으로
매번 같은 모듈 레벨 상수 객체(`EMPTY_STATE`)를 반환했고, `claimIssue`가 그 객체의 `claims`를
그 자리에서 수정한 뒤 저장했기 때문이다. 실사용에서는 `data/state.json`이 최초 claim 시점에
바로 생성되므로 두 번째 읽기부터는 실제 파일을 읽어 문제가 드러나지 않지만(잠복 버그), 여러
`JobStore` 인스턴스를 함께 쓰는 테스트/향후 시나리오에서는 claim이 인스턴스 간에 새는 심각한
결함이었다. `readJsonFile`의 폴백을 값이 아니라 **매번 새 객체를 만드는 팩토리 함수**로 바꿔
고쳤고, `test/job-store.test.ts`에 회귀 테스트를 추가했다.
