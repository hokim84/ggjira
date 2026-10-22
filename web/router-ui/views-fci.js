import { admin } from "./api.js";
import { errorNotice, fill, h, notice } from "./dom.js";

const AXES = {
  coupling: "모듈 의존성·결합도",
  complexity: "제어 흐름·구조 복잡도",
  verification: "테스트·검증 어려움",
  ripple: "변경 파급·인터페이스 결합",
  history: "Git 이력의 변경 위험",
};
const DEFAULT_WEIGHTS = {
  coupling: 0.25,
  complexity: 0.2,
  verification: 0.25,
  ripple: 0.2,
  history: 0.1,
};
const number = (v) => (v === null || v === undefined ? "평가 불가" : Number(v).toFixed(2));
const label = (s) =>
  ({
    queued: "대기",
    running: "분석 중",
    succeeded: "분석 완료",
    failed: "실패",
    unassessable: "평가 불가",
  })[s] ?? s;
function disclosure(title, ...content) {
  return h("details", {}, h("summary", {}, title), content);
}
function chart(items, value, title) {
  const points = items.map(value);
  const known = points.filter((v) => v !== null && v !== undefined);
  const wrap = h("section", {}, h("h3", {}, title));
  if (!known.length)
    return h(
      "div",
      {},
      h("h3", {}, title),
      h(
        "p",
        { class: "muted" },
        "표시할 평가값이 없습니다. 실패·평가 불가 값은 0으로 그리지 않습니다.",
      ),
    );
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 800 220");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", title);
  svg.style.width = "100%";
  const min = Math.min(80, ...known) - 5;
  const max = Math.max(120, ...known) + 5;
  function el(tag, attrs, text) {
    const node = document.createElementNS(svg.namespaceURI, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    if (text) node.textContent = text;
    svg.append(node);
    return node;
  }
  const y = (v) => 190 - ((v - min) / (max - min)) * 160;
  el("line", {
    x1: 45,
    y1: y(100),
    x2: 785,
    y2: y(100),
    stroke: "#a1a9b6",
    "stroke-dasharray": "4 4",
  });
  el("text", { x: 0, y: y(100), fill: "#546072", "font-size": 12 }, "100");
  let previous = null;
  points.forEach((v, i) => {
    const x = 55 + (i * 720) / Math.max(1, points.length - 1);
    if (v === null || v === undefined) {
      previous = null;
      el("text", { x, y: 210, fill: "#a54e28", "font-size": 10 }, "미평가");
      return;
    }
    if (previous && items[i].before_sha === items[i - 1]?.after_sha)
      el("line", {
        x1: previous.x,
        y1: previous.y,
        x2: x,
        y2: y(v),
        stroke: "#3667cb",
        "stroke-width": 2,
      });
    const link = document.createElementNS(svg.namespaceURI, "a");
    link.setAttribute(
      "href",
      `#/repositories?repository=${encodeURIComponent(items[i].repository_id)}&series=${encodeURIComponent(items[i].series_id)}&analysis=${encodeURIComponent(items[i].id)}`,
    );
    const dot = document.createElementNS(svg.namespaceURI, "circle");
    dot.setAttribute("cx", String(x));
    dot.setAttribute("cy", String(y(v)));
    dot.setAttribute("r", "5");
    dot.setAttribute("fill", "#3667cb");
    const tip = document.createElementNS(svg.namespaceURI, "title");
    tip.textContent = `${items[i].pr_repo ?? "기준"} #${items[i].pr_number ?? ""}: ${number(v)}`;
    dot.append(tip);
    link.append(dot);
    svg.append(link);
    previous = { x, y: y(v) };
  });
  wrap.append(svg);
  return wrap;
}
export async function renderFci(root) {
  const view = await admin("GET", "/fci");
  const params = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const selected = params.get("repository") ?? view.repositories[0]?.id;
  const repo = view.repositories.find((r) => r.id === selected);
  fill(
    root,
    h("h1", {}, "저장소 FCI"),
    notice("info", view.notice),
    h(
      "p",
      {},
      "전체 저장소 상태를 측정하며 PR별 위험 점수를 누적하지 않습니다. FCI = 100 + 현재 원점수 − 기준 원점수.",
    ),
  );
  const choose = h(
    "select",
    {
      "aria-label": "저장소",
      onchange: (e) => {
        location.hash = `#/repositories?repository=${encodeURIComponent(e.target.value)}`;
      },
    },
    view.repositories.map((r) =>
      h("option", { value: r.id, selected: r.id === selected }, r.displayName ?? r.id),
    ),
  );
  root.append(choose);
  if (!repo) return;
  const cfg = repo.fci ?? {};
  const enabled = h("input", { type: "checkbox", checked: cfg.enabled });
  const baseline = h("input", {
    value: cfg.baselineSha ?? "",
    pattern: "[a-f0-9]{40}",
    placeholder: "40자리 커밋 SHA",
  });
  const model = h("input", {
    value: cfg.modelId ?? "",
    placeholder: "Worker provider에 명시한 모델 ID",
  });
  const version = h("input", { value: cfg.ruleVersion ?? "fci-v1" });
  const providerType = h(
    "select",
    {},
    ["codex", "claude-code"].map((type) =>
      h("option", { value: type, selected: type === (cfg.providerType ?? "codex") }, type),
    ),
  );
  const weights = Object.fromEntries(
    Object.keys(AXES).map((axis) => [
      axis,
      h("input", {
        type: "number",
        min: 0,
        max: 100,
        step: 0.1,
        value: 100 * (cfg.weights ?? DEFAULT_WEIGHTS)[axis],
      }),
    ]),
  );
  const result = h("div");
  const save = h("button", { type: "submit", class: "btn btn-primary" }, "설정·기준 SHA 등록");
  const form = h(
    "form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        save.disabled = true;
        try {
          await admin("PUT", `/repositories/${encodeURIComponent(repo.id)}/fci`, {
            enabled: enabled.checked,
            ...(baseline.value ? { baselineSha: baseline.value } : {}),
            ...(model.value ? { modelId: model.value } : {}),
            ruleVersion: version.value,
            providerType: providerType.value,
            weights: Object.fromEntries(
              Object.entries(weights).map(([a, input]) => [a, Number(input.value) / 100]),
            ),
            timeoutMs: cfg.timeoutMs ?? 600000,
          });
          await renderFci(root);
        } catch (error) {
          fill(result, errorNotice(error));
        } finally {
          save.disabled = false;
        }
      },
    },
    h("label", {}, enabled, " FCI 활성화 (기본 비활성화)"),
    h(
      "div",
      { class: "grid" },
      h("label", {}, "추적 기준 SHA (명시적 등록)", baseline),
      h("label", {}, "분석 모델 ID", model),
      h("label", {}, "기존 AI provider 종류", providerType),
      h("label", {}, "평가 규칙 버전", version),
    ),
    h(
      "p",
      { class: "muted" },
      "Worker의 provider 모델 ID와 일치해야 합니다. 기준·가중치·프롬프트·모델 변경은 별도 시계열로 보관됩니다. 기존 리뷰 추가 지침은 자동 이전하지 않습니다.",
    ),
    h(
      "div",
      { class: "grid" },
      Object.entries(AXES).map(([axis, title]) => h("label", {}, `${title} (%)`, weights[axis])),
    ),
    h("div", { class: "form-actions" }, save),
    result,
  );
  root.append(disclosure("분석 설정·기준 등록", form));
  const series = view.series.filter((s) => s.repository_id === repo.id);
  const seriesId = params.get("series") ?? series[0]?.id;
  root.append(
    h(
      "label",
      {},
      "시계열",
      h(
        "select",
        {
          "aria-label": "시계열",
          onchange: (e) => {
            location.hash = `#/repositories?repository=${encodeURIComponent(repo.id)}&series=${encodeURIComponent(e.target.value)}`;
          },
        },
        series.map((s) =>
          h(
            "option",
            { value: s.id, selected: s.id === seriesId },
            `${s.profile.ruleVersion} / ${s.profile.model} / ${s.baseline_sha.slice(0, 12)} / ${s.created_at}`,
          ),
        ),
      ),
    ),
  );
  const analyses = view.analyses.filter((a) => a.series_id === seriesId);
  const confirmed = analyses
    .filter((a) => a.revision === 0 && !a.superseded && a.purpose === "merge_final")
    .sort(
      (a, b) =>
        (a.outcome?.change?.targetOrder ?? Number.MAX_SAFE_INTEGER) -
        (b.outcome?.change?.targetOrder ?? Number.MAX_SAFE_INTEGER),
    );
  const baselinePoint = analyses.find((a) => a.purpose === "baseline" && a.revision === 0);
  const timeline = baselinePoint ? [baselinePoint, ...confirmed] : confirmed;
  if (!cfg.enabled) root.append(notice("warn", "FCI 비활성화 상태입니다. 기존 이력만 표시합니다."));
  root.append(chart(timeline, (a) => a.afterFci, "확정 FCI · 병합 순서"));
  root.append(
    disclosure(
      "축별 확정 추이",
      Object.entries(AXES).map(([axis, title]) =>
        chart(
          timeline,
          (a) => {
            const current = a.after?.assessment.axes[axis].grade;
            const base = a.baseline?.assessment.axes[axis].grade;
            return current == null || base == null ? null : 100 + 25 * (current - base);
          },
          title,
        ),
      ),
    ),
  );
  root.append(
    h(
      "p",
      { class: "muted" },
      "연속된 병합 전후 SHA가 일치하지 않는 지점은 선을 연결하지 않습니다. 추적 외 변경·누락 구간은 PR의 Δ에 합산하지 않습니다.",
    ),
  );
  root.append(h("h2", {}, "분석 기록 · 잠정 / 확정 / 실패 / 평가 불가"));
  for (const analysis of analyses) {
    const a = analysis;
    const actions = h("div", { class: "form-actions" });
    for (const [action, title] of [
      ["retry", "분석만 재시도"],
      ["reanalyze", "명시적 재분석"],
      ["report-retry", "보고만 재시도"],
    ])
      actions.append(
        h(
          "button",
          {
            class: "btn",
            type: "button",
            disabled: a.status === "running",
            onclick: async () => {
              try {
                await admin("POST", `/fci/${a.id}/${action}`, {});
                await renderFci(root);
              } catch (error) {
                actions.after(errorNotice(error));
              }
            },
          },
          title,
        ),
      );
    const section = h(
      "section",
      { class: "panel", id: `analysis-${a.id}` },
      h(
        "h3",
        {},
        `${a.purpose === "merge_final" ? "확정 대상" : a.purpose === "baseline" ? "기준점" : "잠정·예상"} · ${label(a.status)}${a.superseded ? " · 오래된 결과" : ""}${a.revision ? " · 재분석 revision" : ""}`,
      ),
      h("p", {}, `FCI ${number(a.beforeFci)} → ${number(a.afterFci)} / ΔFCI ${number(a.delta)}`),
      h("p", {}, `원점수 ${number(a.rawBefore)} → ${number(a.rawAfter)}`),
      h("code", {}, `${a.before_sha} → ${a.after_sha}`),
      a.pr_repo
        ? h(
            "p",
            {},
            h(
              "a",
              {
                href: `https://github.com/${a.pr_repo}/pull/${a.pr_number}`,
                target: "_blank",
                rel: "noreferrer",
              },
              `${a.pr_repo} #${a.pr_number}`,
            ),
          )
        : null,
      a.issue_key ? h("p", {}, `Jira: ${a.issue_key} / 실행: ${a.job_id ?? "없음"}`) : null,
      a.error ? notice("error", a.error) : null,
      a.after
        ? h(
            "div",
            {},
            h("p", {}, a.after.assessment.summary),
            ...Object.entries(AXES).map(([axis, title]) => {
              const value = a.after.assessment.axes[axis];
              return disclosure(
                `${title}: ${value.grade ?? "평가 불가"} · 신뢰도 ${value.confidence}`,
                h("p", {}, value.explanation),
                value.evidence.map((e) =>
                  h(
                    "p",
                    {},
                    a.pr_repo
                      ? h(
                          "a",
                          {
                            href: `https://github.com/${a.pr_repo}/blob/${a.after.sha}/${e.path.split("/").map(encodeURIComponent).join("/")}#L${e.line}`,
                            target: "_blank",
                            rel: "noreferrer",
                          },
                          `${e.path}:${e.line}`,
                        )
                      : h("code", {}, `${e.path}:${e.line}`),
                    ` — ${e.explanation}`,
                  ),
                ),
                value.uncertainties.map((u) => h("p", {}, u)),
              );
            }),
            h("h4", {}, "FCI 개선 우선순위"),
            a.after.assessment.priorities.map((p) => h("p", {}, `${p.priority}: ${p.suggestion}`)),
            h("h4", {}, "불확실성·미검증"),
            a.after.assessment.unverified.map((u) => h("p", {}, u)),
          )
        : null,
      actions,
      disclosure(
        "관측값·평가 버전·테스트·재시도 근거",
        h("pre", { class: "preview" }, JSON.stringify(a, null, 2)),
      ),
    );
    root.append(section);
  }
  const analysisId = params.get("analysis");
  if (analysisId) root.querySelector(`#analysis-${CSS.escape(analysisId)}`)?.scrollIntoView();
  if (view.pollErrors?.length)
    root.append(
      notice(
        "error",
        "PR 분석 메타데이터 조회 실패",
        h("pre", {}, JSON.stringify(view.pollErrors, null, 2)),
      ),
    );
}
