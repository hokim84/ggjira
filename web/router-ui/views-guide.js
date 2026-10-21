// Read-only workflow guide. Diagrams use semantic HTML and local SVG icons.
import { fill, h } from "./dom.js";

const ICONS = {
  person: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21v-2a8 8 0 0 1 16 0v2",
  auto: "m13 2-9 12h7l-1 8 10-13h-7l1-7Z",
  plan: "M8 4H5v18h14V4h-3M8 2h8v5H8V2Zm0 10h8m-8 5h5",
  branch: "M6 3v12a5 5 0 0 0 5 5h7M6 8h7a5 5 0 0 0 5-5M3 3h6m6 0h6m-6 17h6",
  check: "m5 12 4 4L19 6",
  inspect: "M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm5-2 7 7m-15-12 2 2 4-4",
  arrow: "M4 12h16m-6-6 6 6-6 6",
  loop: "M5 8a8 8 0 0 1 14 0l2 4m0-7v7h-7m5 4a8 8 0 0 1-14 0l-2-4m0 7v-7h7",
  comment: "M4 3h16v13H9l-5 5V3Zm4 5h8m-8 4h5",
};

function icon(name, className = "") {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  for (const [key, value] of Object.entries({
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.7",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    focusable: "false",
    class: `guide-icon ${className}`,
  }))
    svg.setAttribute(key, value);
  const drawing = document.createElementNS(ns, "path");
  drawing.setAttribute("d", ICONS[name]);
  svg.append(drawing);
  return svg;
}

function owner(human = false) {
  return h(
    "span",
    { class: `guide-owner ${human ? "is-human" : "is-auto"}` },
    icon(human ? "person" : "auto"),
    human ? "사람" : "자동",
  );
}

function arrow() {
  return h("span", { class: "guide-arrow", "aria-hidden": "true" }, icon("arrow"));
}

function step(number, title, symbol, body, human = false) {
  return h(
    "li",
    { class: `guide-stage ${human ? "is-human" : "is-auto"}` },
    h(
      "div",
      { class: "guide-stage-top" },
      h("span", { class: "guide-number" }, number),
      owner(human),
    ),
    icon(symbol, "guide-stage-icon"),
    h("h3", {}, title),
    ...body,
  );
}

function mini(title, description, human = false) {
  return h(
    "li",
    { class: `guide-mini ${human ? "is-human" : "is-auto"}` },
    owner(human),
    h("strong", {}, title),
    h("small", {}, description),
  );
}

function sequence(items, className = "") {
  return h("ol", { class: `guide-sequence ${className}` }, items);
}

function decision(number, title, consequence, tone = "") {
  return h(
    "li",
    { class: `guide-decision ${tone}` },
    h("span", { class: "guide-choice-number" }, number),
    h("strong", {}, title),
    h("small", {}, consequence),
  );
}

