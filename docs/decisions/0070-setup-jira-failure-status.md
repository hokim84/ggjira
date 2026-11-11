# ADR 0070 — 셋업 Jira 실패는 424 JSON으로 반환

## Context

Cloudflare Tunnel 뒤에서 셋업의 Jira 연결 테스트가 실패하면 Router는 502 JSON을 반환했지만,
공개 주소에서는 Cloudflare의 502 HTML 페이지로 대체되는 것을 재현했다.
웹 UI는 HTML 앞부분만 표시하므로 실제 Jira 인증 오류를 확인할 수 없었다.

## Decision

셋업 서버의 `callJira`가 감싼 Jira 요청 실패는 HTTP 424 Failed Dependency로 반환한다.
기존 `jira_error` 코드와 원래 오류 메시지는 유지한다. 셋업 토큰 오류의 401 및
입력 검증 오류의 400은 그대로 유지한다.

## Consequences

셋업 UI가 프록시의 gateway 오류 대신 Jira 실패 원인을 JSON으로 받을 수 있다.
API 사용자는 Jira 연결 실패 상태를 502 대신 424로 처리해야 한다.
이 변경은 Jira 인증·권한 자체를 해결하지 않으며, 실제 실패 메시지를 보고 설정을 수정해야 한다.
