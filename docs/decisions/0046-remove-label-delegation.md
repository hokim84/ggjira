# 0046. 라벨 기반 AI 위임 제거

## Context

사람은 칸반 상태 이동으로 AI에게 위임한다. 라벨 추가/제거가 승인·취소를 만들던 별도 정책은 더 이상 사용하지 않는다.

## Decision

label 모드, opt-in 설정과 후보·승인·철회 분기, 라벨 이관, 쓰기 API·CLI·웹 토글을 제거한다. ADR 0037의 label 정책과 ADR 0039의 opt-in 관리 기능을 대체한다. legacy와 delegation 상태 정책은 유지한다. 이슈 진단은 issue-view 및 GET /api/v1/admin/issues/:key로 분리한다.

지원하지 않는 mode와 opt-in 키는 설정 오류로 거절해 자동 재해석을 막는다. 과거 label 승인 필드가 남은 전이 저널은 skipped 처리하고 자동 재시도하지 않는다. DB·감사·과거 ADR/검증 기록은 보존한다. 일반 보고·대체·메타 라벨 기능은 유지한다.

## Consequences

구 label 설정은 배포 전에 구 버전에서 배정을 정지하고 활성 작업·미완료 보고를 정리한 뒤 명시적으로 전환해야 한다. Jira 워크플로와 승인 이력 확인 없이 delegation으로 자동 변경하지 않는다. 새 DB migration과 Worker 프로토콜 변경은 없다. 실행 계약을 Jira 설명에서 파싱하는 구조 변경은 별도 범위다.

설정·초기 설정의 단일 방식 드롭다운도 제거한다. 새 Workspace는 delegation으로 생성하며 기존 legacy 설정은 저장만으로 전환하지 않는다.
