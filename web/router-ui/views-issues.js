// Read-only issue status, delegation and review history.

import { admin } from "./api.js";
import { clear, errorNotice, fill, h, notice } from "./dom.js";
import { renderIssueReview } from "./views-reviews.js";

const LAST_KEY = "ggjira.router.issueKey";

const JOB_KIND_LABELS = {
  planning: "계획",
  implementation: "구현",
  assemble_pr: "부모 통합 PR 생성",
  integration_check: "병합 후 통합 검증",
  quality_review: "이전 AI 리뷰",
};

const JOB_STATE_LABELS = {
  waiting: "대기(조건)",
  queued: "큐",
  leased: "실행 준비 중",
  running: "실행 중",
  cancel_requested: "취소 요청",
  recovery_required: "복구 필요",
  succeeded: "실행 완료",
  cancelled: "중단됨",
  failed: "실패",
  timed_out: "시간 초과",
};

/** A failed run keeps its approval's slot (ADR 0021): it does not run again by itself. */
const STOPPED_JOB_STATES = new Set(["failed", "timed_out", "recovery_required"]);

export const REVIEW_CLASS = {
  immediate: ["결과에 주의사항 있음", "badge-warn"],
  standard: ["선택적 결과 확인", "badge-muted"],
};

export const RISK_LABELS = {
  high: "고위험",
  not_matched: "규칙 불일치(저위험 확정 아님)",
  unknown: "미확인",
  not_applicable: "해당 없음",
};

export const JUDGMENT_LABELS = {
  "judgment.confirm": "확인",
  "judgment.hold": "보류",
  "judgment.rework": "재작업 요청",
};

/** One line for a review assessment's verification tally; the method counts exist only on
 *  assessments recorded after ADR 0059. */
export function verificationSummary(v) {
  if (!v.reported) return "보고 없음";
  const methods =
    v.executed !== undefined ? ` (실행 ${v.executed} · 코드 확인 ${v.inspected ?? 0})` : "";
  return `통과 ${v.pass} · 실패 ${v.fail} · 미검증 ${v.notVerified}${methods}`;
}

export const COMMIT_LABELS = {
  committed: "커밋",
  no_commit: "커밋 없음",
  unknown: "미보고",
  not_applicable: "해당 없음",
};

const ATTENTION_KINDS = {
  failed: "실행 실패",
  decision_needed: "결정 필요",
  scope_deviation: "범위 이탈",
  review_required: "결과에 주의사항 있음",
  report_blocked: "Jira 반영 막힘",
  plan_approval_refused: "계획 승인 아님",
  unassigned: "담당자 없음",
  pull_request_unchecked: "PR 확인 실패",
};

