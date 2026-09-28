# 0024. Router 설정을 저장 즉시 적용

## Context

[ADR 0023](./0023-router-web-ui-and-secrets-file.md)은 웹 UI에서 저장한 설정을 Router 재시작 때
적용하기로 했다. 실제로 써 보니 워커 하나를 추가해도 저장, 재시작, 페어링을 거쳐야 했다. 재시작하는
동안에는 워커 long poll이 끊기고 부팅 전체 조회도 다시 돈다. 설정을 쥐고 있는 곳은 몇 군데로
한정돼 있다. WorkerService, AdminService, 스케줄러 deps(설정과 `RuleDecisionProvider`), daemon의
주기 판단이다. 반면 HTTP listener, SQLite 파일, Jira 클라이언트는 기동 시 만들어진다.

이 ADR은 ADR 0023 Decision 3("설정은 저장만 하고 재시작해야 적용된다")을 **대체(superseded)**한다.
ADR 0023의 나머지 결정은 유지한다.

## Decision

1. **저장하면 바로 적용한다.** `PUT /api/v1/admin/config`는 검증과 저장(`.bak`) 뒤
   `RouterDaemon.applyConfig`를 호출한다. 적용은 sync/verify와 같은 lane에서 직렬로 한다. 진행 중인
   reconcile·verify pass가 끝난 뒤, 스케줄러 deps, `RuleDecisionProvider`, WorkerService, AdminService가
   새 설정을 받는다. 루프 주기(verify 간격, 보완 조회 간격)는 매 tick마다 다시 읽는다.
2. **연결 설정은 재시작 대상으로 남긴다.** `http`, `db.path`, `jira.baseUrl`, `executionAgent.fieldId`는
   열린 listener, DB 파일, Jira 클라이언트에 묶여 있다(`RESTART_ONLY_SETTINGS`). 이 값이 기동 시와
   다르면 응답의 `restartFields`와 UI 배너로 알리고, 나머지 설정은 그대로 적용한다.
3. **파일을 직접 고친 경우를 위해 `POST /api/v1/admin/config/apply`를 둔다.** 이 API는 디스크의
   파일을 검증해 적용한다. `GET /config`의 `pendingApply`는 파일과 실행 중인 설정이 다른지를
   알려준다. 감사 기록은 저장 시 `config.updated`, 파일 적용 시 `config.applied`다.
4. **진행 중인 작업은 옛 설정으로 끝난다.** 이미 처리 중인 워커 API 호출은 읽어 둔 설정으로 끝난다.
   정책에서 뺀 워커는 새 세션과 새 배정만 막힌다. 그 워커가 실행 중이던 작업은 heartbeat 거절 후
   임대가 만료되어 `recovery_required`가 된다. 재시작했을 때와 같은 결과다.

## Consequences

- 워커를 추가하면 저장 즉시 페어링할 수 있다. 정책, 저장소, workspace, 상태 흐름, 주기 설정 변경도
  재시작 없이 반영된다.
- 연결 설정을 바꾼 경우에만 재시작이 필요하고, UI가 어떤 값 때문인지 보여준다.
- 서비스가 설정을 불변 필드로 가정할 수 없게 됐다. 새 코드는 설정을 생성 시 복사해 파생 상태를 만들지
  말고, 호출 시점에 `config`를 읽는다.
