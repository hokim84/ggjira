// Review queue: current review targets and per-item judgments (F01, ADR 0043).

import { admin } from "./api.js";
import { errorNotice, fill, h, notice, relativeTime } from "./dom.js";
import {
  COMMIT_LABELS,
  JUDGMENT_LABELS,
  REVIEW_CLASS,
  RISK_LABELS,
  verificationSummary,
} from "./views-issues.js";

const REVIEWER_KEY = "ggjira.router.reviewer";

const STATE_LABELS = {
  pending: ["확인 기록 없음", "badge-muted"],
  held: ["보류 의견 있음", "badge-warn"],
  confirmed: ["확인", "badge-ok"],
  rework_requested: ["재작업 요청", "badge-warn"],
  merged: ["머지됨", "badge-ok"],
  outdated: ["새 승인 있음", "badge-muted"],
};

function readReviewer() {
  try {
    return sessionStorage.getItem(REVIEWER_KEY) || "";
  } catch {
    return "";
  }
}

function rememberReviewer(name) {
  try {
    sessionStorage.setItem(REVIEWER_KEY, name);
  } catch {
    // Asked again after a reload then.
  }
}

/** Optional human notes inside one task; never a workflow approval step. */
export function renderIssueReview(root, ctx, issueKey) {
  const reviewerInput = h("input", {
    type: "text",
    id: "reviewer",
    placeholder: "예: 홍길동",
    autocomplete: "name",
    value: readReviewer(),
  });
  reviewerInput.addEventListener("change", () => rememberReviewer(reviewerInput.value.trim()));
  const listEl = h("div", {}, h("p", { class: "muted" }, "불러오는 중…"));
  // Outlives a reload of the list, unlike a card's own message.
  const flashEl = h("div");

  function query() {
    const params = new URLSearchParams();
    params.set("issue", issueKey);
    params.set("state", "pending,held,confirmed,rework_requested,merged");
    const text = params.toString();
    return text ? `?${text}` : "";
  }

  async function load() {
    try {
      const { items } = await admin("GET", `/reviews${query()}`);
      fill(listEl, cards(items, "아직 확인 가능한 실행 결과가 없습니다."));
    } catch (error) {
      if (error.status === 401) return ctx.logout();
      fill(listEl, errorNotice(error));
    }
  }

  function cards(items, empty) {
    if (!items.length) return h("p", { class: "muted" }, empty);
    return h("div", { class: "review-list" }, items.map(reviewCard));
  }

  /** One target; its buttons and messages are its own, so a failure here leaves the rest alone. */
  function reviewCard(item) {
    const { target } = item;
    const { assessment } = target;
    const [classLabel, classTone] = REVIEW_CLASS[target.reviewClass] || [target.reviewClass, ""];
    const [stateLabel, stateTone] = STATE_LABELS[item.state] || [item.state, "badge-muted"];
    const v = assessment.verification;
    const messageEl = h("div");
    const noteInput = h("textarea", {
      rows: "2",
      placeholder: "보류·재작업 요청은 사유가 필요합니다. Jira 댓글로 남습니다.",
    });
    const buttons = [
      ["confirm", "결과 확인 기록", "btn btn-primary"],
      ["hold", "보류 의견 남기기", "btn"],
      ["rework", "수정 요청 남기기", "btn"],
    ].map(([, label, cls]) => h("button", { type: "button", class: `${cls} btn-small` }, label));
    const [confirmButton, holdButton, reworkButton] = buttons;

    async function judge(action) {
      const reviewer = reviewerInput.value.trim();
      if (!reviewer) {
        fill(messageEl, notice("warn", "위에 기록자 이름을 먼저 적으세요."));
        reviewerInput.focus();
        return;
      }
      const note = noteInput.value.trim();
      if (action !== "confirm" && !note) {
        fill(messageEl, notice("warn", "사유를 적으세요. Jira 댓글에 그대로 남습니다."));
        noteInput.focus();
        return;
      }
      rememberReviewer(reviewer);
      fill(flashEl);
      for (const button of buttons) button.disabled = true;
      try {
        await admin(
          "POST",
          `/reviews/${encodeURIComponent(target.id)}/judgments`,
          { action, ...(note ? { note } : {}) },
          reviewer,
        );
        await load();
      } catch (error) {
        for (const button of buttons) button.disabled = false;
        if (error.status === 401) return ctx.logout();
        if (error.code === "stale_review_target") {
          fill(
            flashEl,
            notice(
              "warn",
              `${target.issueKey}: 그 사이 새 결과가 나와 판단을 기록하지 않았습니다. 새로 불러온 항목을 보고 다시 판단하세요.`,
            ),
          );
          await load();
          return;
        }
        fill(messageEl, errorNotice(error));
      }
    }
    confirmButton.addEventListener("click", () => judge("confirm"));
    holdButton.addEventListener("click", () => judge("hold"));
    reworkButton.addEventListener("click", () => judge("rework"));

    const commit = assessment.commit;
    return h(
      "article",
      { class: "worker review-card" },
      h(
        "header",
        { class: "worker-head" },
        h(
          "div",
          {},
          h(
            "a",
            { href: item.issueUrl, target: "_blank", rel: "noopener noreferrer" },
            h("strong", {}, target.issueKey),
          ),
          item.issue.summary ? h("span", { class: "muted" }, ` · ${item.issue.summary}`) : null,
        ),
        h(
          "div",
          { class: "worker-badges" },
          h("span", { class: `badge ${classTone}` }, classLabel),
          h("span", { class: `badge ${stateTone}` }, stateLabel),
        ),
      ),
      h(
        "dl",
        { class: "worker-meta" },
        h("dt", {}, "결과"),
        h(
          "dd",
          {},
          item.result.summary || "(요약 없음)",
          h(
            "span",
            { class: "muted" },
            ` · ${({ planning: "계획", implementation: "구현", assemble_pr: "부모 PR 생성", integration_check: "통합 검증", quality_review: "이전 AI 리뷰" })[target.kind] ?? target.kind} · ${relativeTime(target.createdAt)}`,
          ),
        ),
        h("dt", {}, "검증 결과"),
        h("dd", {}, verificationSummary(v)),
        h("dt", {}, "위험"),
        h(
          "dd",
          {},
          RISK_LABELS[assessment.risk.status] || assessment.risk.status,
          assessment.risk.agentRisks.length
            ? h("span", {}, ` · 에이전트 보고 ${assessment.risk.agentRisks.length}건`)
            : null,
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
        h("dt", {}, "링크"),
        h(
          "dd",
          {},
          item.result.pullRequest
            ? h(
                "a",
                { href: item.result.pullRequest.url, target: "_blank", rel: "noopener noreferrer" },
                `PR #${item.result.pullRequest.number}`,
              )
            : h("span", { class: "muted" }, "PR 없음"),
        ),
        item.judgment ? h("dt", {}, "마지막 판단") : null,
        item.judgment
          ? h(
              "dd",
              {},
              `${JUDGMENT_LABELS[item.judgment.action] || item.judgment.action} · ${item.judgment.actor ?? "?"} · ${relativeTime(item.judgment.at)}`,
              item.judgment.detail?.note
                ? h("div", { class: "hint" }, item.judgment.detail.note)
                : null,
            )
          : null,
      ),
      h(
        "details",
        {},
        h("summary", {}, "자세히"),
        h(
          "dl",
          { class: "worker-meta" },
          h("dt", {}, "커밋"),
          h(
            "dd",
            {},
            COMMIT_LABELS[commit.state] || commit.state,
            commit.headSha ? h("code", {}, ` ${commit.headSha.slice(0, 12)}`) : null,
            commit.baseSha
              ? h("span", { class: "muted" }, ` (base ${commit.baseSha.slice(0, 12)})`)
              : null,
            commit.location ? h("span", { class: "muted" }, ` ${commit.location}`) : null,
          ),
          h("dt", {}, "고위험 근거"),
          h(
            "dd",
            {},
            assessment.risk.basis,
            assessment.risk.policyVersion
              ? h("span", { class: "muted" }, ` (규칙 ${assessment.risk.policyVersion})`)
              : null,
            assessment.risk.matches.length
              ? h(
                  "ul",
                  { class: "blockers" },
                  assessment.risk.matches.map((match) =>
                    h(
                      "li",
                      {},
                      `${match.rule}: ${match.from ? `${match.from} → ` : ""}${match.path} (${match.change})`,
                    ),
                  ),
                )
              : null,
            assessment.risk.agentRisks.length
              ? h(
                  "ul",
                  { class: "blockers" },
                  assessment.risk.agentRisks.map((risk) =>
                    h("li", {}, `${risk.area}: ${risk.description}`),
                  ),
                )
              : null,
          ),
          item.result.changes.length ? h("dt", {}, "변경") : null,
          item.result.changes.length
            ? h(
                "dd",
                {},
                h(
                  "ul",
                  { class: "blockers" },
                  item.result.changes.map((change) => h("li", {}, change)),
                ),
              )
            : null,
          h("dt", {}, "식별"),
          h(
            "dd",
            {},
            h("code", {}, target.id),
            h("span", { class: "muted" }, ` · job ${target.jobId} · attempt ${target.attemptId}`),
          ),
        ),
      ),
      h("div", { class: "field" }, noteInput),
      h("div", { class: "worker-actions" }, ...buttons),
      messageEl,
    );
  }

  const filters = h(
    "form",
    { class: "panel" },
    h(
      "div",
      { class: "field" },
      h("label", { for: "reviewer" }, "기록자 이름"),
      reviewerInput,
      h(
        "small",
        { class: "hint" },
        "결과 확인 기록과 Jira 댓글에 표시할 이름입니다. 본인 인증을 거친 이름은 아닙니다.",
      ),
    ),
    h(
      "div",
      { class: "form-actions" },
      h("button", { type: "submit", class: "btn" }, "최신 결과 불러오기"),
    ),
  );
  filters.addEventListener("submit", (event) => {
    event.preventDefault();
    load();
  });

  fill(
    root,
    notice(
      "info",
      "선택적인 결과 확인·의견 기록입니다. 보류 의견은 실행을 멈추지 않고 수정 요청은 AI를 다시 실행하지 않습니다. 두 의견은 Jira 댓글로 전달됩니다. 단, AI가 확인하지 못한 완료 조건이 있는 하위 작업은 결과 확인 기록이 그 확인을 대신해 AI 구현 완료로 옮겨집니다(Jira에서 직접 옮겨도 같습니다). 실제 재실행은 Jira에서 승인하며, PR 검토·병합은 GitHub에서 진행하세요.",
    ),
    filters,
    flashEl,
    listEl,
  );
  load();
}