/** Delegation stages (src/router/issue-delegation.ts): what it is, and the next move in Jira. */
const DELEGATION_STAGES = {
  not_delegated: [
    "AI에 맡기지 않음",
    (s) =>
      `계획부터 맡기려면 Jira에서 "${s.request}"로, 간단한 작업을 바로 구현시키려면 "${s.inProgress}"으로 옮기세요.`,
  ],
  plan_requested: ["계획 요청됨", () => "워커가 계획을 쓰기를 기다립니다."],
  planning: ["계획 작성 중", () => "계획이 끝나면 같은 상태에서 검토할 수 있습니다."],
  plan_failed: ["계획 실패", () => '원인을 해결한 뒤 담당자가 "재시도" 댓글을 남기세요.'],
  plan_held: ["계획 복구 대기", () => "이전 실행의 종료를 확인하거나 관리자 복구가 필요합니다."],
  plan_review: [
    "구현할 작업 선택 대기",
    (s) =>
      `계획을 읽고 실행할 개별 작업을 "${s.inProgress}"으로 옮기세요. 바꾸려면 AI 계획으로 재계획하세요.`,
  ],
  plan_needs_decision: [
    "결정 필요",
    (s) =>
      "담당자가 선택지 번호만 댓글로 남기세요(예: 2). AI 계획중에서 자동으로 계획을 이어갑니다.",
  ],
  approved_waiting: ["승인됨 · 계획 반영 대기", () => "계획이 Jira에 다 반영되면 시작합니다."],
  running: [
    "승인된 계획 실행",
    (s) => `철회하려면 "${s.inProgress}" 밖으로 옮기세요. 실행 중이면 몇 초 안에 중단 요청됩니다.`,
  ],
  coordinating: [
    "하위 작업 조정",
    (s) =>
      "자식을 개별 승인합니다. 모두 구현 완료되면 부모 PR 하나를 만들고, 사람의 병합 후 부모 통합 검증을 진행합니다.",
  ],
  task: [
    "승인된 계획의 하위 작업",
    (s) =>
      `부모 계획의 하위 작업입니다. 새 구현은 "${s.inProgress}"으로 개별 승인하고, 실행 실패 후에는 원인을 해결한 뒤 담당자가 ‘재시도’ 댓글을 남기세요.`,
  ],
  integration_pending: [
    "통합 대기",
    () =>
      "PR을 머지하고 통합 검증을 기다리세요. 실패하면 원인 해결 후 담당자가 재시도 댓글을 남기세요.",
  ],
  implementation_complete: [
    "구현 완료",
    () =>
      "자식은 부모 PR의 구성 결과로 보존됩니다. 부모·단독 작업은 통합 검증을 마쳤으며 Done은 수동입니다. 기술부채 추이는 병합 후 별도로 확인합니다.",
  ],
  done: ["완료", () => "끝났습니다."],
};

const DEPLOYMENT_STATES = {
  waiting_plan_apply: "반영 대기",
  active: "실행 허용",
  completed: "완료",
  revoked: "철회",
};

/** ADR 0044: the stage, the plan and its approval, and what a person does next. */
function delegationRows(view) {
  const d = view.delegation;
  const [label] = DELEGATION_STAGES[d.stage] || [d.stage];
  return [
    d.quality ? h("dt", {}, "부모 통합 진행") : null,
    d.quality
      ? h(
          "dd",
          {},
          `${d.quality.completed}/${d.quality.total} 자식 구현 완료 · ${({ children_waiting: "나머지 자식 완료·통합 PR 준비 대기", pr_waiting: "통합 PR 게시 완료 · 사람의 병합 대기", running: "부모 PR 구성 또는 병합 후 통합 검증 중", succeeded: "부모 통합 검증 완료", queued: "워커 대기", leased: "실행 준비", failed: "부모 단계 실패 · 원인 확인 후 재시도 댓글", stale: "대상 갱신 필요", passed: "검증 통과" })[d.quality.state] ?? d.quality.state}${d.quality.targetSha ? ` · ${d.quality.targetSha.slice(0, 12)}` : ""}`,
        )
      : null,
    h("dt", {}, "작업 단계"),
    h(
      "dd",
      {},
      h("span", { class: "badge badge-ok" }, label),
      d.parentKey ? h("span", { class: "muted" }, ` (${d.parentKey}의 계획)`) : null,
    ),
    d.plan ? h("dt", {}, "계획") : null,
    d.plan
      ? h(
          "dd",
          {},
          d.plan.taskIds.length ? `하위 작업 ${d.plan.taskIds.length}개` : "이슈 자체 작업",
          h("details", {}, h("summary", {}, "계획 식별 정보"), h("code", {}, d.plan.version)),
          d.plan.closed ? h("span", { class: "muted" }, " (닫힘)") : null,
        )
      : null,
    d.deployment ? h("dt", {}, "승인") : null,
    d.deployment
      ? h(
          "dd",
          {},
          DEPLOYMENT_STATES[d.deployment.state] || d.deployment.state,
          " ",
          h(
            "details",
            {},
            h("summary", {}, "승인 식별 정보"),
            h("code", {}, d.deployment.approvalId),
          ),
          d.deployment.reason ? h("div", { class: "hint" }, d.deployment.reason) : null,
        )
      : null,
    d.heldBy ? h("dt", {}, "보류") : null,
    d.heldBy ? h("dd", {}, `${d.heldBy} — 이 승인으로는 실행하지 않습니다`) : null,
  ];
}

