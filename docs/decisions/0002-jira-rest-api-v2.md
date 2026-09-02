# 0002: Jira REST API v2 사용, 전용 SDK 미사용

## Context

Jira Cloud REST API는 v2와 v3가 공존한다. v3는 댓글 본문을 ADF(Atlassian Document Format,
JSON 트리)로 요구해 생성/파싱 코드가 늘어난다. v2는 여전히 Jira Cloud에서 지원되며 평문/wiki
markup 댓글을 그대로 받는다. GGJIRA가 실제로 필요한 호출은 6개뿐이다: JQL 검색, 이슈 조회,
댓글 추가, transition 목록 조회/실행, 라벨 추가/제거.

## Decision

- Jira 연동은 `fetch` + Basic Auth(email + API token)로 직접 작성한 얇은 클라이언트
  (`src/jira/client.ts`)로 구현한다. 공식 Node SDK는 도입하지 않는다.
- 댓글/이슈 조회 등 대부분의 호출은 REST v2를 사용한다.
- JQL 검색은 `POST /rest/api/2/search/jql`을 사용한다.

## M1 스파이크로 확인한 사실 (실제 Jira Cloud 사이트에 대해 검증함)

- `GET/POST /rest/api/2/search` (구 엔드포인트)는 **HTTP 410 Gone**을 반환한다.
  응답 본문이 `/rest/api/3/search/jql`로의 마이그레이션을 명시적으로 안내한다.
- `POST /rest/api/2/search/jql`은 정상 동작한다. 요청 본문은
  `{ jql, maxResults, fields }`, 응답은 `{ issues: [...], isLast: boolean, nextPageToken?: string }`.
  **주의**: 아무 조건 없는 JQL(`order by created`)은 400 에러
  (`무제한 JQL 쿼리는 여기에서 허용되지 않습니다`)를 반환한다. `jql`에는 반드시 `project = ...` 같은
  검색 범위 제한이 있어야 한다. `ggjira.config.example.json`의 `jira.jql`은 이미 `project =` 조건을
  포함하므로 문제 없다.
- `GET /rest/api/2/issue/{key}?fields=...`는 정상 동작하며 `fields.status.name`,
  `fields.labels`, `fields.description`(v2에서는 평문/wiki markup 문자열 또는 `null`)을 그대로 반환한다.
- `POST /rest/api/2/issue/{key}/comment`에 `{ "body": "plain text" }`를 보내면 정상적으로
  댓글이 생성된다 (v3처럼 ADF를 요구하지 않음).
- `GET /rest/api/2/issue/{key}/transitions` → `POST .../transitions { transition: { id } }`
  조합으로 상태 전이가 정상 동작한다.
- `PUT /rest/api/2/issue/{key} { update: { labels: [{ add | remove: "label" }] } }`로
  라벨을 추가/제거할 수 있다.
- **transition/status 이름은 Jira 사이트 로케일에 따라 지역화되어 있다.** 예를 들어 기본
  한국어 칸반 템플릿에서는 상태가 "해야 할 일" / "진행 중" / "완료"로 표시되고, transition
  이름도 대부분 동일하게 지역화된다 (단, 프로젝트 템플릿에 따라 "In Review"처럼 일부만 영문으로
  남아있는 경우도 있었다). 즉 `ggjira.config.example.json`의 `"In Progress"`, `"In Review"` 같은
  기본값은 예시일 뿐이며, **실제 프로젝트에 배포하기 전 `jira:smoke`로 실제 transition 이름을
  확인해 config에 반영해야 한다.** `JiraClient.transitionIssue`는 이름이 일치하지 않으면
  `TransitionNotFoundError`로 사용 가능한 이름 목록을 함께 던진다.

## Consequences

- SDK 추상화 비용 없이 필요한 호출만 최소로 구현한다.
- API 버전/엔드포인트가 바뀌면 이 문서와 `src/jira/client.ts`를 함께 갱신해야 한다.
- 댓글 서식은 wiki markup 수준으로 제한된다 (충분히 MVP 요구를 만족).
- transition/status 이름의 지역화는 설정 실수의 흔한 원인이 될 수 있으므로, `jira:smoke`를
  프로젝트 설정 전 필수 절차로 README/runbook에 명시한다.
