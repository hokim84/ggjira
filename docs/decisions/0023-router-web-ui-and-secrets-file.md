# 0023. Router 웹 UI, 셋업 모드, secrets 파일

## Context

5단계까지 Router 운영은 CLI로만 했다. 설정 파일은 손으로 쓰고(`router setup`은 템플릿만 만든다),
비밀정보는 환경변수로 넣고, 워커 상태는 `router status`/`workers list`로 봤다. 브라우저에서 최초
설치, 설정 편집, Jira 연결 점검, 워커 페어링을 하고 워커 상태를 볼 수 있게 한다. 여기에는 결정이
필요한 지점이 세 가지 있다.

- 비밀정보를 환경변수로만 받으면 웹 마법사가 입력받은 Jira token을 저장할 곳이 없다.
- 설정이 없으면 Router가 뜨지 않으니 마법사를 서빙할 수도 없다.
- 실행 중인 Router에 새 설정을 적용하는 방식을 정해야 한다.

## Decision

1. **정적 웹 UI를 Router가 직접 서빙한다.** `web/router-ui/`(빌드 없는 HTML + ES module + CSS,
   외부 CDN 없음)를 `/ui/`에서 서빙한다(`src/router/web-ui.ts`). `/`는 `/ui/`로 보낸다. 새 npm
   의존성이 없고, CSP `default-src 'self'`와 `X-Frame-Options: DENY`를 붙인다. 화면이 다루는 데이터는
   모두 기존 `/api/v1/admin/*`에서 오고, 로그인은 기존 admin token을 쓴다(브라우저 sessionStorage).
   Router는 여전히 HTTP만 서빙하고, 외부 노출은 Caddy HTTPS 뒤로만 한다.
2. **관리 API를 세 개 추가한다.**
   - `GET /api/v1/admin/config`: 설정 파일을 적힌 그대로 돌려준다. `restartRequired`는 파일 내용이
     기동 시 읽은 설정과 다르면 true다.
   - `PUT /api/v1/admin/config`: 스키마 검증에 실패하면 400과 path별 `issues`를 준다. 성공하면
     `.bak`을 남기고 tmp 파일에 쓴 뒤 rename한다. `audit_log`에 `config.updated`를 남긴다.
   - `POST /api/v1/admin/check`: `router check`를 **파일의** 설정으로 돌린다. 연결은 실행 중인 Router의
     Jira 연결을 쓴다.
3. **설정은 저장만 하고 재시작해야 적용된다.** 핫 리로드는 하지 않는다. WorkerService, 스케줄러,
   RuleDecisionProvider가 설정을 생성 시점에 잡고 있어서, 교체하면 진행 중인 임대와 판단이 섞인다.
   UI는 `restartRequired`면 배너를 띄운다. 설정에 새로 추가한 워커도 재시작 뒤에야 페어링할 수 있다.
4. **셋업 모드.** `router serve`는 설정 파일이 없거나 비밀정보가 불완전하면 DB와 Jira 루프 없이
   `SetupServer`(`src/router/setup-server.ts`)만 띄운다. 제공하는 경로는 `/health`
   (`mode: "setup"`), `/ui/`, `/api/v1/setup/*`다. 시작할 때 무작위 **setup token**을 콘솔에 출력하고,
   모든 셋업 API는 이 token을 bearer로 요구한다. `complete` 이후에는 410으로 막힌다.
   - 마법사는 입력받은 Jira 자격증명으로 인증 확인, 프로젝트 목록, 프로젝트 상태 목록을 조회한다.
   - 저장할 때 webhook secret과 admin token을 생성하고, 결과 화면에 한 번만 보여준다.
   - 설정 파일이 **있는데 잘못된** 경우는 지금처럼 에러로 종료한다. 마법사가 망가진 설정을 조용히
     덮어쓰지 않게 하기 위해서다.
5. **secrets 파일.** 환경변수 외에 `KEY=VALUE` 파일(docker `env_file`과 같은 형식, 권한 0600)에서도
   비밀정보를 읽는다. 위치는 `--secrets`, `GGJIRA_ROUTER_SECRETS`, 없으면 설정 파일 옆
   `router.env` 순서로 정한다. **환경변수가 우선**하고, 비어 있는 키만 파일에서 채운다. 설정 파일에는
   여전히 비밀정보를 넣지 않는다(계획 §3 원칙 유지). 관리 CLI도 `GGJIRA_ADMIN_TOKEN`이 없으면 이
   파일에서 admin token을 찾는다.
6. **Docker Compose는 설정 디렉터리를 쓰기 가능으로 마운트한다.** `./deploy/config:/config`로 두고,
   secrets 파일은 `/config/router.env`다. 단일 파일 bind mount는 rename 교체가 안 되기 때문이다.
   이미지 CMD는 `--host 0.0.0.0`으로 띄워 셋업 모드도 Caddy 뒤에서 열린다.

## Consequences

- 최초 설치는 `router serve` 실행, 콘솔의 setup token 입력, 마법사 진행, 재시작 순서로 끝난다.
  수동 설정(`router setup`, 예제 파일 복사)도 그대로 된다.
- 비밀정보가 디스크 파일에 남을 수 있다. 권한 0600과 `.gitignore`로 보호하고, 환경변수로 주면
  파일보다 우선한다.
- 셋업 모드를 외부에 노출하면 setup token만 알면 설정을 쓸 수 있다. 콘솔(컨테이너 로그)에만
  출력하고, 비 loopback에서는 경고를 남긴다. HTTPS 없이 원격에서 쓰지 않는다.
- 기존 Compose 배포는 `deploy/router.config.json`·`deploy/router.env`를 `deploy/config/`로 옮겨야
  한다(runbook §16).
- `web/router-ui/`는 계층 코드가 아니고 Router의 정적 자산이다. Dockerfile runtime 단계에 복사한다.
