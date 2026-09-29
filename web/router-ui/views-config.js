// Config editor and Jira check views (router mode).

import { admin } from "./api.js";
import {
  clear,
  copyButton,
  errorNotice,
  field,
  fill,
  h,
  notice,
  relativeTime,
  showFieldErrors,
} from "./dom.js";

const FORM_KEYS = new Set([
  "configVersion",
  "jira",
  "repositories",
  "workspaces",
  "workers",
  "planning",
]);

const STATUS_FIELDS = [
  ["requestStatus", "요청 상태", "사람이 AI에게 맡길 때 옮기는 상태"],
  ["inProgressStatus", "진행 상태", "워커가 시작하면 Router가 옮김"],
  ["reviewStatus", "검토 상태", "작업이 끝나면 Router가 옮김. 사람이 확인 후 완료 처리"],
  ["planningStatus", "계획 요청 상태", "비우면 PM 계획을 쓰지 않음", true],
  [
    "needsDecisionStatus",
    "결정 필요 상태",
    "계획이 사람의 결정을 요청할 때. 비우면 검토 상태",
    true,
  ],
  [
    "doneStatus",
    "완료 상태",
    "워커가 연 GitHub PR이 머지되면 검토 상태에서 옮김. 비우면 댓글만",
    true,
  ],
];

const HOP_BADGES = {
  ok: ["badge-ok", "연결됨"],
  missing: ["badge-bad", "전이 없음"],
  unknown: ["badge-warn", "확인 불가"],
};

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
  wrap.redraw = draw;
  return wrap;
}

const NO_SECRET = { set: false, source: null, editable: false };

// A write-only secret (ADR 0031, 0032): the Router answers only whether it is set and where it
// comes from, never the value. Lives inside the config form, so Enter here saves this secret and
// never submits the config.
function secretInput(opts) {
  let info = opts.info;
  const wrap = h("div", {});
  const message = h("div", {});

  async function send(value) {
    clear(message);
    try {
      info = await admin("PUT", opts.endpoint, { value });
      draw();
      message.append(
        notice("ok", value === null ? opts.removedText : "저장하고 바로 적용했습니다."),
      );
      opts.onSaved?.();
    } catch (error) {
      if (error.status === 401) return opts.ctx.logout();
      message.append(errorNotice(error));
    }
  }

  function draw() {
    const status = h(
      "p",
      {},
      h(
        "span",
        { class: `badge ${info.set ? "badge-ok" : opts.missingTone || "badge-muted"}` },
        info.set ? `${opts.noun} 있음` : `${opts.noun} 없음`,
      ),
      " ",
      info.set ? opts.setText : opts.unsetText,
    );
    if (!info.editable) {
      fill(
        wrap,
        status,
        h(
          "small",
          { class: "hint" },
          info.source === "environment"
            ? `Router 환경변수 ${opts.envKey}가 router.env보다 우선하므로 여기서 바꿀 수 없습니다. 환경변수를 바꾸고 Router를 재시작하세요.`
            : "이 Router는 비밀정보 파일 경로가 없어 여기서 바꿀 수 없습니다.",
        ),
      );
      return;
    }
    const input = h("input", {
      id: opts.id,
      type: "password",
      class: "secret-value",
      autocomplete: "off",
      spellcheck: "false",
      placeholder: info.set ? opts.replacePlaceholder : opts.placeholder,
    });
    const save = () => {
      const value = input.value.trim();
      input.value = "";
      if (value) send(value);
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        save();
      }
    });
    fill(
      wrap,
      status,
      h(
        "div",
        { class: "secret-row" },
        h("label", { for: opts.id, class: "secret-label" }, opts.label),
        input,
        h(
          "span",
          { class: "secret-actions" },
          h(
            "button",
            { type: "button", class: "btn", onclick: save },
            info.set ? `${opts.noun} 교체` : `${opts.noun} 저장`,
          ),
          info.set
            ? h(
                "button",
                { type: "button", class: "btn", onclick: () => send(null) },
                `${opts.noun} 삭제`,
              )
            : null,
        ),
      ),
      message,
    );
  }

  draw();
  return wrap;
}

const PR_STATE = {
  open: ["열림", "badge-muted"],
  merged: ["머지됨", "badge-ok"],
  closed: ["닫힘", "badge-muted"],
};

