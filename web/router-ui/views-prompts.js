import { admin } from "./api.js";
import { fill, h } from "./dom.js";

function section(title, content) {
  return h(
    "details",
    {},
    h("summary", {}, title),
    h("pre", { class: "preview prompt-text" }, content),
  );
}

export async function renderPrompts(root) {
  const { agents } = await admin("GET", "/prompts");
  fill(
    root,
    h("h1", {}, "Agent 프롬프트"),
    h(
      "p",
      { class: "muted" },
      "현재 Router 코드에 정의된 기본 지침입니다. 작업별 입력은 예시이며, 실제 실행에서는 해당 이슈의 내용으로 채워집니다.",
    ),
    h(
      "p",
      { class: "muted" },
      "읽기 전용 · 과거 실행에 전달된 내용이나 CLI 자체 지침, 저장소 지침까지 합친 전체 입력은 아닙니다.",
    ),
    agents.map((agent) =>
      h(
        "section",
        { class: "panel" },
        h("h2", {}, agent.title),
        h("p", { class: "muted" }, "정의 위치: ", h("code", {}, agent.source)),
        h("h3", {}, "기본 지침 원문"),
        h("pre", { class: "preview prompt-text" }, agent.systemPrompt),
        section("작업별 입력 예시", agent.examplePrompt),
        section("결과 출력 형식 (JSON Schema)", JSON.stringify(agent.outputSchema, null, 2)),
      ),
    ),
  );
}
