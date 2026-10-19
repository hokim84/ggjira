// Issue view: one issue's AI participation (label mode, M4-04, ADR 0039; delegation mode,
// ADR 0044 — where it stands, the next move in Jira, no label toggle).

import { admin } from "./api.js";
import { clear, errorNotice, fill, h, notice } from "./dom.js";

const LAST_KEY = "ggjira.router.issueKey";

const JOB_KIND_LABELS = { planning: "계획", implementation: "구현" };

const JOB_STATE_LABELS = {
  waiting: "대기(조건)",
  queued: "큐",
  leased: "임대",
  running: "실행 중",
  cancel_requested: "취소 요청",
  recovery_required: "복구 필요",
  failed: "실패",
  timed_out: "시간 초과",
};

/** A failed run keeps its approval's slot (ADR 0021): it does not run again by itself. */
const STOPPED_JOB_STATES = new Set(["failed", "timed_out", "recovery_required"]);

/** Why it would not start and what a person does about it (codes from src/router/issue-opt-in.ts). */
const BLOCKERS = {
  opt_in_missing: [() => "opt-in 라벨이 없습니다", "아래 버튼으로 AI 참여를 켜세요."],
  not_requested: [
    (view) => `요청 상태("${view.requestStatus}")가 아닙니다`,
    "AI에게 (다시) 맡길 때만 Jira에서 요청 상태로 옮기세요. 검토·완료 중이면 그대로 두면 됩니다.",
  ],
  no_assignee: [() => "담당자가 없습니다", "Jira에서 담당자(인간 책임자)를 지정하세요."],
  inputs_changed: [
    () => "승인 뒤 요청 내용이 바뀌었습니다",
    "내용을 확인하고 AI 참여를 껐다 켜서 새로 승인하세요.",
  ],
  approval_held: [
    () => "관리자가 이 승인의 작업을 취소했습니다",
    "다시 맡기려면 AI 참여를 껐다 켜세요(새 승인).",
  ],
  readiness_hold: [
    () => "구현 요청에 계약 절이 빠져 있습니다",
    "설명에 빠진 절을 채우면 다음 조회 때 시작됩니다.",
  ],
  not_label_mode: [
    () => "legacy workspace입니다",
    "AI 전용 상태로 요청합니다. 라벨은 쓰이지 않습니다.",
  ],
};

export const REVIEW_CLASS = {
  immediate: ["개별 검토 필요", "badge-bad"],
  standard: ["일반 검토 대기", "badge-ok"],
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
  review_required: "개별 검토 필요",
  readiness_hold: "계약 보완 필요",
  report_blocked: "Jira 반영 막힘",
  plan_approval_refused: "계획 승인 아님",
};

/** Delegation stages (src/router/issue-delegation.ts): what it is, and the next move in Jira. */
const DELEGATION_STAGES = {
  not_delegated: [
    "AI에 맡기지 않음",
    (s) =>
      `사람의 작업입니다. AI에 맡기려면 "${s.request}"로 옮기세요. 라벨은 아무것도 시작하지 않습니다.`,
  ],
  plan_requested: ["계획 요청됨", () => "워커가 계획을 쓰기를 기다립니다."],
  planning: ["계획 작성 중", (s) => `계획이 끝나면 "${s.planReview}"로 옮겨집니다.`],
  plan_review: [
    "계획 검토 대기",
    (s) =>
      `계획을 읽고, 승인하려면 "${s.planReview}" → "${s.inProgress}"로 옮기세요. 바꾸려면 설명을 고쳐 "${s.request}"로 옮기세요.`,
  ],
  plan_needs_decision: [
    "결정 필요",
    (s) =>
      `결정 요청 댓글에 "Decision: <id>"로 답한 뒤 "${s.request}"로 옮기세요. 이 상태로는 승인되지 않습니다.`,
  ],
  approved_waiting: ["승인됨 · 계획 반영 대기", () => "계획이 Jira에 다 반영되면 시작합니다."],
  running: [
    "승인된 계획 실행",
    (s) => `철회하려면 "${s.inProgress}" 밖으로 옮기세요. 실행 중이면 몇 초 안에 중단 요청됩니다.`,
  ],
  coordinating: [
    "하위 작업 조정",
    (s) =>
      `하위 작업이 승인된 계획으로 실행됩니다. 모두 "${s.done ?? "완료"}"면 "${s.review}"로 옮겨집니다.`,
  ],
  task: [
    "승인된 계획의 하위 작업",
    (s) =>
      `다시 실행하려면 "${s.inProgress}" 밖으로 옮겼다가 돌아오게 하세요(같은 계획 안의 재시도).`,
  ],
  result_review: ["결과 검토", () => "검토 화면에서 판단을 남기거나 PR을 머지하세요."],
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
  const [label, next] = DELEGATION_STAGES[d.stage] || [d.stage, () => ""];
  return [
    h("dt", {}, "위임 단계"),
    h(
      "dd",
      {},
      h("span", { class: "badge badge-ok" }, label),
      d.parentKey ? h("span", { class: "muted" }, ` (${d.parentKey}의 계획)`) : null,
      h("div", { class: "hint" }, next(d.statuses)),
    ),
    d.plan ? h("dt", {}, "계획") : null,
    d.plan
      ? h(
          "dd",
          {},
          h("code", {}, d.plan.version),
          ` · ${d.plan.outcome}`,
          d.plan.taskIds.length ? ` · 하위 작업 ${d.plan.taskIds.join(", ")}` : " · 이슈 자체",
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
          h("code", {}, d.deployment.approvalId),
          d.deployment.reason ? h("div", { class: "hint" }, d.deployment.reason) : null,
        )
      : null,
    d.heldBy ? h("dt", {}, "보류") : null,
    d.heldBy ? h("dd", {}, `${d.heldBy} — 이 승인으로는 실행하지 않습니다`) : null,
  ];
}