// Tracked pull requests and each one's last GitHub poll (ADR 0032), with "지금 확인".
function pullRequestList(initial, ctx) {
  let prs = initial;
  const wrap = h("div", { class: "pr-status" });
  const message = h("div", {});

  async function pollNow(button) {
    button.disabled = true;
    clear(message);
    try {
      const result = await admin("POST", "/github/poll");
      prs = result.pullRequests;
      const { checked, closed, errors } = result.report;
      message.append(
        notice(
          errors.length ? "warn" : "ok",
          `열린 PR ${checked}개 확인: 머지·닫힘 ${closed.length}개, 오류 ${errors.length}개.`,
        ),
      );
      draw();
    } catch (error) {
      if (error.status === 401) return ctx.logout();
      message.append(errorNotice(error));
    } finally {
      button.disabled = false;
    }
  }

  function row(pr) {
    const [label, tone] = PR_STATE[pr.state] || [pr.state, "badge-muted"];
    return h(
      "li",
      { class: "pr-row" },
      h("a", { href: pr.url, target: "_blank", rel: "noopener" }, `${pr.repo}#${pr.number}`),
      h("span", { class: "tag" }, pr.issueKey),
      h(
        "span",
        { class: `badge ${pr.lastError ? "badge-bad" : tone}` },
        pr.lastError ? "확인 실패" : label,
      ),
      h(
        "small",
        { class: "muted", title: pr.lastCheckedAt || "" },
        pr.state === "open"
          ? pr.lastCheckedAt
            ? `${relativeTime(pr.lastCheckedAt)} 확인`
            : "아직 확인 안 함"
          : pr.closedBy
            ? `by ${pr.closedBy}`
            : "",
      ),
      pr.lastError ? h("div", { class: "pr-error" }, pr.lastError) : null,
    );
  }

  function draw() {
    const button = h("button", { type: "button", class: "btn btn-small" }, "지금 확인");
    button.addEventListener("click", () => pollNow(button));
    fill(
      wrap,
      h("div", { class: "pr-status-head" }, h("strong", {}, "추적 중인 PR"), button),
      prs.length
        ? h("ul", { class: "pr-list" }, prs.map(row))
        : h("p", { class: "muted" }, "아직 워커가 연 PR이 없습니다."),
      message,
    );
  }

  draw();
  return wrap;
}

function githubSection(github, ctx) {
  const webhookUrl = `${location.origin}/webhooks/github`;
  const prs = pullRequestList(github.pullRequests || [], ctx);
  return h(
    "div",
    { class: "github-setup" },
    h(
      "div",
      { class: "secret-row" },
      h("span", { class: "secret-label" }, "웹훅 URL"),
      h("code", { class: "secret-value" }, webhookUrl),
      copyButton(webhookUrl),
    ),
    h(
      "p",
      {},
      h(
        "span",
        { class: `badge ${github.webhook ? "badge-ok" : "badge-warn"}` },
        github.webhook ? "웹훅 켜짐" : "웹훅 꺼짐",
      ),
      " ",
      github.webhook
        ? "GitHub 저장소 Settings > Webhooks에 위 URL, Content type application/json, Secret(router.env의 GGJIRA_GITHUB_WEBHOOK_SECRET), 이벤트 Pull requests로 등록하세요."
        : "router.env에 GGJIRA_GITHUB_WEBHOOK_SECRET(16자 이상)을 넣고 Router를 재시작하면 켜집니다. 꺼져 있어도 폴링으로 동작합니다.",
    ),
    secretInput({
      ctx,
      info: github.token || NO_SECRET,
      endpoint: "/secrets/github-token",
      id: "github-token",
      label: "GitHub 토큰",
      noun: "토큰",
      envKey: "GITHUB_TOKEN",
      placeholder: "github_pat_… (Pull requests: read)",
      replacePlaceholder: "새 토큰을 넣으면 교체합니다",
      setText:
        "열린 PR을 이 토큰으로 주기적으로 확인합니다(기본 5분, 고급 JSON의 github.pollIntervalMs).",
      unsetText:
        "공개 저장소만 확인할 수 있습니다. 비공개 저장소는 토큰이 없으면 확인에 실패합니다(아래 목록에 표시).",
      removedText: "토큰을 삭제했습니다. 이제 공개 저장소만 확인합니다.",
      // Saving a token re-checks open PRs at once; show the outcome shortly after.
      onSaved: () => setTimeout(() => prs.querySelector("button")?.click(), 1500),
    }),
    prs,
    h(
      "small",
      { class: "hint" },
      "토큰은 해당 저장소의 Pull requests 읽기 권한만 준 fine-grained 토큰을 권장합니다. 로컬(127.0.0.1)에서는 GitHub 웹훅이 닿지 않으므로 폴링이나 gh webhook forward를 씁니다(runbook §21).",
    ),
  );
}

