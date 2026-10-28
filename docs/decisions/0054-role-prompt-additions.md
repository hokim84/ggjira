# ADR 0054: 기능별 AI 역할과 공통 추가 지침

## Context

Worker는 모든 AI 작업을 실행하므로 에이전트 분류 대신 플랜·구현·리뷰 기능으로 지침을 관리해야 한다.
기존 읽기 전용 카탈로그(ADR 0045)는 플랜·구현만 표시하고 리뷰는 Worker의 별도 문자열을 사용했다.

## Decision

- 역할 ID는 `planning`, `implementation`, `quality_review`다. Worker·provider 할당 정책을 나누지 않는다.
- 기본 지침은 코드에서 관리하고 `prompts.<role>.additionalInstructions`만 편집한다. Router 전체에
  공통 적용하며 20,000자까지 허용한다. 빈 문자열은 추가 지침 제거다. configVersion 6의 기존 파일은
  추가 지침을 빈 값으로 읽는다. 출력 스키마와 실행 권한은 편집 대상이 아니다.
- 인증된 `GET /api/v1/admin/prompts`는 `agents` 대신 세 `roles`와 `editable`을 반환한다.
  각 역할에 기본 지침, 추가 지침, 합성된 지침, 입력 예시, 출력 스키마를 제공한다.
  `PUT /api/v1/admin/prompts/:role`은 `{ additionalInstructions }`를 받아 기존 설정 저장·백업·반영
  경로로 저장하고 본문을 포함하지 않는 감사 기록을 남긴다.
- Router envelope에 합성된 지침을 전달하고 리뷰 Worker도 이를 사용한다. 작업별 문맥은 별도로
  붙인다. DB migration 20의 `attempt_prompts`는 최초 전달 시 시스템 지침을 고정한다.
  이후 변경은 새로 전달되는 attempt에만 적용한다. 동일 attempt 재전송은 기존 지침을 유지한다.
- UI 초기화는 입력란을 비우며 저장해야 적용한다. 통합 검증은 모델 호출이 없으므로 역할에서 제외한다.

## Consequences

역할별 추가 지침은 Router 재시작 없이 적용되며 Worker 설정을 복제할 필요가 없다.
기본 지침과 CLI·저장소 규칙, 작업별 계약은 계속 유효하다. 일반 설정 저장도 프롬프트 필드를 보존한다.
API의 기존 `agents` 응답을 사용한 클라이언트는 `roles`로 갱신해야 한다. Wire envelope 형태와
configVersion은 유지한다. ADR 0045의 읽기 전용·두 에이전트 카탈로그 정책을 대체한다.
