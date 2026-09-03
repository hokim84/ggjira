# 0010: WorkerRequest 일반화 + Codex CLI Provider 추가

## Context

MVP의 `WorkerRequest`는 Claude Code CLI 전용 필드(`command`, `model`, `effort`,
`permissionMode`, `allowedTools`)를 그대로 담고 있었다(ADR 0003이 정의한 Provider 경계는
지켰지만, 요청 타입 자체는 한 구현에 결합돼 있었다). 2차는 (1) PM Agent가 구조화된 출력
(Plan JSON)과 읽기 전용 실행을 요청할 수 있어야 하고, (2) Provider 범위를 Codex CLI까지
넓혀야 한다(`GGJira_Phase2_Implementation_Plan.md` §5.1 Provider 선택지, 사용자 결정).

## Decision

- `WorkerRequest`를 provider-무관 필드만 남기도록 일반화했다: `prompt`, `cwd`, `timeoutMs`,
  `systemPrompt?`, `outputSchema?`, `readOnly?`. Claude 전용 옵션(model/effort/permissionMode/
  allowedTools/command)은 `ClaudeCodeCliProvider`의 생성자 옵션으로, Codex 전용 옵션
  (sandbox 등)은 `CodexCliProvider`의 생성자 옵션으로 옮겼다. `WorkerResult`에
  `structuredOutput?: unknown`을 추가했다.
- 공통 프로세스 제어(spawn, timeout → SIGTERM → grace → SIGKILL, 프로세스 그룹 kill, stdout
  라인 버퍼링)를 `src/worker/spawn.ts`의 `runProcessWithTimeout()`으로 추출해 두 Provider가
  공유한다 — provider별 코드는 인자 구성과 결과 파싱만 담당한다.
- `src/worker/factory.ts`의 `createProvider(config)`가 `config.provider.type`으로 구현체를
  선택한다.
- **Codex CLI Provider는 미검증이다.** 개발 환경에 `codex` CLI가 설치되어 있지 않아 실제
  동작을 확인하지 못했다. 구현은 공개 문서 기준 최선 추정이다:
  - `codex exec --json --skip-git-repo-check -C <cwd> --sandbox <mode> -m <model>
    --output-last-message <file> <prompt>`
  - Codex에는 `--append-system-prompt`/`--json-schema` 상당 플래그가 없다고 판단해,
    `systemPrompt`와 스키마 요청(구조화 출력이 필요할 때 "```json 블록으로 답하라"는 지시)을
    프롬프트 텍스트 앞/뒤에 직접 이어붙인다.
  - 최종 결과는 `--output-last-message`로 지정한 파일에서 읽는다(`--json` 스트림의 이벤트
    스키마 변경에 덜 취약하도록, stdout 이벤트 파싱에 결과 판단을 의존하지 않는다).

## Consequences

- `job/runner.ts` 등 상위 계층은 `WorkerRequest`/`WorkerResult`만 알면 되고, 실제 CLI가
  Claude인지 Codex인지 몰라도 된다(ADR 0003의 경계를 그대로 유지).
- Codex 관련 코드/문서는 "미검증"으로 명시해 둔다 — 실제 `codex` CLI 설치 후 동작이
  다르면(특히 최종 메시지 추출 방식, sandbox 모드 이름) 이 ADR과 `worker/codex-cli.ts`를
  함께 갱신해야 한다. 자동 테스트는 가짜 실행 스크립트(`test/fixtures/fake-workers/
  codex-*.sh`)로만 인자 처리/결과 매핑을 검증하며, 실제 CLI 스모크 테스트를 대체하지
  않는다.
- 구조화 출력이 스키마를 정확히 안 지킬 가능성(특히 Codex)에 대비해, 두 Provider 모두
  fenced ```json 블록 추출 fallback을 둔다.