export function renderGuide(root) {
  fill(
    root,
    h(
      "article",
      { class: "guide", "aria-labelledby": "guide-title" },
      h(
        "header",
        { class: "guide-heading" },
        h(
          "div",
          {},
          h("p", { class: "guide-eyebrow" }, "GGJIRA WORKFLOW"),
          h("h1", { id: "guide-title" }, "작업은 자식에서, 완성은 부모에서"),
          h("p", { class: "muted" }, "계획 → 개별 구현 → 통합 평가 → 최종 검토"),
        ),
        h("div", { class: "guide-legend", "aria-label": "처리 주체 범례" }, owner(true), owner()),
      ),

      h(
        "section",
        { class: "panel guide-main", "aria-labelledby": "guide-parent" },
        h("h2", { id: "guide-parent" }, "부모 태스크"),
        h(
          "p",
          { class: "guide-status-band" },
          icon("plan"),
          h("strong", {}, "AI 계획 검토"),
          h("span", {}, "01–03 동안 유지"),
        ),
        sequence(
          [
            step("01", "계획 작성", "plan", [
              h("span", { class: "guide-trigger is-human" }, icon("person"), "부모 → AI 계획 검토"),
              h("p", {}, "목표를 읽고 작업 분해"),
              h("span", { class: "guide-output" }, "대기 상태 자식 생성"),
            ]),
            step("02", "자식 실행", "branch", [
              h("span", { class: "guide-trigger is-human" }, icon("person"), "각 자식 → 작업 중"),
              h("p", {}, "선택한 자식만 구현"),
              h("span", { class: "guide-output" }, "전체 완료·병합 대기"),
            ]),
            step("03", "완료 평가", "inspect", [
              h("span", { class: "guide-trigger" }, icon("check"), "필수 자식 모두 완료·통합"),
              h("p", {}, "통합 검증 + 기술부채 평가"),
              h("span", { class: "guide-output" }, "판단·개선 후 최신성 재확인"),
            ]),
            step(
              "04",
              "최종 검토",
              "check",
              [
                h("span", { class: "guide-trigger" }, icon("auto"), "부모 → AI 결과 검토"),
                h("p", {}, "전체 결과 확인"),
                h(
                  "span",
                  { class: "guide-output guide-finish" },
                  icon("person"),
                  "사람이 최종 완료",
                ),
              ],
              true,
            ),
          ],
          "guide-parent-flow",
        ),
        h(
          "p",
          { class: "guide-caption" },
          "단계 번호는 진행 순서입니다. Jira 상태는 강조된 이름으로 확인하세요.",
        ),
      ),

      h(
        "section",
        { class: "panel guide-child", "aria-labelledby": "guide-child" },
        h(
          "div",
          { class: "guide-section-heading" },
          h("h2", { id: "guide-child" }, icon("branch"), "02 · 각 자식의 실행 흐름"),
          h("span", { class: "guide-label" }, "생성 후, 사람이 시작"),
        ),
        sequence(
          [
            mini("대기", "계약 게시"),
            mini("작업 중", "사람이 상태 이동", true),
            mini("구현·검증", "Worker 실행"),
            mini("AI 결과 검토", "자동 이동 · 사람이 결과 확인", true),
            mini("AI 작업 완료", "검토한 코드 병합 후 자동 이동"),
          ],
          "guide-child-flow",
        ),
        h(
          "div",
          { class: "guide-loop" },
          icon("loop"),
          h("strong", {}, "개선 필요"),
          arrow(),
          h("span", {}, "개선 자식 생성"),
          arrow(),
          h("span", { class: "is-human" }, "사람이 작업 중으로 이동"),
          arrow(),
          h("span", {}, "완료·통합 후 재평가"),
        ),
      ),

      h(
        "div",
        { class: "guide-support" },
        h(
          "section",
          { class: "panel", "aria-labelledby": "guide-question" },
          h("h2", { id: "guide-question" }, icon("comment"), "계획에서 질문이 오면"),
          h(
            "div",
            { class: "guide-reply-flow" },
            h("span", { class: "guide-note" }, "번호가 있는 선택지"),
            arrow(),
            h(
              "div",
              { class: "guide-reply is-human" },
              owner(true),
              h("code", {}, "2"),
              h("small", {}, "담당자가 댓글"),
            ),
            arrow(),
            h("span", { class: "guide-note" }, "계획 자동 재개"),
          ),
        ),
        h(
          "section",
          { class: "panel", "aria-labelledby": "guide-debt" },
          h("h2", { id: "guide-debt" }, icon("inspect"), "기술부채는 한 항목씩 판단"),
          h(
            "ol",
            { class: "guide-decisions" },
            decision("1", "이번에 개선", "필수 자식 생성", "guide-adopt"),
            decision("2", "후속 이관", "별도 이슈 생성"),
            decision("3", "수용·기각", "판단 기록"),
            decision("4", "보류", "판단 대기"),
          ),
          h(
            "p",
            { class: "guide-example" },
            icon("comment"),
            h("code", {}, "2 다음 릴리스에서 처리"),
          ),
          h(
            "p",
            { class: "guide-footnote" },
            "2–4는 사유 필수 · 결함·환경 장애·근거 부족은 1 또는 4",
          ),
        ),
      ),

      h(
        "details",
        { class: "panel guide-help" },
        h("summary", {}, "막혔을 때 / 이전 계획"),
        h(
          "div",
          { class: "guide-help-grid" },
          h(
            "div",
            {},
            h("h3", {}, "계획·평가 실패"),
            h("p", {}, "원인 해결 → 담당자 댓글 ", h("code", {}, "재시도")),
          ),
          h(
            "div",
            {},
            h("h3", {}, "자식 시작 후 요구사항 변경"),
            h("p", {}, "실행 종료 확인 → 담당자 댓글 ", h("code", {}, "재계획")),
          ),
        ),
        h(
          "p",
          { class: "guide-footnote" },
          "구현 실패·연결 끊김은 이슈의 복구 안내를 확인하세요. 실패나 판단 대기는 결과 검토로 이동하지 않습니다.",
        ),
        h(
          "p",
          { class: "guide-footnote" },
          "이전 생명주기의 계획은 부모를 작업 중으로 이동해 승인하는 기존 흐름을 따릅니다.",
        ),
      ),
      h(
        "footer",
        { class: "guide-footer" },
        "현재 생명주기 v2 기준 · 상태 이름은 워크스페이스 설정에 따라 다를 수 있습니다.",
        h("a", { href: "#/issues" }, "이슈 보기 →"),
      ),
    ),
  );
}
