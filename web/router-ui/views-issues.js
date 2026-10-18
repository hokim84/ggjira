// Issue view: one issue's AI participation (label mode, M4-04, ADR 0039).

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
};

/** Why it would not start and what a person does about it (codes from src/router/issue-opt-in.ts). */
const BLOCKERS = {
  opt_in_missing: [() => "opt-in 라벨이 없습니다", "아래 버튼으로 AI 참여를 켜세요."],
  not_requested: [
    (view) => `요청 상태("${view.requestStatus}")가 아닙니다`,
    "Jira에서 이슈를 요청 상태로 옮기세요.",
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
  const messageEl = h("div");
  let current = null;
  let busy = false;

  function blockerList(view) {
    if (view.openJob) {
      const kind = JOB_KIND_LABELS[view.openJob.kind] || view.openJob.kind;
      const state = JOB_STATE_LABELS[view.openJob.state] || view.openJob.state;
      return h(
        "p",
        {},
        h("span", { class: "badge badge-ok" }, `${kind} 작업 ${state}`),
        " ",
        h("code", {}, view.openJob.jobId),
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
          : view.openJob
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
            view.mode !== "label"
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
          h("dt", {}, "Router"),
          h("dd", {}, blockerList(view)),
        ),
        toggle(view),
      ),
    );
  }

  async function load(key) {
    try {
      draw(await admin("GET", `/issues/${encodeURIComponent(key)}/opt-in`));
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
        "label 방식 workspace의 이슈에서 AI 참여(opt-in 라벨)를 확인하고 켜거나 끕니다.",
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
  );
  // Picks up label/status changes made in Jira itself; skipped while a write is in flight.
  ctx.every(15000, () => {
    if (!busy && keyInput.value.trim()) load(keyInput.value.trim().toUpperCase());
  });
}
