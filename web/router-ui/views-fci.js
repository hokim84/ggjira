import { admin } from "./api.js";
import { errorNotice, fill, h, notice } from "./dom.js";

const AXES = { coupling: "의존성", complexity: "복잡도", duplication: "중복", ripple: "변경 파급" };
const COLORS = {
  fci: "#527beb",
  coupling: "#c28b18",
  complexity: "#d56780",
  duplication: "#8b67ce",
  ripple: "#20998b",
};
const n = (value) => (value == null ? "미평가" : Number(value).toFixed(1));
const label = (value) =>
  ({
    missing: "미평가",
    queued: "대기",
    running: "평가 중",
    succeeded: "평가 완료",
    failed: "실패",
    unassessable: "평가 불가",
  })[value] ?? value;
const details = (title, ...body) => h("details", {}, h("summary", {}, title), body);

function graph(commits, selected, onSelect) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 1000 340");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "커밋 순서에 따른 FCI. 점을 선택하면 상세 설명을 엽니다.");
  svg.style.width = "100%";
  const add = (tag, attrs, text) => {
    const node = document.createElementNS(svg.namespaceURI, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    if (text) node.textContent = text;
    svg.append(node);
    return node;
  };
  const value = (c, axis) => (axis === "fci" ? c.fci : c.axes[axis]);
  const values = commits
    .flatMap((c) => selected.map((axis) => value(c, axis)))
    .filter((v) => v != null);
  const min = Math.min(90, ...values) - 5;
  const max = Math.max(110, ...values) + 5;
  const x = (i) => 65 + (900 * i) / Math.max(1, commits.length - 1);
  const y = (v) => 280 - ((v - min) * 250) / (max - min);
  const clickable = (node, c) => {
    node.addEventListener("click", () => onSelect(c));
    node.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onSelect(c);
      }
    });
  };
  for (const v of [min, 100, max]) {
    add("line", {
      x1: 55,
      x2: 980,
      y1: y(v),
      y2: y(v),
      stroke: "#8994a5",
      "stroke-dasharray": "3 5",
      opacity: 0.5,
    });
    add("text", { x: 5, y: y(v) + 4, fill: "currentColor", "font-size": 13 }, n(v));
  }
  for (const axis of selected) {
    let previous = null;
    commits.forEach((c, i) => {
      const v = value(c, axis);
      if (v == null) {
        previous = null;
        return;
      }
      if (previous && c.parent_sha === commits[i - 1]?.sha)
        add("line", {
          x1: previous.x,
          x2: x(i),
          y1: previous.y,
          y2: y(v),
          stroke: COLORS[axis],
          "stroke-width": axis === "fci" ? 3 : 1.5,
        });
      const dot = add("circle", {
        cx: x(i),
        cy: y(v),
        r: axis === "fci" ? 5 : 3,
        fill: c.confidence === "low" ? "var(--bg, #fff)" : COLORS[axis],
        stroke: COLORS[axis],
        "stroke-width": 2,
        tabindex: 0,
        role: "button",
        "aria-label": `${c.sha.slice(0, 7)} ${axis === "fci" ? "FCI" : AXES[axis]} ${n(v)}`,
      });
      clickable(dot, c);
      const title = document.createElementNS(svg.namespaceURI, "title");
      title.textContent = `${c.sha.slice(0, 7)} ${c.title}: ${n(v)}${c.confidence === "low" ? " · 낮은 신뢰도" : ""}`;
      dot.append(title);
      previous = { x: x(i), y: y(v) };
    });
  }
  commits.forEach((c, i) => {
    if (c.fci == null)
      clickable(
        add(
          "text",
          {
            x: x(i),
            y: 305,
            fill: "currentColor",
            "text-anchor": "middle",
            tabindex: 0,
            role: "button",
            "aria-label": `${c.sha.slice(0, 7)} ${label(c.status)}`,
          },
          "◇",
        ),
        c,
      );
  });
  add(
    "text",
    { x: 65, y: 332, fill: "currentColor", "font-size": 12 },
    commits[0]?.sha.slice(0, 7) ?? "시작 커밋",
  );
  add(
    "text",
    { x: 980, y: 332, fill: "currentColor", "font-size": 12, "text-anchor": "end" },
    commits.at(-1)?.sha.slice(0, 7) ?? "",
  );
  return svg;
}

