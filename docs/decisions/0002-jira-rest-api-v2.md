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

## M3 스파이크로 추가 확인한 사실: JQL `status =`는 지역화된 표시 이름을 인식하지 못함

`ggjira.config.json`의 `jira.jql`에 `status = "해야 할 일"`(REST API가 실제로 돌려주는
`fields.status.name` 값 그대로)을 넣었더니 **일치하는 이슈가 있는데도 0건**이 나왔다. 같은
이슈가 `statusCategory = "To Do"`(카테고리는 로케일 무관 고정 3종: To Do/In Progress/Done)나
`status = "To Do"`(시스템 기본 상태의 **영문 canonical 이름**)로는 정상적으로 조회됐다.

즉 이 사이트의 "해야 할 일" 상태는:

- `GET /rest/api/2/issue/{key}` 같은 필드 조회 API → 지역화된 이름("해야 할 일")을 돌려준다.
- `GET .../transitions`도 지역화된 이름을 돌려주고, `POST .../transitions`도 그 이름으로 정상
  동작한다 (M1에서 이미 확인, 위 단락).
- 하지만 **JQL의 `status = "..."` 절은 지역화된 이름이 아니라 시스템 기본 상태의 영문 canonical
  이름("To Do"/"In Progress"/"Done")으로만 매칭된다.** 지역화된 이름 문자열을 그대로 넣으면
  조용히 0건을 반환할 뿐 에러가 나지 않아 알아채기 어렵다.

이는 §"transition/status 이름은 로케일에 따라 지역화" 항목과는 다른, 더 미묘한 함정이다.
transition 이름 매칭(`transitionIssue`)은 같은 지역화된 문자열끼리 비교하므로 문제가 없지만,
`jira.jql`에 넣는 상태 이름은 **REST API가 보여주는 이름이 아니라 Jira 워크플로우의 실제 상태
이름(커스텀 워크플로우면 그 이름, 기본/심플 워크플로우면 영문 "To Do" 등)을 써야 한다.**
확실하지 않으면 `statusCategory = "To Do"`처럼 카테고리로 필터링하는 편이 로케일에 안전하다.

`ggjira.config.example.json`과 실제 `ggjira.config.json`은 이제 `status = "To Do"`를 쓴다.
커스텀 워크플로우를 쓰는 프로젝트라면 Jira 프로젝트 설정의 워크플로우 화면에서 실제 상태 이름을
확인하거나, `statusCategory` 기반 JQL로 대체해야 한다.

## Consequences

- SDK 추상화 비용 없이 필요한 호출만 최소로 구현한다.
- API 버전/엔드포인트가 바뀌면 이 문서와 `src/jira/client.ts`를 함께 갱신해야 한다.
- 댓글 서식은 wiki markup 수준으로 제한된다 (충분히 MVP 요구를 만족).
- transition/status 이름의 지역화는 설정 실수의 흔한 원인이 될 수 있으므로, `jira:smoke`를
  프로젝트 설정 전 필수 절차로 README/runbook에 명시한다.
- `jira.jql`의 `status =` 절은 지역화된 표시 이름이 아니라 워크플로우의 실제(대개 영문) 상태
  이름을 써야 한다. 이 함정은 에러 없이 조용히 0건을 반환하므로, config 작성 시 반드시 JQL을
  한 번 직접(`jira:smoke`나 `once`) 실행해 후보 이슈가 실제로 잡히는지 확인해야 한다.
