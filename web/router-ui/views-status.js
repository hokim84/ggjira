// Dashboard and workers views (router mode).

import { admin } from "./api.js";
import { clear, fill, copyButton, duration, errorNotice, h, notice, relativeTime } from "./dom.js";

const JOB_STATE_LABELS = {
  waiting: "대기(조건)",
  queued: "큐",
  leased: "임대",
  running: "실행 중",
  cancel_requested: "취소 요청",
  succeeded: "성공",
  failed: "실패",
  timed_out: "시간 초과",
  cancelled: "취소됨",
  recovery_required: "복구 필요",
};

function card(label, value, tone) {
  return h(
    "div",
    { class: `card${tone ? ` card-${tone}` : ""}` },
    h("div", { class: "card-label" }, label),
    h("div", { class: "card-value" }, String(value)),
  );
}

export async function renderDashboard(root) {
  const status = await admin("GET", "/status");
  const { jobs, workers, queue, webhooks, reports, recoveryRequired } = status;
  fill(
    root,
    h("h1", {}, "대시보드"),
    h(
      "div",
      { class: "cards" },
      card(
        "온라인 워커",
        `${workers.online} / ${workers.declared}`,
        workers.online ? "ok" : "warn",
      ),
      card("페어링된 워커", workers.paired),
      card(
        "큐 대기",
        queue.waitMs === null ? "없음" : duration(queue.waitMs),
        queue.waitMs > 600_000 ? "warn" : null,
      ),
      card(
        "웹훅 처리 지연",
        webhooks.delayMs === null ? "없음" : duration(webhooks.delayMs),
        webhooks.delayMs > 60_000 ? "warn" : null,
      ),
      card("막힌 Jira 보고", reports.blocked, reports.blocked ? "bad" : null),
      card("복구 필요 작업", recoveryRequired, recoveryRequired ? "bad" : null),
    ),
    h("h2", {}, "작업 상태"),
    Object.keys(jobs).length === 0
      ? h("p", { class: "muted" }, "아직 작업이 없습니다.")
      : h(
          "div",
          { class: "cards cards-small" },
          Object.entries(jobs).map(([state, count]) =>
            card(JOB_STATE_LABELS[state] || state, count),
          ),
        ),
  );
}

function workerBadge(worker) {
  if (worker.revokedAt) return ["폐기됨", "bad"];
  if (!worker.declared) return ["설정에 없음", "warn"];
  if (!worker.paired) return ["페어링 대기", "muted"];
  if (!worker.enabled || !worker.policyEnabled) return ["비활성", "warn"];
  if (worker.online) return ["온라인", "ok"];
  return ["오프라인", "bad"];
}

function tags(items) {
  if (!items.length) return h("span", { class: "muted" }, "없음");
  return h(
    "span",
    { class: "tags" },
    items.map((item) => h("span", { class: "tag" }, item)),
  );
}

export function renderWorkers(root, ctx) {
  const listEl = h("div", { class: "worker-list" });
  const messageEl = h("div");
  const pairingEl = h("div");
  const armedRevoke = new Set();

  async function act(workerId, action) {
    clear(messageEl);
    try {
      await admin("POST", `/workers/${encodeURIComponent(workerId)}/${action}`);
      await refresh();
    } catch (error) {
      messageEl.append(errorNotice(error));
    }
  }

  async function pair(workerId) {
    clear(messageEl);
    clear(pairingEl);
    try {
      const code = await admin("POST", "/pairing-codes", { workerId });
      const command = `ggjira worker setup --router ${location.origin} --pairing-code ${code.pairingCode}`;
      pairingEl.append(
        notice(
          "info",
          h("strong", {}, `${workerId} 페어링 코드`),
          h(
            "p",
            {},
            `만료: ${new Date(code.expiresAt).toLocaleString()} — 워커 머신에서 실행하세요.`,
          ),
          h(
            "div",
            { class: "secret-row" },
            h("code", { class: "secret-value" }, command),
            copyButton(command),
          ),
          h(
            "small",
            { class: "hint" },
            "Router가 HTTPS 프록시 뒤에 있으면 --router에 외부 HTTPS 주소를 쓰세요.",
          ),
        ),
      );
    } catch (error) {
      messageEl.append(errorNotice(error));
    }
  }

  function row(worker) {
    const [label, tone] = workerBadge(worker);
    const actions = [];
    if (worker.declared && !worker.revokedAt) {
      actions.push(
        h(
          "button",
          { type: "button", class: "btn btn-small", onclick: () => pair(worker.workerId) },
          worker.paired ? "재페어링 코드" : "페어링 코드 발급",
        ),
      );
    }
    if (worker.paired && !worker.revokedAt) {
      actions.push(
        worker.enabled
          ? h(
              "button",
              {
                type: "button",
                class: "btn btn-small",
                onclick: () => act(worker.workerId, "disable"),
              },
              "비활성화",
            )
          : h(
              "button",
              {
                type: "button",
                class: "btn btn-small",
                onclick: () => act(worker.workerId, "enable"),
              },
              "활성화",
            ),
      );
      const armed = armedRevoke.has(worker.workerId);
      actions.push(
        h(
          "button",
          {
            type: "button",
            class: `btn btn-small btn-danger${armed ? " armed" : ""}`,
            onclick: () => {
              if (armed) {
                armedRevoke.delete(worker.workerId);
                act(worker.workerId, "revoke");
              } else {
                armedRevoke.add(worker.workerId);
                refresh();
              }
            },
          },
          armed ? "정말 폐기? 다시 클릭" : "폐기",
        ),
      );
    }
    return h(
      "article",
      { class: "worker" },
      h(
        "header",
        { class: "worker-head" },
        h(
          "div",
          {},
          h("strong", {}, worker.workerId),
          worker.name ? h("span", { class: "muted" }, ` · ${worker.name}`) : null,
        ),
        h("span", { class: `badge badge-${tone}` }, label),
      ),
      h(
        "dl",
        { class: "worker-meta" },
        h("dt", {}, "마지막 heartbeat"),
        h("dd", { title: worker.lastHeartbeatAt || "" }, relativeTime(worker.lastHeartbeatAt)),
        h("dt", {}, "현재 작업"),
        h(
          "dd",
          {},
          worker.activeAttempt
            ? `${worker.activeAttempt.jobId} (${worker.activeAttempt.state})`
            : "없음",
        ),
        h("dt", {}, "capabilities"),
        h("dd", {}, tags(worker.reportedCapabilities)),
        h("dt", {}, "저장소"),
        h("dd", {}, tags(worker.reportedRepositoryIds)),
      ),
      actions.length ? h("div", { class: "worker-actions" }, actions) : null,
    );
  }

  async function refresh() {
    try {
      const { workers } = await admin("GET", "/workers");
      fill(
        listEl,
        workers.length
          ? workers.map(row)
          : h("p", { class: "muted" }, "설정에 선언된 워커가 없습니다. 설정 화면에서 추가하세요."),
      );
    } catch (error) {
      if (error.status === 401) return ctx.logout();
      fill(listEl, errorNotice(error));
    }
  }

  fill(
    root,
    h(
      "div",
      { class: "title-row" },
      h("h1", {}, "워커"),
      h("small", { class: "muted" }, "5초마다 갱신"),
    ),
    h(
      "p",
      { class: "muted" },
      "설정 화면에서 워커를 추가하면 저장 즉시 여기서 페어링할 수 있습니다.",
    ),
    messageEl,
    pairingEl,
    listEl,
  );
  ctx.every(5000, refresh);
}
