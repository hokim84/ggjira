// Config editor and Jira check views (router mode).

import { admin } from "./api.js";
import { clear, fill, errorNotice, field, h, notice, showFieldErrors } from "./dom.js";

const FORM_KEYS = new Set(["configVersion", "jira", "repositories", "workspaces", "workers"]);

function section(title, description, ...children) {
  return h(
    "section",
    { class: "panel" },
    h("h2", {}, title),
    description ? h("p", { class: "muted" }, description) : null,
    ...children,
  );
}

function listEditor(state, key, render, blank, addLabel) {
  const wrap = h("div", { class: "list-editor" });
  const draw = () => {
    clear(wrap);
    (state[key] || []).forEach((_, index) => {
      wrap.append(
        h(
          "div",
          { class: "list-item" },
          h("div", { class: "grid" }, render(index)),
          h(
            "button",
            {
              type: "button",
              class: "btn btn-small btn-danger",
              onclick: () => {
                state[key].splice(index, 1);
                draw();
              },
            },
            "삭제",
          ),
        ),
      );
    });
    wrap.append(
      h(
        "button",
        {
          type: "button",
          class: "btn btn-small",
          onclick: () => {
            state[key] = [...(state[key] || []), blank()];
            draw();
          },
        },
        addLabel,
      ),
    );
  };
  draw();
  return wrap;
}

export async function renderConfig(root, ctx) {
  const view = await admin("GET", "/config");
  const state = structuredClone(view.file || {});
  const advanced = Object.fromEntries(Object.entries(state).filter(([key]) => !FORM_KEYS.has(key)));
  const advancedInput = h("textarea", { rows: "12", spellcheck: "false", class: "code" });
  advancedInput.value = JSON.stringify(advanced, null, 2);
  const messageEl = h("div");

  const repositories = listEditor(
    state,
    "repositories",
    (i) => [
      field(state, `repositories.${i}.id`, "저장소 id"),
      field(state, `repositories.${i}.displayName`, "표시 이름", { optional: true }),
      field(state, `repositories.${i}.cloneUrl`, "git clone URL", {
        optional: true,
        placeholder: "git@github.com:org/repo.git",
        hint: "워커가 처음 실행할 때 자동으로 clone합니다",
      }),
      field(state, `repositories.${i}.baseBranch`, "기준 브랜치", {
        optional: true,
        placeholder: "main",
      }),
    ],
    () => ({ id: "" }),
    "저장소 추가",
  );

  const workspaces = listEditor(
    state,
    "workspaces",
    (i) => [
      field(state, `workspaces.${i}.id`, "workspace id"),
      field(state, `workspaces.${i}.repositoryId`, "저장소 id"),
      field(state, `workspaces.${i}.projectKeys`, "Jira 프로젝트 키", {
        kind: "list",
        hint: "쉼표로 구분",
      }),
      field(state, `workspaces.${i}.workflow.requestStatus`, "요청 상태"),
      field(state, `workspaces.${i}.workflow.inProgressStatus`, "진행 상태"),
      field(state, `workspaces.${i}.workflow.reviewStatus`, "검토 상태"),
      field(state, `workspaces.${i}.workflow.planningStatus`, "계획 요청 상태", {
        optional: true,
        hint: "비우면 PM 계획 사용 안 함",
      }),
      field(state, `workspaces.${i}.workflow.needsDecisionStatus`, "결정 필요 상태", {
        optional: true,
      }),
    ],
    () => ({ id: "", repositoryId: "", projectKeys: [], workflow: {} }),
    "workspace 추가",
  );

  const workers = listEditor(
    state,
    "workers",
    (i) => [
      field(state, `workers.${i}.workerId`, "workerId"),
      field(state, `workers.${i}.allowedCapabilities`, "허용 capabilities", {
        kind: "list",
        hint: "예: programming, testing",
      }),
      field(state, `workers.${i}.allowedRepositoryIds`, "허용 저장소 id", { kind: "list" }),
      field(state, `workers.${i}.providerId`, "providerId", {
        optional: true,
        placeholder: "default",
      }),
      field(state, `workers.${i}.enabled`, "배정 허용", { kind: "checkbox" }),
    ],
    () => ({ workerId: "", allowedCapabilities: [], allowedRepositoryIds: [] }),
    "워커 추가",
  );

  const form = h(
    "form",
    { class: "config-form", novalidate: true },
    section(
      "Jira",
      null,
      h("div", { class: "grid" }, field(state, "jira.baseUrl", "Jira 사이트 URL")),
    ),
    section("저장소", "워커가 로컬에 가지고 있어야 하는 저장소 식별자입니다.", repositories),
    section("Workspace", "Jira 프로젝트와 저장소, 상태 흐름을 묶습니다.", workspaces),
    section("워커 정책", "워커별로 허용하는 capability와 저장소입니다.", workers),
    section(
      "고급 (JSON)",
      "db, http, reconciliation, execution, planning, reporting, executionAgent",
      h(
        "div",
        { class: "field", "data-path": "advanced" },
        advancedInput,
        h("small", { class: "field-error", "data-error-for": "advanced" }),
      ),
    ),
    h(
      "div",
      { class: "form-actions" },
      h("button", { type: "submit", class: "btn btn-primary" }, "저장"),
    ),
  );

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clear(messageEl);
    let extra;
    try {
      extra = JSON.parse(advancedInput.value || "{}");
      if (!extra || typeof extra !== "object" || Array.isArray(extra))
        throw new Error("JSON 객체여야 합니다");
    } catch (error) {
      showFieldErrors(form, [{ path: "advanced", message: `JSON 오류: ${error.message}` }]);
      return;
    }
    const body = {
      ...extra,
      configVersion: state.configVersion ?? 5,
      jira: state.jira,
      repositories: state.repositories,
      workspaces: state.workspaces,
      workers: state.workers,
    };
    try {
      const result = await admin("PUT", "/config", body);
      showFieldErrors(form, []);
      messageEl.append(
        result.appliedWithout.length
          ? notice(
              "warn",
              "저장하고 적용했습니다. 단, ",
              h("code", {}, result.appliedWithout.join(", ")),
              " 변경은 Router를 재시작해야 적용됩니다.",
            )
          : notice("ok", "저장하고 바로 적용했습니다."),
      );
      ctx.refreshBanner();
    } catch (error) {
      if (error.status === 401) return ctx.logout();
      const unmatched = showFieldErrors(form, error.issues || []);
      messageEl.append(errorNotice({ message: error.message, issues: unmatched }));
    }
    messageEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });

  fill(
    root,
    h("h1", {}, "설정"),
    h(
      "p",
      { class: "muted" },
      h("code", {}, view.path),
      " — 저장하면 바로 적용됩니다. http, db.path, jira.baseUrl, executionAgent.fieldId만 재시작이 필요합니다.",
    ),
    view.problem ? notice("warn", `현재 파일 문제: ${view.problem}`) : null,
    messageEl,
    form,
  );
}

