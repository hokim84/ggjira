# 0032. GitHub PR 확인 상태를 보여 주고, GitHub 토큰을 웹 UI에서 입력한다

## Context

KAN-32의 PR이 머지됐는데도 이슈가 `완료`로 넘어가지 않았다. 저장소는 비공개였고, Router에는
`GITHUB_TOKEN`이 없었다. GitHub은 토큰 없이 비공개 저장소를 조회하면 404를 준다. 그래서 5분마다 도는
폴링(ADR 0027)이 매번 실패했지만, 실패는 Router 터미널 로그에만 남았다. 설정 화면에는 "토큰 없이도 공개
저장소는 확인합니다"라고만 나와서 원인을 알 수 없었다. 토큰을 넣으려면 서버에서 `router.env`를 고치고
재시작해야 했다.

## Decision

1. **PR마다 마지막 확인 결과를 기록한다.** `pull_requests.last_checked_at`, `last_error`를 추가한다
   (migration 9). 폴링이 성공하면 오류를 지우고, 실패하면 원인을 적는다.
2. **실패 메시지에 해결 방법을 넣는다**(`pollErrorMessage`).
   - 404, 토큰 없음: "private repository needs GITHUB_TOKEN"
   - 404, 토큰 있음: 토큰이 이 저장소를 볼 수 없다(Pull requests 읽기 권한 필요)
   - 401: 토큰이 틀렸거나 만료됐다
   - 403, 429: 요청 한도 초과 또는 권한 없음
3. **설정 화면 GitHub 영역에 추적 중인 PR을 보인다.** 열린 PR이 먼저이고, 최근에 닫힌 PR이 뒤에 온다.
   각 PR의 상태, 마지막 확인 시각, 오류를 보이고 "지금 확인" 버튼(`POST /api/v1/admin/github/poll`)을 둔다.
4. **GitHub 토큰을 Jev 키와 같은 방식으로 웹에서 입력한다**(ADR 0031).
   - `PUT /api/v1/admin/secrets/github-token`으로 설정한다. 입력만 받고 값은 돌려주지 않는다.
   - `router.env`에 쓰고 재시작 없이 적용한다. 환경변수로 설정돼 있으면 바꿀 수 없다.
   - 감사 기록에는 `secret.github-token.set`/`removed`만 남긴다.
   - 저장하면 바로 폴링을 한 번 돌려서, 5분을 기다리지 않고 머지가 반영된다.
5. 비밀정보 입력은 하나의 방식으로 통일한다. 관리 서비스의 `setSecret(slot)`과 UI의 `secretInput`을
   공유한다. API 요청 본문은 `{value}`, 응답은 `{set, source, editable}`로 바꾼다.

## Consequences

- 비공개 저장소에서 토큰이 없으면 설정 화면에 "확인 실패"와 이유가 바로 보인다. 토큰을 넣으면 곧바로
  반영된다.
- 권장 토큰은 해당 저장소의 Pull requests 읽기 권한만 준 fine-grained 토큰이다. 로컬에서는
  `gh auth token`도 되지만 권한이 넓다.
- 웹훅 secret은 여전히 재시작해야 바뀐다(웹훅 경로를 등록하는 방식 때문이다).