function nextAction(d, job) {
  if (d.humanCheck?.length)
    return `AI가 확인하지 못한 완료 조건이 있습니다: ${d.humanCheck.join(" / ")}. 직접 확인한 뒤 Jira에서 이슈를 "${d.statuses.implementationComplete}"(으)로 옮기세요(검토 화면의 "결과 확인 기록"도 같습니다).`;
  if (d.stage === "done")
    return "완료된 작업입니다. 필요한 경우 실행 기록과 기술부채 추이를 참고하세요.";
  if (job?.kind === "integration_check" && ["queued", "leased", "running"].includes(job.state))
    return "PR 병합 후 통합 검증이 대기 또는 실행 중입니다. 검증 결과를 기다리세요.";
  if (d.stage === "implementation_complete")
    return d.parentKey
      ? "자식 구현 결과가 보존됐습니다. 부모 작업의 PR 생성·통합 검증 진행을 확인하세요."
      : "통합 검증 결과를 확인하고 Jira에서 Done으로 옮기세요. 구조 부채 지수는 별도 참고 지표입니다.";
  if (d.quality) {
    const text = {
      children_waiting:
        "미완료 자식의 승인·진행을 Jira에서 확인하세요. 모든 자식이 끝나면 부모 PR이 생성됩니다.",
      pr_waiting: "GitHub에서 부모 PR을 검토하고 병합하세요. 병합 후 통합 검증을 진행합니다.",
      running: "부모 PR 생성 또는 병합 후 통합 검증을 진행 중입니다. 결과를 기다리세요.",
      queued: "부모 작업을 실행할 워커를 기다립니다.",
      leased: "부모 작업 실행을 준비 중입니다.",
      failed: "부모 단계 실패 원인을 해결한 뒤 Jira 담당자가 ‘재시도’ 댓글을 남기세요.",
      passed: "통합 검증 결과를 확인하고 Jira에서 Done으로 옮기세요.",
      succeeded: "통합 검증 결과를 확인하고 Jira에서 Done으로 옮기세요.",
      stale: "입력이나 대상 커밋이 바뀌었습니다. Jira의 승인 상태와 최신 실행을 확인하세요.",
    }[d.quality.state];
    if (text) return text;
  }
  return (
    DELEGATION_STAGES[d.stage]?.[1] ?? (() => "Jira에서 현재 단계와 승인 상태를 확인하세요.")
  )(d.statuses);
}

/** Opens the issue view on `key` (used by the dashboard's attention list). */
export function openIssue(key) {
  rememberKey(key);
  location.hash = `#/tasks?issue=${encodeURIComponent(key)}`;
}

