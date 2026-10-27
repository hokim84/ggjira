# 보안 정책

## 지원 버전

가장 최근 릴리스만 보안 수정을 받는다. Router와 Worker는 같은 버전으로 올린다.

## 취약점 신고

공개 이슈에 올리지 말고 GitHub의 비공개 신고를 쓴다.
저장소의 **Security** 탭 > **Report a vulnerability**에서 다음을 적어 주세요.

- 영향받는 부분(Router 웹훅, Worker API, 관리 API·웹 UI, Worker 실행 등)과 버전
- 재현 방법과 예상되는 영향
- 실제 Jira 주소, 토큰, 이슈 내용은 지우고 보낸다

확인하면 답을 드리고, 수정이 릴리스될 때 함께 알립니다.

## 운영자가 지킬 것

- Router는 HTTPS 뒤에서만 공개한다(Caddy 또는 Cloudflare Tunnel, runbook §16·§16-1).
- `router.env`, `cloudflared.env`, 워커 홈의 `credential.json`은 0600으로 두고 저장소에 커밋하지 않는다.
- 설정 없이 띄운 Router는 셋업 마법사를 연다. 공개 주소에서 띄울 때는 먼저 설정 파일을 넣거나 접근을 막는다.
- 워커는 AI CLI가 저장소에서 명령을 실행하게 한다. 신뢰하는 Jira 프로젝트와 저장소만 연결한다.
