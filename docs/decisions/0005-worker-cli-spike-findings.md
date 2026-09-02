# 0005: Claude Code CLI Worker 스파이크에서 확인한 사실 (M2)

## Context

`writing-block.md` 원칙 8은 구독형 Claude Code CLI를 Worker로 사용할 가능성을 명시하고, 계획 §10은
"구독 인증의 비대화형 실행", "권한 프롬프트로 인한 hang", "프로세스 제어", "stream-json 형식 안정성"을
MVP에서 반드시 검증해야 할 위험으로 꼽는다. `src/worker/claude-code-cli.ts` 구현 전후로 실제
`claude -p ...`를 격리된 git worktree에서 두 차례(원시 spawn 1회, `worker:run` CLI 통합 1회)
실행해 검증했다.

## 확인한 사실

- **비대화형 구독 인증**: `--bare`를 사용하지 않고 일반적으로 spawn하면, 이미 로그인된 세션의
  구독 인증을 그대로 사용해 비대화형(`-p`)으로 정상 동작한다. 별도 API 키나 프롬프트 없이 실행됨.
- **권한 프롬프트로 인한 hang 없음**: `--permission-mode acceptEdits --allowedTools "Edit Write Read"`
  조합에서 파일 편집이 프롬프트 없이 자동 승인되었고, 최종 `result` 이벤트의 `permission_denials`는
  빈 배열이었다. hang이나 승인 대기는 발생하지 않았다.
- **stream-json 실제 이벤트 타입**: `rate_limit_event`, `system`(subtype `init`), `assistant`,
  `user`(도구 실행 결과), `result`(subtype `success`/`error`)를 관찰했다. GGJIRA는 이 중 `result`
  이벤트만 파싱해서 사용하고, 나머지는 원문 그대로 `worker.jsonl`에 저장한다 (형식이 바뀌어도 원본은
  보존됨 — `ClaudeCodeCliProvider`는 JSON 파싱에 실패한 줄도 그대로 `onEvent`로 전달한다).
- **`result` 이벤트에서 실제로 쓰는 필드**: `is_error`, `result`(사람이 읽는 요약문), `duration_ms`,
  `total_cost_usd`, `num_turns`, `session_id`. 이 필드들만 `WorkerResult`로 매핑한다. 다른 필드
  (`usage`, `modelUsage`, `subagent_stats` 등)는 지금 필요하지 않아 사용하지 않는다.
- **Worker가 커밋하지 않도록 지시 가능**: `--append-system-prompt`로 "GGJIRA가 커밋하니 git 명령을
  실행하지 말라"고 지시하면 실제로 준수한다. 두 스파이크 모두 Worker는 파일만 변경했고,
  `git add -A && git commit`은 GGJIRA(`src/worker/worktree.ts`)가 실행 후 직접 수행했다
  (`docs/decisions/0004-file-based-persistence.md`와 별개로, 이 결정 자체는 계획 M2 노트에서
  이미 "후자 권장: 결정론적"으로 정해져 있었고, 실측으로 재확인함).
- **프로세스 그룹 kill 검증**: `spawn(..., { detached: true })`로 새 프로세스 그룹을 만들고
  timeout 시 `process.kill(-pid, "SIGTERM")` → 유예 후 `process.kill(-pid, "SIGKILL")`을 보내는
  방식을, SIGTERM을 무시하도록 trap을 건 가짜 실행 파일과 그 자식 프로세스(백그라운드 `sleep`)로
  테스트했다(`test/worker-claude-code-cli.test.ts`). 두 프로세스 모두 SIGKILL 이후 완전히
  종료되는 것을 확인했다 — 직접 자식뿐 아니라 grandchild까지 그룹 kill로 정리된다.

## Decision

- `ClaudeCodeCliProvider`는 `result` 이벤트만 구조적으로 신뢰하고, 나머지 이벤트 타입은 원문
  로그 용도로만 취급한다. CLI의 stream-json 스키마가 확장되어도 파싱이 깨지지 않는다.
- timeout 처리는 SIGTERM → (설정 가능한 유예 시간) → SIGKILL을 프로세스 그룹 전체에 보낸다.
- 자동 테스트는 실제 `claude` 바이너리를 호출하지 않고, `test/fixtures/fake-workers/`의 가짜
  실행 파일로 파싱/타임아웃 로직만 검증한다 (`CLAUDE.md`의 "외부 호출 금지" 규칙과 일치).

## Consequences

- Worker 실행 방식(spawn, 이벤트 파싱, timeout/kill)은 실측으로 검증되어 M3(vertical slice)에서
  재검토 없이 그대로 재사용할 수 있다.
- CLI가 stream-json에 새 이벤트 타입을 추가해도 GGJIRA는 영향받지 않지만, `result` 이벤트의 필드
  이름이 바뀌면 이 문서와 `RawResultEvent` 타입을 함께 갱신해야 한다.
- `killGraceMs`를 생성자 인자로 노출해 두어, 운영 환경 기본값(5초)과 테스트에서 쓰는 짧은 값을
  분리했다.
