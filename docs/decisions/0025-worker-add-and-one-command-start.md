# 0025. 워커 추가와 한 명령 시작 (`worker start`)

## Context

워커를 붙이려면 다섯 단계를 거쳐야 했다. Router 설정에 정책을 선언하고, 페어링 코드를 발급하고,
워커에서 `worker setup`을 실행한다. 그다음 `worker.config.json`의 저장소 경로, capabilities,
provider를 손으로 채우고 `worker run`을 실행한다. capabilities, 저장소 id, providerId는 이미 Router
정책에 있는 값이라 두 번 입력하는 셈이었다. 워커 머신에서 사람이 고를 것은 사실상 어떤 LLM CLI로
작업을 돌릴지 하나뿐이다. 저장소의 로컬 경로는 Router가 알 수 없으니 따로 정해야 한다.

## Decision

1. **워커 추가 = 정책 선언 + 적용 + 페어링 코드 발급.** `POST /api/v1/admin/workers`
   (웹 UI 워커 화면의 "워커 추가")가 설정 파일 `workers[]`에 정책을 추가한다. 이어서 바로 적용하고
   (ADR 0024) 첫 페어링 코드를 발급한다. 이미 있는 workerId는 409다. 감사 기록은 `config.updated`와
   `worker.added`다. 페어링 코드 규칙(10분, 1회용, workerId 바인딩)은 그대로다. 코드는 등록하는
   순간에만 필요하다.
2. **페어링 응답에 워커 프로필을 싣는다.** `workers/register` 응답에 `profile`이 추가된다(선택 필드라
   프로토콜 버전은 그대로). 내용은 허용 capabilities, providerId, 허용 저장소의 `id`·`cloneUrl`·
   `baseBranch`다.
3. **저장소는 Router의 `cloneUrl`로 워커가 직접 clone한다.** Router 설정 `repositories[]`에 선택 필드
   `cloneUrl`, `baseBranch`를 둔다. 워커는 `<dataDir>/repos/<id>`에 clone한다. 로컬 경로는 여전히
   워커가 정하고, Router는 URL만 준다.
   - `cloneUrl`은 `https://`, `ssh://`, `file://`, `user@host:path`만 허용한다(`CloneUrlSchema`,
     Router와 워커 양쪽에서 검증).
   - 워커는 `git -c protocol.ext.allow=never clone … -- <url> <dest>`로 옵션 주입과 명령 실행형
     transport를 막는다.
   - 검증 명령(`validateCommand`)은 Router가 내려주지 않는다. 워커는 Router가 보낸 명령을 실행하지
     않는다는 원칙 때문이다. 필요하면 워커 설정에서 직접 넣는다.
4. **`ggjira worker start`는 텍스트로 묻는 첫 설정을 한다.** 설정 파일이 없으면 터미널에서 차례로 묻는다.
   1. **Router 주소**: 기본값은 `http://127.0.0.1:8787`이다. URL 규칙과 `/health` 응답을 확인하고, 틀리면
      다시 묻는다.
   2. **LLM**: 설치된 `claude`/`codex`를 감지한다. 하나면 자동으로 쓰고, 여럿이면 번호로 고른다. 페어링
      코드보다 **먼저** 고르므로, CLI가 없어서 실패해도 코드가 소모되지 않는다.
   3. **페어링 코드**: 거절되면(틀림, 만료) 코드를 쓰지 않은 상태로 다시 묻는다.
   4. **저장소 폴더**: `cloneUrl`이 있으면 Enter로 `<dataDir>/repos/<id>`에 자동 clone하거나, 이미 clone해
      둔 폴더 경로를 입력한다. `cloneUrl`이 없으면 로컬 clone 폴더 경로를 입력받는다(존재 확인).

   그다음 설정을 쓰고, 필요한 저장소를 clone하고, 바로 실행한다. 워커 상태(credential, dataDir, 로그)는
   설정 파일과 같은 폴더의 `data/` 아래에 둔다. 이후에는 `worker start`만 실행하면 된다.
   - 저장된 설정의 저장소 폴더가 사라졌고 `cloneUrl`도 없으면, 다음 실행 때 폴더를 다시 묻고 설정에 저장한다.
   - 터미널이 아니면(서비스, CI) 물을 수 없다. 같은 답을 `--router`, `--pairing-code`, `--provider`로
     주고, 저장소는 `cloneUrl` 또는 설정 파일로 해결한다.
   - 웹 UI는 "실행 명령, Router 주소, 페어링 코드"를 각각 복사할 수 있게 보여준다. 실행 명령은 이
     레포에서 바로 되는 `npm run dev -- worker start`다.
   - 기존 `worker setup`·`worker run`은 수동 구성용으로 그대로 둔다.

## Consequences

- 워커 연결은 웹에서 "워커 추가"를 누르고, 워커 머신에서 `worker start`를 실행해 묻는 말(주소, LLM, 코드,
  필요하면 저장소 폴더)에 답하면 된다.
- 워커 머신에 git 접근 권한(SSH 키, credential helper 등)이 있어야 자동 clone이 된다. 권한이 없으면
  clone 실패를 보고하고 멈춘다.
- 워커 설정은 페어링 시점의 정책으로 만들어진다. 이후 Router에서 capabilities나 저장소를 바꿔도 워커
  설정은 자동으로 바뀌지 않는다. 배정은 Router 정책과 워커 보고의 교집합이라, 좁히는 변경은 바로
  반영된다. 넓히는 변경은 워커 설정도 고쳐야 한다.