/** The current review target (M4-11): which queue, why, which commit, and the high-risk call. */
function reviewSection(targets, records) {
  const target = targets.find((entry) => !entry.supersededBy);
  if (!target) return null;
  const judgments = records.filter(
    (record) => record.targetId === target.id && record.action.startsWith("judgment."),
  );
  const { assessment } = target;
  const [label, tone] = REVIEW_CLASS[target.reviewClass] || [target.reviewClass, "badge-muted"];
  const commit = assessment.commit;
  return h(
    "section",
    { class: "panel" },
    h("h2", {}, "실행 결과 ", h("span", { class: `badge ${tone}` }, label)),
    h(
      "dl",
      { class: "worker-meta" },
      h("dt", {}, "결과"),
      h("dd", {}, `${JOB_KIND_LABELS[target.kind] ?? target.kind} · ${target.createdAt}`),
      h("dt", {}, "커밋"),
      h(
        "dd",
        {},
        COMMIT_LABELS[commit.state] || commit.state,
        commit.headSha ? h("code", {}, ` ${commit.headSha.slice(0, 12)}`) : null,
        commit.location ? h("span", { class: "muted" }, ` ${commit.location}`) : null,
      ),
      h("dt", {}, "고위험"),
      h(
        "dd",
        {},
        RISK_LABELS[assessment.risk.status] || assessment.risk.status,
        h("span", { class: "muted" }, ` — ${assessment.risk.basis}`),
        assessment.risk.policyVersion
          ? h("span", { class: "muted" }, ` (규칙 ${assessment.risk.policyVersion})`)
          : null,
      ),
      h("dt", {}, "검증 결과"),
      h("dd", {}, verificationSummary(assessment.verification)),
      assessment.reasons.length ? h("dt", {}, "사유") : null,
      assessment.reasons.length
        ? h(
            "dd",
            {},
            h(
              "ul",
              { class: "blockers" },
              assessment.reasons.map((reason) => h("li", {}, reason.detail)),
            ),
          )
        : null,
      judgments.length ? h("dt", {}, "판단") : null,
      judgments.length
        ? h(
            "dd",
            {},
            h(
              "ul",
              { class: "blockers" },
              judgments.map((record) =>
                h(
                  "li",
                  {},
                  `${JUDGMENT_LABELS[record.action] || record.action} · ${record.actor ?? "?"} · ${record.at}`,
                  record.detail?.note ? h("div", { class: "hint" }, record.detail.note) : null,
                ),
              ),
            ),
          )
        : null,
    ),
    h(
      "small",
      { class: "hint" },
      "결과·커밋 추적 기록입니다. 선택적인 확인·의견은 아래에서 남길 수 있습니다. 부모·단독 PR은 사람이 병합한 뒤 대상 커밋으로 통합 검증을 진행합니다.",
    ),
  );
}

/** Attention items for the issue (M4-09): open first, then the history. */
function attentionSection(items) {
  const open = items.filter((item) => item.status === "open");
  const resolved = items.filter((item) => item.status !== "open");
  return h(
    "div",
    {},
    open.length ? attentionListSection(open) : null,
    resolved.length
      ? h(
          "details",
          { class: "panel" },
          h("summary", {}, `해소된 주의 기록 ${resolved.length}개`),
          attentionListSection(resolved),
        )
      : null,
  );
}
function attentionListSection(items) {
  if (!items.length) return null;
  return h(
    "section",
    { class: "panel" },
    h("h2", {}, "주의 항목"),
    h(
      "ul",
      { class: "blockers" },
      items.map((item) =>
        h(
          "li",
          {},
          h(
            "span",
            { class: `badge ${item.status === "open" ? "badge-bad" : "badge-muted"}` },
            item.status === "open" ? "미해결" : "해소",
          ),
          " ",
          h("strong", {}, ATTENTION_KINDS[item.kind] || item.kind),
          item.occurrences > 1 ? ` · ${item.occurrences}회` : "",
          h("div", { class: "hint" }, item.reason),
          item.previousId ? h("div", { class: "hint" }, "이전에 해소된 같은 사건의 재발") : null,
          item.resolution
            ? h("div", { class: "hint" }, `해소: ${item.resolution} (${item.resolvedAt})`)
            : null,
        ),
      ),
    ),
  );
}

function readLastKey() {
  try {
    return sessionStorage.getItem(LAST_KEY) || "";
  } catch {
    return "";
  }
}

function rememberKey(key) {
  try {
    sessionStorage.setItem(LAST_KEY, key);
  } catch {
    // Not remembered across reloads then.
  }
}