/** Opens the issue view on `key` (used by the dashboard's attention list). */
export function openIssue(key) {
  rememberKey(key);
  location.hash = "#/issues";
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
    h("h2", {}, "검토 대상 ", h("span", { class: `badge ${tone}` }, label)),
    h(
      "dl",
      { class: "worker-meta" },
      h("dt", {}, "결과"),
      h("dd", {}, `${target.kind} · ${target.resultStatus} · ${target.createdAt}`),
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
      h("dt", {}, "acceptance"),
      h(
        "dd",
        {},
        assessment.verification.reported
          ? `통과 ${assessment.verification.pass} · 실패 ${assessment.verification.fail} · 미검증 ${assessment.verification.notVerified}`
          : "보고 없음",
      ),
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
      "표시만 합니다. 판단(확인·보류·재작업 요청)은 검토 화면에서 남깁니다. PR 머지는 이 커밋과 같을 때만 완료로 옮겨집니다.",
    ),
  );
}

/** Attention items for the issue (M4-09): open first, then the history. */
function attentionSection(items) {
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
    value: readLastKey(),
  });
  const resultEl = h("div");
  const historyEl = h("div");
  const messageEl = h("div");
  let current = null;
  let busy = false;

  function blockerList(view) {
    if (view.openJob) {
      const kind = JOB_KIND_LABELS[view.openJob.kind] || view.openJob.kind;
      const state = JOB_STATE_LABELS[view.openJob.state] || view.openJob.state;
      const stopped = STOPPED_JOB_STATES.has(view.openJob.state);
      return h(
        "p",
        {},
        h(
          "span",
          { class: `badge ${stopped ? "badge-bad" : "badge-ok"}` },
          `${kind} 작업 ${state}`,
        ),
        " ",
        h("code", {}, view.openJob.jobId),
        stopped
          ? h(
              "div",
              { class: "hint" },
              view.mode === "label"
                ? "같은 승인으로는 다시 돌지 않습니다. 원인을 고친 뒤 요청 상태로 다시 옮기거나 AI 참여를 껐다 켜세요."
                : view.mode === "delegation"
                  ? "같은 승인으로는 다시 돌지 않습니다. 같은 계획으로 다시: 계획 검토 → 진행. 범위를 바꾸려면 요청 상태로 옮겨 다시 계획하세요."
                  : "같은 승인으로는 다시 돌지 않습니다. 원인을 고친 뒤 요청 상태로 다시 옮기세요.",
            )
          : null,
      );
    }
    if (!view.blockers.length) {
      return h(
        "p",
        {},
        h("span", { class: "badge badge-ok" }, "시작 가능"),
        " 다음 조회(최대 1분) 때 Router가 시작합니다.",
      );
    }
    return h(
      "ul",
      { class: "blockers" },
      view.blockers.map((blocker) =>
        h(
          "li",
          { title: blocker.message },
          h("strong", {}, BLOCKERS[blocker.code]?.[0](view) ?? blocker.message),
          blocker.missing?.length
            ? h("span", {}, " — 빠진 절: ", blocker.missing.join(", "))
            : null,
          BLOCKERS[blocker.code] ? h("div", { class: "hint" }, BLOCKERS[blocker.code][1]) : null,
        ),
      ),
    );
  }

  function toggle(view) {
    if (view.mode !== "label") return null;
    const turnOn = !view.optedIn;
    const button = h(
      "button",
      {
        type: "button",
        class: turnOn ? "btn btn-primary" : "btn btn-danger",
        disabled: busy,
        onclick: () => setOptIn(view.issueKey, turnOn),
      },
      busy ? "Jira에 반영하는 중…" : turnOn ? "AI 참여 켜기" : "AI 참여 끄기",
    );
    return h(
      "div",
      { class: "worker-actions" },
      button,
      h(
        "small",
        { class: "hint" },
        turnOn
          ? `라벨 "${view.optInLabel}"만 붙입니다. 실행 승인이 아니며, 요청 상태·담당자·계약 조건이 맞아야 시작합니다.`
          : view.openJob && !STOPPED_JOB_STATES.has(view.openJob.state)
            ? `라벨 "${view.optInLabel}"을 뗍니다. 열린 작업은 몇 초 안에 취소되거나 중단 요청됩니다. 이미 push된 변경은 되돌리지 않습니다.`
            : `라벨 "${view.optInLabel}"만 뗍니다. 다른 라벨은 그대로 둡니다.`,
      ),
    );
  }

  function draw(view) {
    current = view;
    fill(
      resultEl,
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
          h(
            "div",
            { class: "worker-badges" },
            view.mode === "delegation"
              ? h("span", { class: "badge badge-muted" }, "상태 위임")
              : view.mode !== "label"
                ? h("span", { class: "badge badge-muted" }, "legacy")
                : view.optedIn
                  ? h("span", { class: "badge badge-ok" }, "AI 참여 켜짐")
                  : h("span", { class: "badge badge-muted" }, "AI 참여 꺼짐"),
          ),
        ),
        h(
          "dl",
          { class: "worker-meta" },
          h("dt", {}, "상태"),
          h(
            "dd",
            {},
            view.statusName,
            h("span", { class: "muted" }, ` (요청 상태: ${view.requestStatus})`),
          ),
          h("dt", {}, "라벨"),
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
          h("dt", {}, "workspace"),
          h("dd", {}, view.workspaceId),
          ...(view.delegation ? delegationRows(view) : []),
          h("dt", {}, "Router"),
          h("dd", {}, view.delegation && !view.openJob ? "열린 작업 없음" : blockerList(view)),
        ),
        toggle(view),
      ),
    );
  }

  async function load(key) {
    const encoded = encodeURIComponent(key);
    // Router's own records do not need Jira, so they show even when the Jira read fails.
    Promise.all([
      admin("GET", `/issues/${encoded}/reviews`),
      admin("GET", `/attention?status=all&issue=${encoded}`),
    ])
      .then(([reviews, attention]) =>
        fill(
          historyEl,
          reviewSection(reviews.targets, reviews.records),
          attentionSection(attention.items),
        ),
      )
      .catch(() => clear(historyEl));
    try {
      draw(await admin("GET", `/issues/${encoded}/opt-in`));
    } catch (error) {
      if (error.status === 401) return ctx.logout();
      current = null;
      fill(resultEl, errorNotice(error));
    }
  }

  async function setOptIn(key, enabled) {
    if (busy) return;
    busy = true;
    clear(messageEl);
    if (current) draw(current);
    try {
      const result = await admin("PUT", `/issues/${encodeURIComponent(key)}/opt-in`, { enabled });
      busy = false;
      draw(result.view);
      messageEl.append(
        result.outcome === "unchanged"
          ? notice(
              "info",
              `이미 AI 참여가 ${enabled ? "켜져" : "꺼져"} 있습니다(Jira에서 먼저 바뀐 것 같습니다). 아무것도 쓰지 않았습니다.`,
            )
          : notice(
              "ok",
              `AI 참여를 ${enabled ? "켰습니다" : "껐습니다"}. Jira에서 다시 읽어 확인했습니다.`,
            ),
      );
    } catch (error) {
      busy = false;
      if (error.status === 401) return ctx.logout();
      messageEl.append(
        errorNotice(
          error.code === "unconfirmed"
            ? { message: `${error.message} — 반영 여부를 확인하지 못했습니다. 다시 조회해 보세요.` }
            : error,
        ),
      );
      await load(key);
    }
  }

  const form = h(
    "form",
    { class: "panel" },
    h(
      "div",
      { class: "field" },
      h("label", { for: "issue-key" }, "이슈 키"),
      keyInput,
      h(
        "small",
        { class: "hint" },
        "label 방식 workspace에서는 AI 참여(opt-in 라벨)를 켜거나 끄고, delegation 방식에서는 위임 단계와 다음에 옮길 상태를 봅니다.",
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
    load(key);
  });

  fill(
    root,
    h(
      "div",
      { class: "title-row" },
      h("h1", {}, "이슈"),
      h("small", { class: "muted" }, "15초마다 갱신"),
    ),
    form,
    messageEl,
    resultEl,
    historyEl,
  );
  // Picks up label/status changes made in Jira itself; skipped while a write is in flight.
  ctx.every(15000, () => {
    if (!busy && keyInput.value.trim()) load(keyInput.value.trim().toUpperCase());
  });
}
