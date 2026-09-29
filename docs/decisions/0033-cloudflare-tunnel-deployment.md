# 0033. Cloudflare Tunnel을 배포 방식으로 추가한다

## Context

Router는 Jira·GitHub 웹훅과 워커가 닿아야 하므로 공개 HTTPS 주소가 필요하다. 기존 배포(ADR 0022)는
Caddy가 80/443을 열고 인증서를 발급하는 방식이다. 운영자의 개인 서버는 Cloudflare로 외부에 노출하므로,
포트를 열지 않고 Cloudflare Tunnel(`cloudflared`)로 연결하는 편이 간단하고 안전하다.

Cloudflare를 앞에 두면 두 가지가 달라진다. Bot Fight Mode나 Browser Integrity Check가 켜져 있으면
브라우저가 아닌 요청(Jira·GitHub 웹훅, 워커의 Node `fetch`)이 차단되거나 확인 페이지를 받는다. 그리고
Cloudflare Access로 관리 화면에 로그인을 한 겹 더 걸 수 있다.

## Decision

1. `docker-compose.cloudflare.yml`을 추가한다. Router와 `cloudflared` 두 서비스만 두고, 호스트에 여는
   포트가 없다. 터널 토큰은 `deploy/config/cloudflared.env`(0600, git 무시)에 두어 Router 프로세스가 보지
   못하게 한다. `/data`는 named volume 대신 `deploy/data` 디렉터리를 쓴다. DB를 옮겨 오거나 백업을 서버
   밖으로 복사하는 일이 일반 파일 작업이 된다.
2. Router 코드는 바꾸지 않는다. 컨테이너는 이미 `--host 0.0.0.0`으로 뜨고, 인증은 서명·토큰으로 하며
   클라이언트 IP에 의존하지 않는다. `jobs/next`의 25초 대기는 Cloudflare의 100초 제한 안이다.
3. Cloudflare 쪽 설정은 runbook §16-1에 체크리스트로 둔다. `/webhooks/`, `/api/v1/workers/`,
   `/api/v1/jobs/`, `/health`는 봇 차단 예외로 둔다. Access는 `/ui/*`와 `/api/v1/admin/*`에만 권장한다.
4. Caddy 구성(`docker-compose.yml`)도 그대로 둔다. 둘 중 하나를 고른다.

## Consequences

- 서버에 포트를 열지 않고 공개 주소를 쓸 수 있고, 웹훅도 바로 받는다.
- Access를 걸면 서버 밖에서 관리 CLI(`--url`)를 쓸 수 없다. CLI는 Access 서비스 토큰 헤더를 보내지
  않는다. 필요해지면 CLI에 헤더 설정을 추가한다.
- 로컬 Router와 서버 Router를 동시에 켜면 같은 Jira에 두 번 쓴다. 옮길 때 로컬을 먼저 멈춘다(runbook).
