# 0002: Jira REST API v2 사용, 전용 SDK 미사용

## Context

Jira Cloud REST API는 v2와 v3가 공존한다. v3는 댓글 본문을 ADF(Atlassian Document Format,
JSON 트리)로 요구해 생성/파싱 코드가 늘어난다. v2는 여전히 Jira Cloud에서 지원되며 평문/wiki
markup 댓글을 그대로 받는다. GGJIRA가 실제로 필요한 호출은 5개뿐이다: JQL 검색, 이슈 조회,
댓글 추가, transition 목록 조회/실행, 라벨 수정.

## Decision

- Jira 연동은 `fetch` + Basic Auth(email + API token)로 직접 작성한 얇은 클라이언트
  (`src/jira/client.ts`)로 구현한다. 공식 Node SDK는 도입하지 않는다.
- 댓글/이슈 조회 등 대부분의 호출은 REST v2를 사용한다.
- JQL 검색은 구 `/rest/api/2/search`가 deprecated이므로 `/rest/api/2/search/jql`을 사용한다.
  실제 동작 여부는 M1 스파이크(`jira:smoke`)에서 검증하고, 문제가 있으면 이 ADR을 갱신한다.

## Consequences

- SDK 추상화 비용 없이 필요한 호출만 최소로 구현한다.
- API 버전/엔드포인트가 바뀌면 이 문서와 `src/jira/client.ts`를 함께 갱신해야 한다.
- 댓글 서식은 wiki markup 수준으로 제한된다 (충분히 MVP 요구를 만족).