export async function renderFci(root) {
  const params = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const view = await admin("GET", "/fci?summary=1");
  const repo =
    view.repositories.find((r) => r.id === params.get("repository")) ?? view.repositories[0];
  fill(root, h("h1", {}, "저장소 FCI"));
  if (!repo) {
    root.append(h("p", {}, "저장소를 먼저 연결해 주세요."));
    return;
  }
  const prefix = `/repositories/${encodeURIComponent(repo.id)}/fci`;
  const navigate = (offset = 0) => {
    location.hash = `#/repositories?repository=${encodeURIComponent(repo.id)}&offset=${offset}`;
  };
  if (view.repositories.length > 1)
    root.append(
      h(
        "select",
        {
          "aria-label": "저장소",
          onchange: (e) => {
            location.hash = `#/repositories?repository=${encodeURIComponent(e.target.value)}`;
          },
        },
        view.repositories.map((r) =>
          h("option", { value: r.id, selected: r.id === repo.id }, r.displayName ?? r.id),
        ),
      ),
    );
  const enabled = h("input", { type: "checkbox", checked: repo.fci.enabled });
  const baseline = h("input", {
    value: repo.fci.baselineSha ?? "",
    placeholder: "시작 커밋 SHA",
    spellcheck: false,
    "aria-label": "시작 커밋",
    required: true,
    pattern: "[a-fA-F0-9]{7,40}",
  });
  const settings = h(
    "form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await admin("PUT", prefix, {
            enabled: enabled.checked,
            baselineSha: baseline.value.trim().toLowerCase(),
            ruleVersion: "fci-static-v2",
          });
          await renderFci(root);
        } catch (error) {
          settings.append(errorNotice(error));
        }
      },
    },
    h("label", {}, enabled, " FCI 사용"),
    h("label", {}, "시작 커밋 ", baseline),
    h("button", { class: "btn", type: "submit" }, "적용"),
    h(
      "p",
      { class: "muted" },
      `대상 브랜치: ${repo.baseBranch} · 언어 자동 감지 · AI 없이 구조 평가`,
    ),
  );
  root.append(repo.fci.enabled ? details("시작점 변경·사용 설정", settings) : settings);
  root.append(
    h(
      "p",
      { class: "muted" },
      "시작점은 100입니다. 높아질수록 구조상 변경 부담이 큽니다. 실제 개발 비용이나 장애 확률을 뜻하지 않습니다.",
    ),
  );
  const archive = details("보관된 분석·평가 버전");
  archive.addEventListener("toggle", () => {
    if (!archive.open || archive.dataset.loaded) return;
    archive.dataset.loaded = "true";
    for (const record of (view.records ?? []).filter(
      (r) => r.repository_id === repo.id && !["history_scan", "explain"].includes(r.purpose),
    ))
      archive.append(
        h(
          "button",
          {
            class: "btn",
            onclick: async () => {
              try {
                const analysis = await admin("GET", `/fci/${record.id}`);
                archive.append(
                  h(
                    "section",
                    { class: "panel" },
                    h(
                      "h3",
                      {},
                      `${analysis.profile.ruleVersion} · ${record.after_sha.slice(0, 7)}`,
                    ),
                    h("p", {}, `FCI ${n(analysis.beforeFci)} → ${n(analysis.afterFci)}`),
                    details(
                      "근거·이전 평가 기록",
                      h("pre", { class: "preview" }, JSON.stringify(analysis, null, 2)),
                    ),
                  ),
                );
              } catch (error) {
                archive.append(errorNotice(error));
              }
            },
          },
          `${record.after_sha.slice(0, 7)} · ${label(record.status)} · ${record.purpose}`,
        ),
      );
  });
  root.append(archive);
  if (!repo.fci.enabled) return;
  if (repo.fci.ruleVersion !== "fci-static-v2") {
    root.append(
      notice(
        "info",
        "기존 AI 평가는 보관됩니다. 설정에서 적용을 누르면 정적 FCI를 새로 시작합니다.",
      ),
    );
    return;
  }
  const offset = Math.max(0, Number(params.get("offset")) || 0);
  const history = await admin("GET", `${prefix}/history?offset=${offset}&limit=100`);
  const commits = history.commits;
  const selectedCommit = params.get("commit");
  if (selectedCommit && !commits.some((c) => c.sha === selectedCommit)) {
    try {
      const detail = await admin("GET", `${prefix}/commits/${encodeURIComponent(selectedCommit)}`);
      const targetOffset = Math.floor(detail.commit.ordinal / 100) * 100;
      if (offset !== targetOffset) {
        location.hash = `#/repositories?repository=${encodeURIComponent(repo.id)}&offset=${targetOffset}&commit=${encodeURIComponent(selectedCommit)}`;
        return;
      }
    } catch (error) {
      root.append(errorNotice(error));
    }
  }
  const progress = h("p", { role: "status" });
  const latest = h("p", { class: "fci-latest" });
  const errors = h("div");
  const controlButtons = [];
  const updateSummary = (v) => {
    progress.textContent = `${v.completed ?? 0} / ${v.total}개 평가 완료`;
    latest.textContent = v.latest
      ? `최근 평가 FCI ${n(v.latest.fci)} · ${v.latest.sha.slice(0, 7)}${v.latest.ordinal < v.total - 1 ? ` · 이후 ${v.total - 1 - v.latest.ordinal}개 미평가` : ""}`
      : "표시할 평가값이 없습니다.";
    fill(errors, v.state?.error ? notice("error", v.state.error) : null);
    for (const button of controlButtons)
      button.disabled = v.total < 2 || v.completed >= v.total || Boolean(v.state?.error);
  };
  updateSummary(history);
  root.append(latest, progress, errors);
  const actions = h("div", { class: "form-actions fci-controls" });
  for (const [action, title] of [
    ["all", "미평가 모두 평가"],
    ["next", "다음 커밋 평가"],
    ["pause", "일시정지"],
  ]) {
    const button = h(
      "button",
      {
        class: "btn",
        type: "button",
        disabled:
          action !== "pause" &&
          (history.total < 2 ||
            history.completed >= history.total ||
            Boolean(history.state?.error)),
        onclick: async () => {
          try {
            await admin("POST", `${prefix}/control`, { action });
            await renderFci(root);
          } catch (error) {
            actions.after(errorNotice(error));
          }
        },
      },
      title,
    );
    actions.append(button);
    if (action !== "pause") controlButtons.push(button);
  }
  actions.append(h("button", { class: "btn", onclick: () => renderFci(root) }, "새로고침"));
  root.append(actions);
  const panel = h("section", { class: "panel fci-detail", "aria-live": "polite" });
  const select = async (c) => {
    try {
      const d = await admin("GET", `${prefix}/commits/${c.sha}`);
      const snapshot = d.snapshot;
      const score = snapshot?.assessment.structural;
      fill(
        panel,
        h("h2", {}, `${c.sha.slice(0, 7)} · ${c.title}`),
        h(
          "p",
          {},
          `${label(c.status)} · FCI ${n(c.fci)} · 직전 대비 ${c.delta == null ? "—" : `${c.delta > 0 ? "+" : ""}${n(c.delta)}`}`,
        ),
        h("p", { class: "muted" }, c.committed_at),
        c.error ? notice("error", c.error) : null,
      );
      if (score) {
        const before = d.previous?.assessment.structural;
        const changes = Object.keys(AXES)
          .map((axis) => ({
            axis,
            delta:
              score.axes[axis] == null || before?.axes[axis] == null
                ? null
                : score.axes[axis] - before.axes[axis],
          }))
          .sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0));
        panel.append(
          h(
            "p",
            {},
            changes
              .map(
                (v) =>
                  `${AXES[v.axis]} ${v.delta == null ? "—" : `${v.delta > 0 ? "+" : ""}${n(v.delta)}`}`,
              )
              .join(" · "),
          ),
          h(
            "p",
            {},
            `분석 범위 ${Math.round(score.coverage * 100)}% · 신뢰도 ${{ high: "높음", medium: "보통", low: "낮음" }[score.confidence]} · 테스트 실행 안 함`,
          ),
        );
        panel.append(
          details(
            "분석 한계",
            score.reasons.map((r) => h("p", {}, r)),
          ),
        );
        for (const f of d.findings ?? [])
          panel.append(
            h(
              "p",
              {},
              h("strong", {}, `${AXES[f.axis]}: `),
              f.explanation,
              " · ",
              f.url
                ? h(
                    "a",
                    { href: f.url, target: "_blank", rel: "noreferrer" },
                    `${f.path}:${f.line}`,
                  )
                : h("code", {}, `${f.path}:${f.line}`),
            ),
            h("p", { class: "muted" }, f.suggestion),
          );
        panel.append(
          h(
            "button",
            {
              class: "btn",
              disabled: score.raw == null,
              onclick: async () => {
                try {
                  await admin("POST", `${prefix}/control`, { action: "explain", sha: c.sha });
                  await select(c);
                } catch (error) {
                  panel.append(errorNotice(error));
                }
              },
            },
            "AI로 설명",
          ),
        );
      }
      for (const explanation of d.explanations) {
        const output = explanation.outcome ? JSON.parse(explanation.outcome) : null;
        panel.append(
          h("p", {}, `AI 설명: ${label(explanation.status)}`),
          h(
            "pre",
            { class: "preview" },
            output?.change?.explanation ?? explanation.error ?? "Worker 대기 중",
          ),
        );
        if (explanation.status === "failed")
          panel.append(
            h(
              "button",
              {
                class: "btn",
                onclick: async () => {
                  await admin("POST", `/fci/${explanation.id}/retry`, {});
                  await select(c);
                },
              },
              "설명 재시도",
            ),
          );
      }
      for (const pr of d.prs)
        panel.append(
          h(
            "p",
            {},
            h(
              "a",
              {
                href: `https://github.com/${pr.pr_repo}/pull/${pr.pr_number}`,
                target: "_blank",
                rel: "noreferrer",
              },
              `PR #${pr.pr_number}`,
            ),
            pr.issue_key
              ? [
                  " · ",
                  h(
                    "a",
                    {
                      href: `${d.jiraBaseUrl.replace(/\/$/, "")}/browse/${encodeURIComponent(pr.issue_key)}`,
                      target: "_blank",
                      rel: "noreferrer",
                    },
                    pr.issue_key,
                  ),
                ]
              : null,
          ),
        );
      if (["failed", "unassessable"].includes(c.status) && c.taskId)
        panel.append(
          h(
            "button",
            {
              class: "btn",
              onclick: async () => {
                await admin("POST", `/fci/${c.taskId}/retry`, {});
                await renderFci(root);
              },
            },
            "평가 재시도",
          ),
        );
      if (c.status === "succeeded" && c.taskId)
        panel.append(
          details(
            "재분석",
            h("p", {}, "새 평가 기록을 추가합니다. 기존 그래프의 정규 결과는 유지합니다."),
            h(
              "button",
              {
                class: "btn",
                onclick: async () => {
                  try {
                    await admin("POST", `/fci/${c.taskId}/reanalyze`, {});
                    panel.append(
                      notice(
                        "info",
                        "재분석을 요청했습니다. 보관된 분석에서 결과를 확인할 수 있습니다.",
                      ),
                    );
                  } catch (error) {
                    panel.append(errorNotice(error));
                  }
                },
              },
              "명시적 재분석",
            ),
          ),
        );
      panel.append(
        details(
          "원점수·규칙·전체 관측",
          h("pre", { class: "preview" }, JSON.stringify(d, null, 2)),
        ),
      );
      panel.scrollIntoView({ block: "nearest" });
    } catch (error) {
      fill(panel, errorNotice(error));
    }
  };
  const chartRoot = h("div", {
    class: "fci-chart",
    tabindex: 0,
    "aria-label": "FCI 그래프 가로 스크롤",
  });
  const selected = new Set(["fci"]);
  const legend = h("div", { class: "form-actions fci-legend" });
  for (const [axis, title] of Object.entries({ fci: "종합 FCI", ...AXES }))
    legend.append(
      h(
        "label",
        {},
        h("input", {
          type: "checkbox",
          checked: selected.has(axis),
          onchange: (e) => {
            if (e.target.checked) selected.add(axis);
            else selected.delete(axis);
            fill(chartRoot, graph(commits, [...selected], select));
          },
        }),
        h("span", {
          "aria-hidden": "true",
          style: `display:inline-block;width:14px;height:3px;background:${COLORS[axis]}`,
        }),
        ` ${title}`,
      ),
    );
  root.append(legend, chartRoot);
  fill(chartRoot, graph(commits, [...selected], select));
  const emptyNotice = h("p", {}, "Worker가 시작 커밋과 대상 브랜치 이력을 확인 중입니다.");
  emptyNotice.hidden = commits.length > 0;
  root.append(emptyNotice);
  const rangeLabel = h(
    "span",
    {},
    `${history.total ? offset + 1 : 0}–${Math.min(offset + 100, history.total)} / ${history.total}`,
  );
  const nextPage = h(
    "button",
    {
      class: "btn",
      disabled: offset + 100 >= history.total,
      onclick: () => navigate(offset + 100),
    },
    "다음 100개",
  );
  const commitList = details("커밋 목록");
  const updateList = () =>
    fill(
      commitList,
      h("summary", {}, "커밋 목록"),
      commits.map((c) =>
        h(
          "button",
          { class: "btn", onclick: () => select(c) },
          `${c.sha.slice(0, 7)} ${c.title} · ${label(c.status)}`,
        ),
      ),
    );
  updateList();
  root.append(
    h(
      "div",
      { class: "form-actions" },
      h(
        "button",
        {
          class: "btn",
          disabled: offset === 0,
          onclick: () => navigate(Math.max(0, offset - 100)),
        },
        "이전 100개",
      ),
      rangeLabel,
      nextPage,
    ),
    commitList,
    panel,
  );
  if (selectedCommit) {
    const selected = commits.find((c) => c.sha === selectedCommit);
    if (selected) await select(selected);
  }
  let graphVersion = JSON.stringify(commits);
  const refresh = async () => {
    if (!progress.isConnected) return;
    try {
      const updated = await admin("GET", `${prefix}/history?offset=${offset}&limit=100`);
      if (!progress.isConnected) return;
      updateSummary(updated);
      emptyNotice.hidden = updated.total > 0;
      rangeLabel.textContent = `${updated.total ? offset + 1 : 0}–${Math.min(offset + 100, updated.total)} / ${updated.total}`;
      nextPage.disabled = offset + 100 >= updated.total;
      const version = JSON.stringify(updated.commits);
      if (version !== graphVersion) {
        graphVersion = version;
        commits.splice(0, commits.length, ...updated.commits);
        updateList();
        fill(chartRoot, graph(commits, [...selected], select));
      }
    } catch {
      progress.textContent = "평가 상태 갱신에 실패했습니다. 새로고침으로 다시 확인하세요.";
    }
    if (progress.isConnected) setTimeout(refresh, 4000);
  };
  setTimeout(refresh, 4000);
}
