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

const USAGE_WINDOW_LABELS = { five_hour: "5시간", seven_day: "주간" };

function untilTime(iso) {
  if (!iso) return "";
  const minutes = Math.round((Date.parse(iso) - Date.now()) / 60000);
  if (minutes <= 0) return "리셋됨";
  if (minutes < 60) return `${minutes}분 후 리셋`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}시간 ${minutes % 60}분 후 리셋`;
  return `${Math.floor(minutes / 1440)}일 ${Math.floor((minutes % 1440) / 60)}시간 후 리셋`;
}

function usageWindow(window) {
  const percent = Math.min(100, Math.max(0, window.usedPercent));
  const tone = percent >= 90 ? "bad" : percent >= 70 ? "warn" : "ok";
  const label =
    USAGE_WINDOW_LABELS[window.id] ||
    (window.windowMinutes ? `${window.windowMinutes}분` : window.id);
  // CSP (style-src 'self') blocks style attributes; CSSOM writes are allowed.
  const fillEl = h("span", { class: `usage-fill usage-${tone}` });
  fillEl.style.width = `${percent}%`;
  return h(
    "div",
    { class: "usage-window", title: window.resetsAt || "" },
    h("span", { class: "usage-label" }, label),
    h(
      "span",
      {
        class: "usage-bar",
        role: "meter",
        "aria-valuemin": "0",
        "aria-valuemax": "100",
        "aria-valuenow": String(percent),
        "aria-label": `${label} 사용량`,
      },
      fillEl,
    ),
    h("span", { class: "usage-percent" }, `${window.usedPercent}%`),
    h("span", { class: "muted usage-reset" }, untilTime(window.resetsAt)),
  );
}

// Plan usage per provider, as the worker last reported it on connect or after a job (ADR 0028).
function providerUsage(list) {
  if (!list.length) return h("span", { class: "muted" }, "보고 없음 (워커 연결 시 갱신)");
  return h(
    "div",
    { class: "usage-list" },
    list.map((usage) =>
      h(
        "div",
        { class: "usage" },
        h(
          "div",
          { class: "usage-head" },
          h("span", { class: "tag" }, usage.providerId),
          h(
            "span",
            { class: "muted" },
            [usage.providerType, usage.planType].filter(Boolean).join(" · "),
          ),
          usage.status && usage.status !== "allowed"
            ? h(
                "span",
                { class: `badge badge-${usage.status === "rejected" ? "bad" : "warn"}` },
                usage.status === "rejected" ? "한도 도달" : "한도 임박",
              )
            : null,
          h(
            "small",
            { class: "muted", title: usage.observedAt },
            `${relativeTime(usage.observedAt)} · ${usage.source === "job" ? "작업 후" : "연결 시"}`,
          ),
        ),
        usage.windows.map(usageWindow),
        usage.error ? h("div", { class: "muted" }, usage.error) : null,
      ),
    ),
  );
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

  function copyRow(label, value) {
    return h(
      "div",
      { class: "secret-row" },
      h("span", { class: "secret-label" }, label),
      h("code", { class: "secret-value" }, value),
      copyButton(value),
    );
  }

  function showPairing(workerId, code, firstTime) {
    const expires = new Date(code.expiresAt).toLocaleTimeString();
    const body = firstTime
      ? [
          h("p", {}, "워커 머신의 ggjira 폴더에서 아래 명령을 실행하고, 묻는 대로 입력하세요."),
          copyRow("1. 실행", "npm run dev -- worker start"),
          copyRow("2. Router 주소", location.origin),
          copyRow("3. 페어링 코드", code.pairingCode),
          h(
            "small",
            { class: "hint" },
            "이어서 LLM(Claude Code/Codex)과, clone URL이 없는 저장소의 로컬 폴더를 묻습니다. 다음부터는 1번 명령만 실행하면 됩니다.",
          ),
        ]
      : [
          h(
            "p",
            {},
            "워커 머신의 ggjira 폴더에서 실행하세요. 기존 워커 설정은 두고 인증만 새로 받습니다.",
          ),
          copyRow("실행", `npm run dev -- worker setup --pairing-code ${code.pairingCode} --force`),
        ];
    fill(
      pairingEl,
      notice(
        "info",
        h("strong", {}, `${workerId} 페어링 코드 — ${expires}까지 (10분, 1회용)`),
        ...body,
        h(
          "small",
          { class: "hint" },
          " ggjira 명령을 설치(npm run build && npm link)했다면 npm run dev -- 대신 ggjira를 써도 됩니다. 다른 컴퓨터의 워커라면 Router 주소로 외부 HTTPS 주소를 쓰세요.",
        ),
      ),
    );
    pairingEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  async function pair(worker) {
    clear(messageEl);
    clear(pairingEl);
    try {
      const code = await admin("POST", "/pairing-codes", { workerId: worker.workerId });
      showPairing(worker.workerId, code, !worker.paired);
    } catch (error) {
      messageEl.append(errorNotice(error));
    }
  }

  const addEl = h("div");
  async function openAddForm() {
    clear(messageEl);
    clear(pairingEl);
    let repositories = [];
    try {
      const view = await admin("GET", "/config");
      repositories = view.file?.repositories ?? [];
    } catch (error) {
      fill(addEl, errorNotice(error));
      return;
    }
    const idInput = h("input", {
      type: "text",
      id: "new-worker-id",
      placeholder: "예: build-server-1",
      autocomplete: "off",
      spellcheck: "false",
    });
    const capsInput = h("input", {
      type: "text",
      id: "new-worker-caps",
      value: "programming, testing",
      autocomplete: "off",
    });
    const repoBoxes = repositories.map((repo, i) =>
      h(
        "label",
        { class: "check-option" },
        h("input", { type: "checkbox", value: repo.id, checked: i === 0 }),
        ` ${repo.displayName ? `${repo.displayName} (${repo.id})` : repo.id}`,
        repo.cloneUrl ? null : h("small", { class: "hint" }, " — cloneUrl 없음"),
      ),
    );
    const formMessage = h("div");
    const form = h(
      "form",
      { class: "panel" },
      h("h2", {}, "워커 추가"),
      h(
        "div",
        { class: "grid" },
        h("div", { class: "field" }, h("label", { for: "new-worker-id" }, "workerId"), idInput),
        h(
          "div",
          { class: "field" },
          h("label", { for: "new-worker-caps" }, "허용 capabilities"),
          capsInput,
          h("small", { class: "hint" }, "쉼표로 구분"),
        ),
      ),
      h(
        "fieldset",
        { class: "repo-options" },
        h("legend", {}, "작업할 저장소"),
        repoBoxes.length ? repoBoxes : h("p", { class: "muted" }, "설정에 저장소가 없습니다."),
      ),
      h(
        "small",
        { class: "hint" },
        "cloneUrl이 있는 저장소는 워커가 처음 실행할 때 자동으로 clone합니다. 설정 > 저장소에서 넣을 수 있습니다.",
      ),
      formMessage,
      h(
        "div",
        { class: "form-actions" },
        h("button", { type: "button", class: "btn", onclick: () => clear(addEl) }, "취소"),
        h("button", { type: "submit", class: "btn btn-primary" }, "추가하고 페어링 코드 발급"),
      ),
    );
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      clear(formMessage);
      const body = {
        workerId: idInput.value.trim(),
        allowedCapabilities: capsInput.value
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
        allowedRepositoryIds: repoBoxes
          .map((label) => label.querySelector("input"))
          .filter((input) => input.checked)
          .map((input) => input.value),
      };
      try {
        const result = await admin("POST", "/workers", body);
        clear(addEl);
        showPairing(result.worker.workerId, result, true);
        await refresh();
      } catch (error) {
        if (error.status === 401) return ctx.logout();
        formMessage.append(errorNotice(error));
      }
    });
    fill(addEl, form);
    idInput.focus();
  }

  function row(worker) {
    const [label, tone] = workerBadge(worker);
    const actions = [];
    if (worker.declared && !worker.revokedAt) {
      actions.push(
        h(
          "button",
          { type: "button", class: "btn btn-small", onclick: () => pair(worker) },
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
        h(
          "div",
          { class: "worker-badges" },
          worker.usagePressure === "exhausted"
            ? h(
                "span",
                {
                  class: "badge badge-bad",
                  title: "한도 창이 리셋될 때까지 새 작업을 배정하지 않습니다",
                },
                "LLM 한도 — 배정 제외",
              )
            : worker.usagePressure === "high"
              ? h(
                  "span",
                  {
                    class: "badge badge-warn",
                    title: "여유 있는 다른 워커가 있으면 그쪽에 먼저 배정합니다",
                  },
                  "LLM 한도 임박 — 후순위",
                )
              : null,
          h("span", { class: `badge badge-${tone}` }, label),
        ),
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
        h("dt", {}, "LLM 사용량"),
        h("dd", {}, providerUsage(worker.providerUsage || [])),
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
          : h("p", { class: "muted" }, "아직 워커가 없습니다. '워커 추가'로 시작하세요."),
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
      h(
        "button",
        { type: "button", class: "btn btn-primary title-action", onclick: () => openAddForm() },
        "워커 추가",
      ),
    ),
    addEl,
    messageEl,
    pairingEl,
    listEl,
  );
  ctx.every(5000, refresh);
}