export function renderCheck(root, ctx) {
  const issueInput = h("input", {
    type: "text",
    placeholder: "예: PROJ-123 (선택)",
    autocomplete: "off",
  });
  const results = h("div");
  const button = h("button", { type: "submit", class: "btn btn-primary" }, "점검 실행");
  const form = h(
    "form",
    { class: "inline-form" },
    h("div", { class: "field" }, h("label", {}, "샘플 이슈 키"), issueInput),
    button,
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    button.disabled = true;
    fill(results, h("p", { class: "muted" }, "Jira를 조회하는 중…"));
    try {
      const issueKey = issueInput.value.trim();
      const { items } = await admin("POST", "/check", issueKey ? { issueKey } : {});
      fill(
        results,
        h(
          "ul",
          { class: "check-list" },
          items.map((item) =>
            h(
              "li",
              { class: `check-${item.level}` },
              h(
                "span",
                {
                  class: `badge badge-${item.level === "ok" ? "ok" : item.level === "warn" ? "warn" : "bad"}`,
                },
                item.level.toUpperCase(),
              ),
              " ",
              item.message,
            ),
          ),
        ),
      );
    } catch (error) {
      if (error.status === 401) return ctx.logout();
      fill(results, errorNotice(error));
    } finally {
      button.disabled = false;
    }
  });
  fill(
    root,
    h("h1", {}, "Jira 연결 점검"),
    h(
      "p",
      { class: "muted" },
      "저장된 설정 파일 기준으로 Jira 인증, 프로젝트, 상태와 전이를 읽기 전용으로 확인합니다.",
    ),
    form,
    results,
  );
}
