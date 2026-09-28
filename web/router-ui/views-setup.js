// First-run setup wizard (setup mode). Talks to /api/v1/setup/* with the one-time setup token.

import { getToken, setToken, setup } from "./api.js";
import { clear, fill, errorNotice, field, h, notice, secretRow, showFieldErrors } from "./dom.js";

const STEPS = ["토큰", "Jira 연결", "프로젝트", "워커", "서버", "저장"];

export function renderSetup(root) {
  const wizard = {
    step: getToken() ? 1 : 0,
    info: null,
    config: null,
    jira: { email: "", apiToken: "" },
    projects: [],
    statuses: [],
    skipWorker: false,
  };

  const body = h("div");
  const stepper = h("ol", { class: "stepper" });

  function go(step) {
    wizard.step = step;
    draw();
  }

  function draw() {
    fill(
      stepper,
      STEPS.map((label, i) =>
        h(
          "li",
          { class: i === wizard.step ? "current" : i < wizard.step ? "done" : "" },
          h("span", {}, String(i + 1)),
          label,
        ),
      ),
    );
    clear(body);
    const render = [tokenStep, jiraStep, projectStep, workerStep, serverStep, saveStep][
      wizard.step
    ];
    body.append(render());
  }

  const creds = () => ({
    baseUrl: wizard.config.jira.baseUrl,
    email: wizard.jira.email,
    apiToken: wizard.jira.apiToken,
  });
  const workspace = () => wizard.config.workspaces[0];
  const repository = () => wizard.config.repositories[0];

  async function loadState() {
    wizard.info = await setup("GET", "/state");
    wizard.config = structuredClone(wizard.info.existingConfig || wizard.info.template);
    wizard.config.repositories ||= [{ id: "main-repo" }];
    wizard.config.workspaces ||= [
      { id: "default", repositoryId: "main-repo", projectKeys: [], workflow: {} },
    ];
    wizard.config.workers ||= [];
    wizard.config.jira ||= { baseUrl: "" };
  }

  function actions(...buttons) {
    return h("div", { class: "form-actions" }, buttons);
  }
  const back = () =>
    h("button", { type: "button", class: "btn", onclick: () => go(wizard.step - 1) }, "이전");

  function tokenStep() {
    const input = h("input", { type: "password", autocomplete: "off", spellcheck: "false" });
    const message = h("div");
    const form = h(
      "form",
      { class: "panel" },
      h("h2", {}, "Setup token"),
      h("p", { class: "muted" }, "Router를 실행한 콘솔에 출력된 일회용 setup token을 입력하세요."),
      h("div", { class: "field" }, h("label", {}, "Setup token"), input),
      message,
      actions(h("button", { type: "submit", class: "btn btn-primary" }, "다음")),
    );
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      setToken(input.value.trim());
      try {
        await loadState();
        go(1);
      } catch (error) {
        setToken(null);
        fill(message, errorNotice(error));
      }
    });
    return form;
  }

  function jiraStep() {
    const message = h("div");
    const email = h("input", { type: "email", value: wizard.jira.email, autocomplete: "username" });
    const token = h("input", {
      type: "password",
      value: wizard.jira.apiToken,
      autocomplete: "current-password",
    });
    email.addEventListener("input", () => {
      wizard.jira.email = email.value.trim();
    });
    token.addEventListener("input", () => {
      wizard.jira.apiToken = token.value.trim();
    });
    const form = h(
      "form",
      { class: "panel" },
      h("h2", {}, "Jira 연결"),
      h(
        "div",
        { class: "grid" },
        field(wizard.config, "jira.baseUrl", "Jira 사이트 URL", {
          placeholder: "https://your-site.atlassian.net",
        }),
        h("div", { class: "field" }, h("label", {}, "Jira 계정 이메일"), email),
        h(
          "div",
          { class: "field" },
          h("label", {}, "Jira API token"),
          token,
          h(
            "small",
            { class: "hint" },
            "secrets 파일(0600)에만 저장되고 설정 파일에는 들어가지 않습니다.",
          ),
        ),
      ),
      message,
      actions(
        back(),
        h("button", { type: "submit", class: "btn btn-primary" }, "연결 테스트 후 다음"),
      ),
    );
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      fill(message, h("p", { class: "muted" }, "Jira에 연결하는 중…"));
      try {
        const me = await setup("POST", "/jira/test", creds());
        const { projects } = await setup("POST", "/jira/projects", creds());
        wizard.projects = projects;
        fill(message, notice("ok", `${me.displayName} 계정으로 인증했습니다.`));
        go(2);
      } catch (error) {
        fill(message, errorNotice(error));
      }
    });
    return form;
  }

  function projectStep() {
    const message = h("div");
    const ws = workspace();
    ws.workflow ||= {};
    const statusFields = h("div", { class: "grid" });
    const projectSelect = h(
      "select",
      {},
      h("option", { value: "" }, "프로젝트 선택"),
      wizard.projects.map((p) =>
        h(
          "option",
          { value: p.key, selected: ws.projectKeys?.[0] === p.key },
          `${p.key} — ${p.name}`,
        ),
      ),
    );

    function drawStatuses() {
      const options = wizard.statuses;
      const kind = options.length ? "select" : "text";
      fill(
        statusFields,
        field(ws, "workflow.requestStatus", "요청 상태 (사람이 AI에게 맡김)", { kind, options }),
        field(ws, "workflow.inProgressStatus", "진행 상태 (Router가 옮김)", { kind, options }),
        field(ws, "workflow.reviewStatus", "검토 상태 (완료 후)", { kind, options }),
        field(ws, "workflow.planningStatus", "계획 요청 상태 (선택)", {
          kind,
          options,
          optional: true,
        }),
        field(ws, "workflow.needsDecisionStatus", "결정 필요 상태 (선택)", {
          kind,
          options,
          optional: true,
        }),
      );
    }

    async function loadStatuses(projectKey) {
      wizard.statuses = [];
      if (projectKey) {
        try {
          wizard.statuses = (
            await setup("POST", "/jira/statuses", { ...creds(), projectKey })
          ).statuses;
        } catch (error) {
          fill(message, errorNotice(error));
        }
      }
      drawStatuses();
    }

    projectSelect.addEventListener("change", () => {
      ws.projectKeys = projectSelect.value ? [projectSelect.value] : [];
      loadStatuses(projectSelect.value);
    });
    drawStatuses();
    if (ws.projectKeys?.[0] && wizard.projects.some((p) => p.key === ws.projectKeys[0]))
      loadStatuses(ws.projectKeys[0]);

    const form = h(
      "form",
      { class: "panel" },
      h("h2", {}, "프로젝트와 상태 흐름"),
      h(
        "div",
        { class: "grid" },
        h(
          "div",
          { class: "field", "data-path": "workspaces.0.projectKeys" },
          h("label", {}, "Jira 프로젝트"),
          projectSelect,
          h("small", { class: "field-error", "data-error-for": "workspaces.0.projectKeys" }),
        ),
        field(repository(), "id", "저장소 id", {
          hint: "워커 설정의 repositories[].id와 같아야 합니다",
        }),
        field(repository(), "displayName", "저장소 표시 이름", { optional: true }),
        field(repository(), "cloneUrl", "git clone URL (선택)", {
          optional: true,
          placeholder: "git@github.com:org/repo.git",
          hint: "있으면 워커가 처음 실행할 때 자동으로 clone합니다",
        }),
      ),
      h("h3", {}, "상태"),
      statusFields,
      message,
      actions(back(), h("button", { type: "submit", class: "btn btn-primary" }, "다음")),
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      ws.repositoryId = repository().id;
      const missing = [];
      if (!ws.projectKeys?.length)
        missing.push({ path: "workspaces.0.projectKeys", message: "프로젝트를 선택하세요" });
      for (const key of ["requestStatus", "inProgressStatus", "reviewStatus"]) {
        if (!ws.workflow[key]) missing.push({ path: `workflow.${key}`, message: "필수입니다" });
      }
      if (missing.length) {
        showFieldErrors(form, missing);
        return;
      }
      go(3);
    });
    return form;
  }

  function workerStep() {
    const cfg = wizard.config;
    if (!cfg.workers.length) {
      cfg.workers.push({
        workerId: "worker-1",
        allowedCapabilities: ["programming", "testing"],
        allowedRepositoryIds: [],
        providerId: "default",
      });
    }
    const worker = cfg.workers[0];
    worker.allowedRepositoryIds = [repository().id];
    const skip = h("input", { type: "checkbox", checked: wizard.skipWorker, id: "skip-worker" });
    const fields = h(
      "div",
      { class: "grid" },
      field(worker, "workerId", "workerId", { hint: "워커 머신을 구분하는 이름" }),
      field(worker, "allowedCapabilities", "허용 capabilities", {
        kind: "list",
        hint: "쉼표로 구분",
      }),
      field(worker, "providerId", "providerId", { optional: true, placeholder: "default" }),
    );
    skip.addEventListener("change", () => {
      wizard.skipWorker = skip.checked;
      fields.classList.toggle("disabled", skip.checked);
    });
    fields.classList.toggle("disabled", wizard.skipWorker);
    const form = h(
      "form",
      { class: "panel" },
      h("h2", {}, "첫 워커"),
      h(
        "p",
        { class: "muted" },
        `저장소 ${repository().id}에서 작업할 워커를 선언합니다. 페어링은 설정을 마치고 Router를 재시작한 뒤 워커 화면에서 합니다.`,
      ),
      h(
        "div",
        { class: "field field-check" },
        h("label", { for: "skip-worker" }, "워커는 나중에 추가"),
        skip,
      ),
      fields,
      actions(back(), h("button", { type: "submit", class: "btn btn-primary" }, "다음")),
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      go(4);
    });
    return form;
  }

  function serverStep() {
    const cfg = wizard.config;
    cfg.http ||= { host: "127.0.0.1", port: 8787 };
    cfg.db ||= { path: "data/router.sqlite3" };
    const form = h(
      "form",
      { class: "panel" },
      h("h2", {}, "서버"),
      h(
        "div",
        { class: "grid" },
        field(cfg, "http.host", "listen 주소", {
          hint: "Docker/Caddy 뒤라면 0.0.0.0, 단독 실행이면 127.0.0.1",
        }),
        field(cfg, "http.port", "포트", { kind: "number" }),
        field(cfg, "db.path", "SQLite 경로"),
      ),
      actions(back(), h("button", { type: "submit", class: "btn btn-primary" }, "다음")),
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      go(5);
    });
    return form;
  }

  function finalConfig() {
    const cfg = structuredClone(wizard.config);
    cfg.configVersion = 5;
    if (wizard.skipWorker) cfg.workers = [];
    return cfg;
  }

  function saveStep() {
    const message = h("div");
    const preview = h("pre", { class: "code preview" }, JSON.stringify(finalConfig(), null, 2));
    const saveButton = h("button", { type: "submit", class: "btn btn-primary" }, "저장");
    const form = h(
      "form",
      { class: "panel" },
      h("h2", {}, "확인 후 저장"),
      h(
        "p",
        { class: "muted" },
        "설정 파일: ",
        h("code", {}, wizard.info.configPath),
        " · secrets 파일: ",
        h("code", {}, wizard.info.secretsPath),
      ),
      preview,
      message,
      actions(back(), saveButton),
    );
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      saveButton.disabled = true;
      try {
        const result = await setup("POST", "/complete", {
          config: finalConfig(),
          jiraEmail: wizard.jira.email,
          jiraApiToken: wizard.jira.apiToken,
        });
        setToken(null);
        fill(root, done(result));
      } catch (error) {
        saveButton.disabled = false;
        fill(message, errorNotice(error));
      }
    });
    return form;
  }

  function done(result) {
    const webhookUrl = `${location.origin}${result.webhookPath}`;
    return h(
      "div",
      { class: "panel" },
      h("h1", {}, "설정 완료"),
      notice(
        "warn",
        h("strong", {}, "아래 값은 지금 한 번만 표시됩니다."),
        " secrets 파일에도 저장되어 있습니다.",
      ),
      secretRow("관리자 토큰 (웹 UI 로그인, CLI)", result.adminToken),
      secretRow("웹훅 secret", result.webhookSecret),
      h("h2", {}, "다음 단계"),
      h(
        "ol",
        { class: "steps" },
        h(
          "li",
          {},
          "Router를 재시작하세요 (Ctrl+C 후 ",
          h("code", {}, "ggjira router serve"),
          " 다시 실행, Docker면 ",
          h("code", {}, "docker compose restart router"),
          ").",
        ),
        h(
          "li",
          {},
          "Jira 관리 > 시스템 > WebHooks에서 URL ",
          h("code", {}, webhookUrl),
          "과 위 웹훅 secret으로 웹훅을 만드세요. 외부에서는 HTTPS 주소를 써야 합니다.",
        ),
        h(
          "li",
          {},
          "재시작 후 이 페이지를 새로고침하고 관리자 토큰으로 로그인해 '점검'과 '워커 페어링'을 진행하세요.",
        ),
      ),
    );
  }

  fill(root, h("h1", {}, "Router 초기 설정"), stepper, body);
  if (wizard.step > 0) {
    loadState()
      .then(draw)
      .catch(() => {
        setToken(null);
        go(0);
      });
  } else {
    draw();
  }
}
