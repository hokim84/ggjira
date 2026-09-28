# 0027. 워커가 PR을 열고, 머지되면 Router가 Jira를 완료로 옮긴다

## Context

워커는 작업 브랜치를 원격에 push한다(ADR 0026). 사람은 원격에서 결과를 검토하고 합친다. 합친 뒤 Jira
이슈를 `완료`로 옮기는 일은 손으로 해야 했다. 검토 상태 뒤에 push용 상태를 따로 두는 방법도 있지만,
Jira 상태가 git 단계를 따라가게 되고 관리할 전이만 늘어난다. 반영 결정은 사람이 쥐어야 한다는 원칙은
그대로 둔다.

## Decision

1. **PR은 워커가 만든다.** 저장소 설정에 `createPullRequest: true`이고 원격이 GitHub이면, push한 뒤 워커
   머신의 `gh` 로그인으로 `gh pr create`를 실행한다. 같은 브랜치의 PR이 이미 있으면 그 PR을 쓴다.
   결과에 `pullRequest {repo, number, url}`을 담는다. 실패해도 작업은 성공이고, 댓글에 실패 사유와 PR 생성
   링크를 적는다. **Router는 GitHub 쓰기 권한을 갖지 않는다.**
2. **Router는 PR과 작업의 연결을 SQLite `pull_requests`에 저장한다**(migration 5). 성공 결과에
   `pullRequest`가 있을 때만 저장하고, GGJIRA가 만든 PR만 추적한다.
3. **머지는 두 경로로 알아낸다.**
   - 웹훅 `POST /webhooks/github`: `X-Hub-Signature-256`(HMAC-SHA256, `GGJIRA_GITHUB_WEBHOOK_SECRET`)을
     검증하고, `X-GitHub-Delivery`로 중복을 거른다. secret이 없으면 이 경로 자체가 없다.
   - 폴링: `github.pollIntervalMs`(기본 5분)마다 열려 있는 PR을 GitHub API로 확인한다. 토큰
     (`GITHUB_TOKEN`, 읽기 전용)은 선택이고, 공개 저장소는 토큰 없이도 된다. 웹훅을 놓쳤거나 Router가
     외부에서 닿지 않는 로컬 환경을 위한 경로다.

   두 경로 모두 `handlePullRequestClosed` 하나로 처리한다. PR 행을 `open`에서 닫는 UPDATE가 한 번만
   성공하므로 같은 머지를 두 번 처리하지 않는다.
4. **머지되면 보고 저널로 Jira를 바꾼다.**
   - 댓글("PR #N merged by X")을 달고, workspace에 `doneStatus`가 있으면 이슈를 `reviewStatus`에서
     `doneStatus`로 옮긴다.
   - 검토 상태에 있을 때만 옮기고, 작업이 실행된 승인이 그대로일 때만 옮긴다. 사람이 이미 다른 상태로
     옮겼으면 그대로 둔다.
   - 머지 없이 닫히면 댓글만 단다.
5. `doneStatus`는 설정 화면의 상태 흐름과 `router check`의 "PR 머지 후 완료"(검토 → 완료) 전이 확인에
   포함된다.

## Consequences

- 흐름은 "AI 작업 → 검토 상태(PR 리뷰 대기) → 사람이 머지 → 자동으로 완료"가 된다.
- 워커 머신에 `gh` 로그인과 push 권한이 있어야 한다.
- 로컬 Router(127.0.0.1)에는 GitHub 웹훅이 닿지 않는다. 폴링(최대 5분 지연)이나
  `gh webhook forward`로 중계한다.
- 워커 PR이 아니라 사람이 직접 만든 PR은 추적하지 않는다.