export function renderIssues(root, ctx) {
  const keyInput = h("input", {
    type: "text",
    id: "issue-key",
    placeholder: "예: KAN-12",
    autocomplete: "off",
    spellcheck: "false",
    value: new URLSearchParams(location.hash.split("?")[1] ?? "").get("issue") ?? readLastKey(),
  });
  const resultEl = h(
    "div",
    {},
    h("p", { class: "muted", role: "status" }, "Jira의 현재 상태를 불러오는 중입니다…"),
  );
  const historyEl = h("div");
  const messageEl = h("div");
  const notesEl = h("div");
  let notesKey = null;
  let requestedKey = null;

  function openJob(view) {
    if (!view.openJob) return h("span", { class: "muted" }, "실행 중인 작업 없음");
    const kind = JOB_KIND_LABELS[view.openJob.kind] || view.openJob.kind;
    const state = JOB_STATE_LABELS[view.openJob.state] || view.openJob.state;
    const stopped = STOPPED_JOB_STATES.has(view.openJob.state);
    return h(
      "p",
      {},
      h("span", { class: `badge ${stopped ? "badge-bad" : "badge-ok"}` }, `${kind} 작업 ${state}`),
      " ",
      h("details", {}, h("summary", {}, "실행 식별 정보"), h("code", {}, view.openJob.jobId)),
      stopped
        ? h(
            "div",
            { class: "hint" },
            "실패 원인을 해결한 뒤 Jira 담당자가 ‘재시도’ 댓글을 남기세요. 범위를 바꿔야 한다면 Jira에서 AI 계획으로 옮겨 새 계획을 요청하세요.",
          )
        : null,
    );
  }

  function draw(view) {
    fill(
      resultEl,
      notice("info", h("strong", {}, "다음 할 일: "), nextAction(view.delegation, view.openJob)),
      h(
        "article",
        { class: "worker" },
        h(
          "header",
          { class: "worker-head" },
          h(
            "div",
            {},
            h(
              "a",
              { href: view.issueUrl, target: "_blank", rel: "noopener noreferrer" },
              h("strong", {}, view.issueKey),
            ),
            h("span", { class: "muted" }, ` · ${view.summary}`),
          ),
        ),
        h(
          "dl",
          { class: "worker-meta" },
          h("dt", {}, "상태"),
          h("dd", {}, view.statusName),
          h("dt", {}, "Jira 라벨"),
          h(
            "dd",
            {},
            view.labels.length
              ? h(
                  "span",
                  { class: "tags" },
                  view.labels.map((label) => h("span", { class: "tag" }, label)),
                )
              : h("span", { class: "muted" }, "없음"),
          ),
          h("dt", {}, "연결 정보"),
          h(
            "dd",
            {},
            h(
              "details",
              {},
              h("summary", {}, "프로젝트 연결 식별자"),
              h("code", {}, view.workspaceId),
            ),
          ),
          ...delegationRows(view),
          h("dt", {}, "현재 실행"),
          h("dd", {}, openJob(view)),
        ),
      ),
    );
    if (view.latestResult)
      resultEl.append(
        h(
          "section",
          { class: "panel" },
          h("h2", {}, "최근 실행 결과"),
          h("p", {}, view.latestResult.summary),
          view.latestResult.pullRequest
            ? h(
                "a",
                { href: view.latestResult.pullRequest.url, target: "_blank", rel: "noreferrer" },
                `GitHub에서 PR #${view.latestResult.pullRequest.number} 보기`,
              )
            : null,
        ),
      );
    const currentFci = (view.fci ?? []).filter((a) => a.profile?.staticAnalysis && !a.superseded);
    if (currentFci.length)
      resultEl.append(
        h(
          "section",
          { class: "panel" },
          h("h2", {}, "구조 부채 평가 결과"),
          h(
            "p",
            { class: "muted" },
            "실험적 상대 지표입니다. 개발 비용·시간·장애 확률이 아닙니다.",
          ),
          currentFci.map((a) =>
            h(
              "p",
              {},
              h(
                "a",
                {
                  href: `#/repositories?repository=${encodeURIComponent(a.repository_id)}&commit=${encodeURIComponent(a.after_sha)}`,
                },
                `PR 병합 후 평가 · ${{ queued: "대기", running: "평가 중", succeeded: "완료", failed: "실패", unassessable: "평가 불가" }[a.status] ?? a.status}: ${a.beforeFci?.toFixed(1) ?? "—"} → ${a.afterFci?.toFixed(1) ?? "—"} / 변화 ${a.delta?.toFixed(1) ?? "—"}`,
              ),
              a.error ? ` · ${a.error}` : "",
            ),
          ),
        ),
      );
  }

  async function load(key) {
    requestedKey = key;
    const encoded = encodeURIComponent(key);
    if (notesKey !== key) {
      notesKey = key;
      const body = h("div");
      const section = h(
        "details",
        { class: "panel" },
        h("summary", {}, "결과 확인·의견 남기기 (선택)"),
        body,
      );
      let loaded = false;
      section.addEventListener("toggle", () => {
        if (section.open && !loaded) {
          loaded = true;
          renderIssueReview(body, ctx, key);
        }
      });
      fill(notesEl, section);
    }
    // Router's own records do not need Jira, so they show even when the Jira read fails.
    Promise.all([
      admin("GET", `/issues/${encoded}/reviews`),
      admin("GET", `/attention?status=all&issue=${encoded}`),
    ])
      .then(([reviews, attention]) => {
        if (requestedKey !== key || !historyEl.isConnected) return;
        fill(
          historyEl,
          attentionSection(attention.items),
          h(
            "details",
            { class: "panel" },
            h("summary", {}, "실행 결과·확인 기록"),
            reviewSection(reviews.targets, reviews.records),
            h(
              "details",
              {},
              h("summary", {}, "전체 이력·내부 식별 정보"),
              h("pre", { class: "preview" }, JSON.stringify(reviews, null, 2)),
            ),
          ),
        );
      })
      .catch((error) => {
        if (requestedKey === key) fill(historyEl, errorNotice(error));
      });
    try {
      const view = await admin("GET", `/issues/${encoded}`);
      if (requestedKey === key && resultEl.isConnected) draw(view);
    } catch (error) {
      if (requestedKey !== key) return;
      if (error.status === 401) return ctx.logout();
      fill(resultEl, errorNotice(error));
    }
  }

  const form = h(
    "form",
    { class: "panel" },
    h(
      "div",
      { class: "field" },
      h("label", { for: "issue-key" }, "작업 키"),
      keyInput,
      h(
        "small",
        { class: "hint" },
        "이슈의 현재 작업과 보류 이유, 상태 기반 위임 단계와 다음 행동을 확인합니다.",
      ),
    ),
    h(
      "div",
      { class: "form-actions" },
      h("button", { type: "submit", class: "btn btn-primary" }, "조회"),
    ),
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const key = keyInput.value.trim().toUpperCase();
    if (!key) return;
    keyInput.value = key;
    rememberKey(key);
    clear(messageEl);
    if (new URLSearchParams(location.hash.split("?")[1] ?? "").get("issue") !== key) openIssue(key);
    else load(key);
  });

  fill(
    root,
    h(
      "div",
      { class: "title-row" },
      h("h1", {}, "작업 상세"),
      h("small", { class: "muted" }, "15초마다 갱신"),
    ),
    form,
    h(
      "p",
      {},
      "Jira의 현재 단계와 대기·실패 이유를 확인하는 화면입니다. 계획·구현 승인은 Jira에서, PR 검토·병합은 GitHub에서 진행합니다.",
    ),
    h("a", { href: "#/" }, "대시보드 작업 목록으로 돌아가기"),
    messageEl,
    resultEl,
    historyEl,
    notesEl,
  );
  // Picks up label/status changes made in Jira itself; skipped while a write is in flight.
  ctx.every(15000, () => {
    if (requestedKey === null && keyInput.value.trim()) load(keyInput.value.trim().toUpperCase());
    else if (requestedKey) load(requestedKey);
  });
}
