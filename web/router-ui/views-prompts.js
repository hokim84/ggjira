import { admin } from "./api.js";
import { errorNotice, fill, h, notice } from "./dom.js";

function section(title, content) {
  return h(
    "details",
    {},
    h("summary", {}, title),
    h("pre", { class: "preview prompt-text" }, content),
  );
}

export async function renderPrompts(root) {
  const { roles, editable } = await admin("GET", "/prompts");
  fill(
    root,
    h("h1", {}, "AI 역할별 프롬프트"),
    h(
      "p",
      { class: "muted" },
      "플랜·구현·기술부채 변화 설명의 기본 지침을 확인하고 역할별 추가 지침을 저장합니다. 모든 프로젝트와 Worker에 공통 적용됩니다.",
    ),
    h(
      "p",
      { class: "muted" },
      "저장 후 새로 Worker에 전달되는 실행부터 적용됩니다. 실행 중인 작업은 바뀌지 않습니다. 출력 형식과 실행 권한은 코드에서 관리합니다.",
    ),
    h(
      "p",
      { class: "muted" },
      "통합 검증은 AI 호출 없이 수행하는 자동 검사입니다. 입력 예시는 실제 이슈 데이터가 아니며, CLI·저장소 지침이나 작업별 실행 규칙까지 합친 전체 입력은 아닙니다.",
    ),
    !editable ? notice("warn", "설정 파일이 연결되지 않아 추가 지침을 저장할 수 없습니다.") : null,
    roles.map((role) => roleEditor(role, editable)),
  );
}

function roleEditor(role, editable) {
  let saved = role.additionalInstructions;
  let busy = false;
  const input = h("textarea", {
    id: `prompt-${role.id}`,
    rows: 8,
    maxlength: 20000,
    value: saved,
    disabled: !editable,
    class: "prompt-text",
  });
  const status = h("div", { role: "status", "aria-live": "polite" });
  const result = h("div", {});
  const preview = section("기본 지침과 추가 지침 합쳐 보기", role.effectiveSystemPrompt);
  const save = h("button", { type: "submit", class: "btn btn-primary" }, "저장");
  const reset = h(
    "button",
    {
      type: "button",
      class: "btn",
      onclick: () => {
        input.value = "";
        update();
        fill(result, notice("info", "추가 지침을 비웠습니다. 저장하면 기본 지침만 적용됩니다."));
      },
    },
    "추가 지침 초기화",
  );
  function update() {
    const dirty = input.value !== saved;
    status.textContent = dirty ? "미저장 변경 사항이 있습니다." : "저장된 내용과 같습니다.";
    save.disabled = !editable || busy || !dirty;
    reset.disabled = !editable || busy || !input.value;
  }
  input.addEventListener("input", () => {
    fill(result);
    update();
  });
  const form = h(
    "form",
    {
      onsubmit: async (event) => {
        event.preventDefault();
        if (busy || !editable || input.value === saved) return;
        busy = true;
        input.disabled = true;
        update();
        fill(result, notice("info", "저장 중…"));
        try {
          const response = await admin("PUT", `/prompts/${role.id}`, {
            additionalInstructions: input.value,
          });
          const updated = response.roles.find((entry) => entry.id === role.id);
          saved = updated.additionalInstructions;
          preview.querySelector("pre").textContent = updated.effectiveSystemPrompt;
          fill(result, notice("ok", "저장했습니다. 이후 새로 전달되는 실행부터 적용됩니다."));
        } catch (error) {
          fill(result, errorNotice(error));
        } finally {
          busy = false;
          input.disabled = !editable;
          update();
        }
      },
    },
    h("label", { for: input.id }, "추가 지침"),
    input,
    h(
      "p",
      { class: "muted" },
      "최대 20,000자. 기본 지침 뒤에 추가됩니다. 빈 내용으로 저장하면 추가 지침을 제거합니다.",
    ),
    status,
    h("div", { class: "form-actions" }, save, reset),
    result,
  );
  update();
  return h(
    "section",
    { class: "panel", "aria-label": `${role.title} 프롬프트` },
    h("h2", {}, role.title),
    h("p", {}, role.description),
    section("기본 지침 (읽기 전용)", role.systemPrompt),
    form,
    preview,
    section("작업별 입력 예시", role.examplePrompt),
    section("결과 출력 형식 (JSON Schema)", JSON.stringify(role.outputSchema, null, 2)),
  );
}
