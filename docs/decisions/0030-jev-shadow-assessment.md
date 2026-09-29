# 0030. Jev로 job을 관찰 모드로 평가한다

## Context

Jev(TypeSafe System One 모델, docs.typesafe.ai)는 입력을 읽고 요청마다 넘긴 선택지 중 하나를 고른다.
선택지별 확률과 확신도(0–1)를 함께 준다. 응답은 70–500ms이고 입력 100만 토큰당 $0.042다. GGJIRA에서
붙일 만한 판단은 두 가지다. job마다 모델 등급(작음/보통/큼)을 고르는 것과, 요청이 바로 구현할 만한지
(ready/needs_plan/unclear) 판단하는 것이다.

Jev는 영어가 주력이다. 한국어를 포함한 CJK는 "처리는 하지만 똑같이 잘하지는 않는다". 지금 Jira 이슈는
한국어다. 이슈 본문은 사용자 입력이라 판단을 흔드는 문장이 들어 있을 수 있다. 실제 이슈에서 판단이 맞는지
모르는 상태로 모델 선택이나 배정에 쓰면 안 된다.

## Decision

1. **관찰 모드로 시작한다.** Router가 새 job마다 Jev에 `modelTier`와 `readiness`를 한 번에 묻고,
   답(선택, 확률, 확신도)을 SQLite `job_assessments`에 저장한다(migration 7). 어떤 결정에도 쓰지 않는다.
2. **별도 루프에서 한다.** daemon의 `assess` 루프가 2초마다, 최근 24시간 안에 만들어졌고 아직 답이 없는
   job을 5개씩 평가한다(`src/router/assessment.ts`). reconcile, 배정, `jobs/next`와 분리돼 있어서 Jev가
   느리거나 실패해도 작업 흐름은 그대로다. 실패는 기록하고, job마다 최대 3번까지 다시 시도한다.
3. **입력은 필요한 것만 넣는다.** state는 job 종류, 이슈 유형, 제목, 설명(최대 12,000자)이다. 댓글은 넣지
   않는다. 질문과 선택지 설명은 영어로 쓰고, 이슈 본문은 원문 그대로 넘긴다.
4. **호출은 Router만 한다.** `src/router/jev.ts`가 `POST https://api.typesafe.ai/v1/systemone`을
   `fetch`로 직접 부른다. SDK는 쓰지 않는다. 429와 529는 백오프하며 3번까지 시도하고, 기본 타임아웃은
   5초다. 워커는 Jev를 모른다.
5. **키가 있을 때만 켜진다.** `TYPESAFE_API_KEY`를 환경변수 또는 `router.env`에서 읽는다. 설정
   `jev.enabled`(기본 true), `jev.model`(기본 `jev-latest`), `jev.timeoutMs`가 있다.

## Consequences

- 이슈 제목과 설명이 TypeSafe로 전송된다. 외부로 보내면 안 되는 프로젝트라면 키를 넣지 않거나
  `jev.enabled: false`로 둔다.
- 쌓인 평가를 실제 결과(성공·실패, 재시도, 걸린 시간, 사람이 계획으로 돌렸는지)와 비교해 두 가지를 정한다.
  하나는 한국어 이슈에서 쓸 만한지, 다른 하나는 판단별 확신도 기준이다(문서 권장은 자동 실행 0.9 초과,
  0.5 미만이면 쓰지 않음).
- 다음 단계는 각각 새 ADR로 정한다. `modelTier`로 모델을 고르려면 job envelope에 선택 필드와 워커의 등급별
  모델 매핑이 필요하다. `readiness`는 보류하고 댓글을 남기는 방식으로만 쓴다.
