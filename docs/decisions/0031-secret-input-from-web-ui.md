# 0031. Jev API 키를 웹 UI에서 입력한다

## Context

Jev 키(`TYPESAFE_API_KEY`, ADR 0030)를 넣으려면 Router 머신에서 `router.env`를 고치고 Router를 재시작해야
했다. Router가 원격 서버에 있으면 번거롭다. 셋업 마법사는 이미 Jira API 토큰을 웹으로 받아 `router.env`에
쓴다(ADR 0023). 셋업이 끝난 뒤에는 비밀정보를 웹에서 바꿀 방법이 없었다. GitHub 비밀정보도 화면에는
"설정됨/안 됨"만 보인다.

웹 입력의 위험은 네 가지다. 평문 HTTP로 전송되는 것, 저장된 값이 화면에 다시 보이는 것, 로그·감사·설정
파일에 값이 남는 것, 줄바꿈 같은 문자로 env 파일에 다른 키를 끼워 넣는 것이다. 관리 토큰을 가진 사람은
이미 설정과 워커를 바꿀 수 있으므로, 키 교체 권한이 더해져도 위험이 크게 늘지 않는다.

## Decision

1. `PUT /api/v1/admin/secrets/jev` `{apiKey: string | null}`(관리 토큰 필요)로 키를 설정하거나 지운다.
   응답과 `GET /config`의 `jev`에는 `{apiKey: 설정 여부, source: environment|file|null, editable}`만
   담는다. **값은 어디서도 돌려주지 않는다.**
2. 값은 secrets 파일(`router.env`)에만 쓴다. `setSecretsFileValue`가 그 한 줄만 바꾸고 다른 줄과 주석은
   그대로 둔다. 원자적으로 쓰고 권한은 0600이다. 설정 JSON에는 넣지 않는다.
3. 형식은 `[A-Za-z0-9._~+/=:-]{8,512}`만 받는다. 공백, 줄바꿈, 따옴표, `#`을 거부해서 env 파일에 다른
   줄이 끼어들지 못하게 한다.
4. 저장하면 실행 중인 daemon의 키를 바로 바꾼다. 다음 `assess` 패스부터 새 키를 쓰고, 재시작은 필요 없다.
5. 환경변수 `TYPESAFE_API_KEY`가 있으면 그 값이 파일보다 우선한다. 파일을 바꿔도 적용되지 않으므로
   웹 변경을 409(`set_by_environment`)로 거부하고, 화면에 이유를 보인다.
6. 감사 기록에는 `secret.jev.set`/`secret.jev.removed`와 행위자만 남긴다.
7. 화면에서는 설정 폼 밖에 둔 입력 전용 비밀번호 칸을 쓴다. 저장하면 칸을 비운다.

## Consequences

- 원격 Router에서도 브라우저로 키를 넣고 바꿀 수 있다. 전송 보호는 기존 운영 규칙(원격은 Caddy HTTPS 뒤)에
  맡긴다. HTTP로 원격 접속하면 키가 평문으로 지나간다.
- 같은 방식을 GitHub 토큰과 웹훅 secret에도 적용할 수 있다. 필요해지면 이 ADR을 따라 추가한다.
