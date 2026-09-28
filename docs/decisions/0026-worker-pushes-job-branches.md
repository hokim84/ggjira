# 0026. 워커가 작업 브랜치를 원격에 push한다

## Context

워커는 작업마다 `ggjira/<이슈>-<attempt>` 브랜치를 만들어 별도 worktree에서 커밋한다(ADR 0005 이후
구조). 결과는 워커가 쓰는 로컬 clone 안에만 남는다. 사람이 쓰는 저장소 폴더와 같은 폴더를 쓰면
`git merge`로 가져올 수 있지만, AI는 사람과 **별개의 로컬 clone**을 쓰기로 했다(`worker start`의
`cloneUrl` 자동 clone, ADR 0025). 그러면 사람은 워커 머신의 clone을 볼 방법이 없다. 결과를 전달할
통로가 필요하다.

## Decision

1. **워커 설정의 저장소에 `pushRemote`(예: `origin`)가 있으면, 성공한 작업 브랜치를 그 원격에
   push한다.** 순서는 커밋 → 검증 → push이고, 변경이 있을 때만 한다.
2. **push 직전에 Router에 실행 권한을 다시 묻는다**(`authorize` stage `push`, 커밋·검증과 같은 방식).
   승인이 철회됐으면 push하지 않고 `cancelled`로 끝낸다.
3. **인증은 워커 머신의 git 설정을 그대로 쓴다**(SSH 키, credential helper). Router는 git 자격 증명을
   다루지 않는다. 무인 실행이 멈추지 않도록 `GIT_TERMINAL_PROMPT=0`과 2분 제한을 둔다.
4. **push가 실패해도 작업은 성공으로 보고한다.** 커밋은 워커 clone에 있다. 대신 결과 artifacts에 실패
   사유와 수동 push 명령을 적고, 이 내용이 Jira 완료 댓글에 나온다. 성공하면 `pushed: <remote>/<branch>`와,
   GitHub 원격이면 PR 생성 링크를 적는다.
5. **`pushRemote`는 원격 이름만 받는다**(`^[A-Za-z0-9][A-Za-z0-9._-]*$`). URL이나 옵션은 받지 않는다.
   원격 주소는 워커 clone의 git 설정이 정한다.
6. **`worker start`가 만드는 설정은 `pushRemote: "origin"`이 기본값이다.** 지우면 push하지 않는다.

## Consequences

- 사람은 원격 저장소(GitHub 등)에서 브랜치나 PR로 결과를 검토하고 합친다. 자기 로컬 저장소는 AI와
  섞이지 않는다.
- 워커 머신에 원격 push 권한이 있어야 한다. 권한이 없으면 완료 댓글에 "push failed"가 나온다.
- 작업 브랜치가 원격에 쌓인다. 합친 뒤 브랜치 정리는 사람이나 원격 저장소 설정(병합 후 자동 삭제)이 맡는다.
