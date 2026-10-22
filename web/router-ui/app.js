// GGJIRA Router web UI: hash-routed shell. Setup mode shows only the wizard.

import { admin, getToken, health, setToken } from "./api.js";
import { clear, errorNotice, fill, h, notice } from "./dom.js";
import { renderCheck, renderConfig } from "./views-config.js";
import { renderFci } from "./views-fci.js";
import { renderGuide } from "./views-guide.js";
import { renderIssues } from "./views-issues.js";
import { renderPrompts } from "./views-prompts.js";
import { renderReviews } from "./views-reviews.js";
import { renderSetup } from "./views-setup.js";
import { renderDashboard, renderWorkers } from "./views-status.js";

const ROUTES = {
  "#/": { label: "대시보드", render: renderDashboard, poll: true },
  "#/workers": { label: "워커", render: renderWorkers },
  "#/repositories": { label: "저장소 FCI", render: renderFci },
  "#/reviews": { label: "검토", render: renderReviews },
  "#/issues": { label: "이슈", render: renderIssues },
  "#/config": { label: "설정", render: renderConfig },
  "#/config/prompts": { label: "프롬프트", render: renderPrompts, parent: "#/config" },
  "#/check": { label: "점검", render: renderCheck },
  "#/guide": { label: "사용 가이드", render: renderGuide },
};

const app = document.getElementById("app");
const nav = document.getElementById("nav");
const banner = document.getElementById("banner");
let timers = [];

function stopTimers() {
  for (const timer of timers) clearInterval(timer);
  timers = [];
}

const ctx = {
  every(ms, fn) {
    fn();
    timers.push(setInterval(fn, ms));
  },
  logout() {
    setToken(null);
    stopTimers();
    showLogin("토큰이 만료되었거나 틀립니다. 다시 로그인하세요.");
  },
  async refreshBanner() {
    try {
      const view = await admin("GET", "/config");
      clear(banner);
      if (view.pendingApply) {
        const apply = h("button", { type: "button", class: "btn btn-small" }, "지금 적용");
        apply.addEventListener("click", async () => {
          apply.disabled = true;
          try {
            await admin("POST", "/config/apply");
            await ctx.refreshBanner();
          } catch (error) {
            fill(banner, errorNotice(error));
          }
        });
        banner.append(
          notice(
            "info",
            h("strong", {}, "적용 대기: "),
            "설정 파일이 실행 중인 설정과 다릅니다(파일을 직접 고친 경우). ",
            apply,
          ),
        );
      }
      if (view.restartRequired) {
        banner.append(
          notice(
            "warn",
            h("strong", {}, "재시작 필요: "),
            h("code", {}, view.restartFields.join(", ")),
            " 변경은 Router를 재시작해야 적용됩니다. 나머지 설정은 이미 적용됐습니다.",
          ),
        );
      }
    } catch {
      clear(banner);
    }
  },
};

function drawNav(active) {
  fill(
    nav,
    Object.entries(ROUTES)
      .filter(([, route]) => !route.parent)
      .map(([hash, route]) =>
        h(
          "a",
          {
            href: hash,
            class: hash === active ? "active" : "",
            "aria-current": hash === active ? "page" : null,
          },
          route.label,
        ),
      ),
    h(
      "button",
      { type: "button", class: "btn btn-small nav-logout", onclick: () => ctx.logout() },
      "로그아웃",
    ),
  );
}

async function route() {
  stopTimers();
  if (location.hash === "#/prompts") {
    location.replace("#/config/prompts");
    return;
  }
  const hash = ROUTES[location.hash] ? location.hash : "#/";
  const entry = ROUTES[hash];
  drawNav(entry.parent || hash);
  const view = h("div", { class: "view" }, h("p", { class: "muted" }, "불러오는 중…"));
  const settingsNav =
    hash === "#/config" || entry.parent === "#/config"
      ? h(
          "nav",
          { class: "settings-nav", "aria-label": "설정 메뉴" },
          [
            ["#/config", "일반"],
            ["#/config/prompts", "프롬프트"],
          ].map(([href, label]) =>
            h(
              "a",
              {
                href,
                class: href === hash ? "active" : "",
                "aria-current": href === hash ? "page" : null,
              },
              label,
            ),
          ),
        )
      : null;
  fill(app, settingsNav, view);
  ctx.refreshBanner();
  try {
    if (entry.poll)
      ctx.every(5000, () => entry.render(view, ctx).catch((error) => handleError(view, error)));
    else await entry.render(view, ctx);
  } catch (error) {
    handleError(view, error);
  }
}

function handleError(view, error) {
  if (error?.status === 401) return ctx.logout();
  fill(view, errorNotice(error));
}

function showLogin(message) {
  clear(nav);
  clear(banner);
  const input = h("input", {
    type: "password",
    autocomplete: "current-password",
    spellcheck: "false",
    id: "admin-token",
  });
  const messageEl = h("div", {}, message ? notice("warn", message) : null);
  const form = h(
    "form",
    { class: "panel login" },
    h("h1", {}, "관리자 로그인"),
    h(
      "p",
      { class: "muted" },
      "Router의 GGJIRA_ADMIN_TOKEN을 입력하세요. 이 탭을 닫으면 잊습니다.",
    ),
    h("div", { class: "field" }, h("label", { for: "admin-token" }, "관리자 토큰"), input),
    messageEl,
    h(
      "div",
      { class: "form-actions" },
      h("button", { type: "submit", class: "btn btn-primary" }, "로그인"),
    ),
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setToken(input.value.trim());
    try {
      await admin("GET", "/status");
      route();
    } catch (error) {
      setToken(null);
      fill(
        messageEl,
        errorNotice(error.status === 401 ? { message: "토큰이 맞지 않습니다." } : error),
      );
    }
  });
  fill(app, form);
  input.focus();
}

async function boot() {
  let mode = "router";
  try {
    mode = (await health()).mode || "router";
  } catch {
    fill(app, notice("error", "Router에 연결할 수 없습니다."));
    return;
  }
  document.body.dataset.mode = mode;
  if (mode === "setup") {
    clear(nav);
    renderSetup(app);
    return;
  }
  window.addEventListener("hashchange", () => {
    if (getToken()) route();
  });
  if (getToken()) route();
  else showLogin();
}

boot();
