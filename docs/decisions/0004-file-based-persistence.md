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