function jevSection(info, ctx) {
  return h(
    "div",
    {},
    secretInput({
      ctx,
      info,
      endpoint: "/secrets/jev",
      id: "jev-api-key",
      label: "API 키",
      noun: "키",
      envKey: "TYPESAFE_API_KEY",
      placeholder: "TypeSafe API 키",
      replacePlaceholder: "새 키를 넣으면 교체합니다",
      setText: "새 job마다 Jev 평가를 기록합니다. 이슈 제목과 설명이 TypeSafe로 전송됩니다.",
      unsetText: "키를 넣으면 재시작 없이 평가가 켜집니다. 없으면 평가하지 않습니다.",
      removedText: "키를 삭제했습니다. 평가가 꺼집니다.",
    }),
    h(
      "small",
      { class: "hint" },
      "키는 router.env에만 저장되고 화면에 다시 표시되지 않습니다. 원격에서는 HTTPS로만 여세요. 평가 결과 보기와 끄기는 runbook §23.",
    ),
  );
}

function cleanPlanning(planning = {}) {
  return Object.fromEntries(
    Object.entries(planning).filter(([, value]) => value !== undefined && value !== ""),
  );
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

  // Jira project info (statuses, subtask types) per project key, loaded on demand.
  const jiraInfo = new Map();
  const hopTimers = new Map();

  async function loadJira(projectKey, force = false) {
    if (!projectKey || (!force && jiraInfo.has(projectKey))) return;
    jiraInfo.set(projectKey, { loading: true });
    try {
      jiraInfo.set(projectKey, await admin("POST", "/jira/project", { projectKey }));
    } catch (error) {
      if (error.status === 401) return ctx.logout();
      jiraInfo.set(projectKey, { error: error.message });
    }
    workspaces.redraw();
    planningFields.redraw();
  }

  function statusField(i, key, label, hint, optional) {
    const ws = state.workspaces[i];
    const info = jiraInfo.get(ws.projectKeys?.[0]);
    const current = ws.workflow?.[key];
    if (!info?.statuses) {
      return field(state, `workspaces.${i}.workflow.${key}`, label, { optional, hint });
    }
    const unknown = current && !info.statuses.includes(current);
    return field(state, `workspaces.${i}.workflow.${key}`, label, {
      kind: "select",
      options: info.statuses,
      optional,
      hint: unknown ? `"${current}"은(는) Jira 프로젝트에 없는 상태입니다` : hint,
    });
  }

  function renderHops(el, result) {
    if (result.loading) return fill(el, h("p", { class: "muted" }, "Jira 워크플로를 확인하는 중…"));
    if (result.error) return fill(el, errorNotice({ message: result.error }));
    fill(
      el,
      h(
        "ul",
        { class: "hop-list" },
        result.hops.map((hop) => {
          const [badge, text] = HOP_BADGES[hop.state];
          return h(
            "li",
            {},
            h("span", { class: `badge ${badge}` }, text),
            h("span", { class: "hop-label" }, hop.label),
            h("span", { class: "hop-move" }, `${hop.from} → ${hop.to}`),
            hop.state === "missing"
              ? h(
                  "small",
                  { class: "hint" },
                  `${hop.sampleIssue}에서 갈 수 있는 상태: ${hop.reachable.join(", ") || "없음"} — Jira 워크플로에 전이를 추가하세요`,
                )
              : hop.state === "unknown"
                ? h("small", { class: "hint" }, hop.reason)
                : hop.sampleIssue
                  ? h("small", { class: "hint" }, `${hop.sampleIssue}로 확인`)
                  : null,
          );
        }),
      ),
    );
  }

  async function checkHops(i, el) {
    const ws = state.workspaces[i];
    const projectKey = ws?.projectKeys?.[0];
    const workflow = ws?.workflow ?? {};
    if (
      !projectKey ||
      !workflow.requestStatus ||
      !workflow.inProgressStatus ||
      !workflow.reviewStatus
    ) {
      fill(
        el,
        h(
          "p",
          { class: "muted" },
          "프로젝트 키와 요청, 진행, 검토 상태를 정하면 전이를 확인합니다.",
        ),
      );
      return;
    }
    renderHops(el, { loading: true });
    try {
      renderHops(el, await admin("POST", "/jira/workflow-check", { projectKey, workflow }));
    } catch (error) {
      if (error.status === 401) return ctx.logout();
      renderHops(el, { error: error.message });
    }
  }

  function scheduleHops(i, el) {
    clearTimeout(hopTimers.get(i));
    hopTimers.set(
      i,
      setTimeout(() => checkHops(i, el), 400),
    );
  }

  function workflowBlock(i) {
    const ws = state.workspaces[i];
    ws.workflow ||= {};
    const projectKey = ws.projectKeys?.[0];
    const info = jiraInfo.get(projectKey);
    const hopsEl = h("div", { class: "hops" });
    const block = h(
      "div",
      { class: "full-row workflow-block" },
      h(
        "div",
        { class: "workflow-head" },
        h("h3", {}, "상태 흐름"),
        h(
          "button",
          {
            type: "button",
            class: "btn btn-small",
            disabled: !projectKey,
            onclick: () => loadJira(projectKey, true),
          },
          info?.statuses ? "Jira에서 다시 불러오기" : "Jira에서 상태 불러오기",
        ),
      ),
      info?.loading ? h("p", { class: "muted" }, `${projectKey} 상태를 불러오는 중…`) : null,
      info?.error ? errorNotice({ message: `${projectKey}: ${info.error}` }) : null,
      h(
        "div",
        { class: "grid" },
        STATUS_FIELDS.map(([key, label, hint, optional]) =>
          statusField(i, key, label, hint, optional),
        ),
      ),
      h("h3", {}, "Router가 하는 전이"),
      hopsEl,
    );
    block.addEventListener("change", () => scheduleHops(i, hopsEl));
    block.addEventListener("input", () => scheduleHops(i, hopsEl));
    if (info?.statuses) scheduleHops(i, hopsEl);
    else fill(hopsEl, h("p", { class: "muted" }, "Jira에서 상태를 불러오면 전이를 확인합니다."));
    return block;
  }

  const workspaces = listEditor(
    state,
    "workspaces",
    (i) => {
      const repoIds = (state.repositories || []).map((repo) => repo.id).filter(Boolean);
      const projectField = field(state, `workspaces.${i}.projectKeys`, "Jira 프로젝트 키", {
        kind: "list",
        hint: "쉼표로 구분. 상태 목록은 첫 번째 프로젝트 기준",
      });
      projectField.addEventListener("change", () => {
        const key = state.workspaces[i]?.projectKeys?.[0];
        if (key) loadJira(key);
      });
      return [
        field(state, `workspaces.${i}.id`, "workspace id"),
        field(state, `workspaces.${i}.repositoryId`, "저장소", {
          kind: "select",
          options: repoIds,
        }),
        projectField,
        workflowBlock(i),
      ];
    },
    () => ({ id: "", repositoryId: "", projectKeys: [], workflow: {} }),
    "workspace 추가",
  );

  state.planning ||= {};
  const planningFields = h("div", { class: "grid" });
  planningFields.redraw = () => {
    const subtaskTypes = [
      ...new Set([...jiraInfo.values()].flatMap((info) => info.subtaskIssueTypes ?? [])),
    ];
    fill(
      planningFields,
      field(state, "planning.subtaskIssueType", "하위 이슈 유형", {
        kind: subtaskTypes.length ? "select" : "text",
        options: subtaskTypes,
        optional: true,
        placeholder: "Sub-task",
        hint: subtaskTypes.length
          ? "계획으로 만드는 하위 이슈의 유형(Jira에서 불러옴)"
          : "Jira에서 상태를 불러오면 목록에서 고를 수 있습니다. 비우면 Sub-task",
      }),
      field(state, "planning.maxTasksPerPlan", "계획당 최대 하위 이슈 수", {
        kind: "number",
        placeholder: "10",
      }),
    );
  };
  planningFields.redraw();

  for (const ws of state.workspaces || []) {
    if (ws.projectKeys?.[0]) loadJira(ws.projectKeys[0]);
  }

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
    section(
      "Workspace",
      "Jira 프로젝트와 저장소, 상태 흐름을 묶습니다. 상태 이름과 순서는 Jira 워크플로에 맞춰 자유롭게 정하면 되고, 아래에서 Router가 하는 전이가 워크플로에 있는지 바로 확인합니다.",
      workspaces,
    ),
    section("계획(PM)", "계획 요청 상태를 쓸 때만 필요합니다.", planningFields),
    section(
      "GitHub PR 머지 → 완료",
      "워커가 연 PR이 머지되면 이슈를 검토 상태에서 '완료 상태'로 옮깁니다. 웹훅으로 바로 알고, 놓친 것은 주기적으로 GitHub에 확인합니다.",
      githubSection(view.github ?? { webhook: false, token: NO_SECRET, pullRequests: [] }, ctx),
    ),
    section(
      "Jev 평가 (TypeSafe)",
      "새 job마다 모델 등급과 준비 상태를 Jev에 묻고 기록만 합니다(관찰 모드). 이 영역은 위아래 '저장'과 따로 즉시 적용됩니다.",
      jevSection(view.jev ?? NO_SECRET, ctx),
    ),
    section("워커 정책", "워커별로 허용하는 capability와 저장소입니다.", workers),
    section(
      "고급 (JSON)",
      "db, http, reconciliation, execution, reporting, executionAgent, github, scheduling",
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
      ...(Object.keys(cleanPlanning(state.planning)).length
        ? { planning: cleanPlanning(state.planning) }
        : {}),
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
