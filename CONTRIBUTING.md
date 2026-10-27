# 기여하기

GGJIRA에 관심을 가져 주셔서 고맙습니다. 버그 제보, 문서 수정, 기능 제안 모두 환영합니다.

## 이슈

- **버그:** 실행한 명령, 기대한 결과, 실제 결과(오류 메시지·로그 일부)를 적어 주세요.
  `ggjira --version`, OS, Node.js 버전, 사용하는 AI CLI(Claude Code / Codex)도 함께 적어 주세요.
  로그에 Jira 주소·토큰·이슈 내용이 있으면 지우고 올립니다.
- **보안 문제**는 공개 이슈로 올리지 말고 [SECURITY.md](./SECURITY.md)를 따릅니다.
- 큰 변경은 먼저 이슈로 방향을 맞춘 뒤 PR을 보내 주세요.

## 개발 환경

```bash
git clone https://github.com/hokim84/ggjira.git && cd ggjira
npm install            # Node.js 24 이상. 네이티브 빌드 도구는 필요 없다(ADR 0063)
npm run dev -- --help  # 소스에서 CLI 실행
npm run check          # typecheck + lint + format:check + test (CI와 같다)
```

Linux 전체 검사는 `docker compose -f docker-compose.test.yml run --rm --build check`로 돌린다.
Windows에서만 실패하는 테스트가 있으면 [runbook §13](./docs/runbook.md)을 본다.

## 변경 규칙

사람과 AI 에이전트 모두 [CLAUDE.md](./CLAUDE.md)의 규칙을 따른다. 요약하면 다음과 같다.

- `src/` 디렉터리는 실행 계층과 1:1이다. 워커 코드(`src/worker-runtime/`)는 Jira나 Router DB를 import하지 않는다.
- PR 전에 `npm run check`가 통과해야 하고, 바꾼 동작은 해당 테스트나 수동 명령으로 확인한다.
  어떤 테스트를 돌릴지는 runbook §46에 있다.
- 자동 테스트는 Fake만 쓴다. 실제 Jira·AI CLI 호출은 넣지 않는다.
- 설계 결정을 바꾸거나 새로 내리면 `docs/decisions/NNNN-제목.md`(Context / Decision / Consequences)를 추가한다.
  구조가 바뀌면 `docs/architecture.md`, 장애 진단 방법이 바뀌면 `docs/runbook.md`도 같은 PR에서 고친다.

## 릴리스 (관리자)

태그 하나가 npm 패키지 `ggjira`, Router 이미지 `ghcr.io/hokim84/ggjira-router`, GitHub 릴리스를 함께
만든다(ADR 0064, `.github/workflows/release.yml`).

1. `package.json`의 `version`과 `src/version.ts`의 `GGJIRA_VERSION`을 같은 값으로 올린다
   (`test/cli.test.ts`가 둘이 같은지 확인한다). `npm install`로 `package-lock.json`도 맞춘다.
2. main에 병합한 뒤 태그를 올린다.
   ```bash
   git tag v0.2.0 && git push origin v0.2.0
   ```
3. Actions의 Release가 검사 → npm publish → 이미지 push → 릴리스 생성 순으로 진행한다.
   태그와 `package.json` 버전이 다르면 첫 단계에서 멈춘다.

처음 한 번만 할 일:
- npm에서 `ggjira` 이름을 가진 계정으로 automation token을 만들어 저장소 Secrets에 `NPM_TOKEN`으로 넣는다.
- 첫 이미지가 올라간 뒤 GitHub > Packages > `ggjira-router` > Package settings에서 공개(Public)로 바꾼다.
  비공개로 두면 사용자의 `docker compose up`이 이미지를 받지 못하고 직접 빌드한다.
- Settings > Code security에서 Private vulnerability reporting을 켠다(SECURITY.md).

## 라이선스

기여한 코드는 저장소와 같은 [MIT 라이선스](./LICENSE)로 배포된다.
