// Tiny DOM builder. Text is always set via text nodes, never innerHTML.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "class") {
      el.className = value;
    } else if (key === "value") {
      el.value = value;
    } else if (key === "checked") {
      el.checked = Boolean(value);
    } else {
      el.setAttribute(key, value === true ? "" : String(value));
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children) {
    if (child === undefined || child === null || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/** Replaces el's children; arrays are flattened (native append would stringify them). */
export function fill(el, ...children) {
  clear(el);
  append(el, children);
  return el;
}

export function relativeTime(iso) {
  if (!iso) return "없음";
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 5) return "방금";
  if (seconds < 60) return `${seconds}초 전`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분 전`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}시간 전`;
  return `${Math.floor(seconds / 86400)}일 전`;
}

export function duration(ms) {
  if (ms === null || ms === undefined) return "—";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}초`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분`;
  return `${Math.floor(seconds / 3600)}시간 ${Math.floor((seconds % 3600) / 60)}분`;
}

export function notice(kind, ...children) {
  return h(
    "div",
    { class: `notice notice-${kind}`, role: kind === "error" ? "alert" : "status" },
    ...children,
  );
}

export function errorNotice(error) {
  const issues = error?.issues || [];
  return notice(
    "error",
    h("strong", {}, error?.message || String(error)),
    issues.length
      ? h(
          "ul",
          {},
          issues.map((issue) => h("li", {}, issue.path ? `${issue.path}: ` : "", issue.message)),
        )
      : null,
  );
}

export function copyButton(text, label = "복사") {
  const button = h("button", { type: "button", class: "btn btn-small" }, label);
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = "복사됨";
    } catch {
      button.textContent = "직접 선택해 복사하세요";
    }
    setTimeout(() => {
      button.textContent = label;
    }, 1500);
  });
  return button;
}

export function secretRow(label, value) {
  return h(
    "div",
    { class: "secret-row" },
    h("span", { class: "secret-label" }, label),
    h("code", { class: "secret-value" }, value),
    copyButton(value),
  );
}

// --- path-bound form fields over a plain object ---------------------------------------------

export function getPath(obj, path) {
  return path.split(".").reduce((node, key) => (node == null ? undefined : node[key]), obj);
}

export function setPath(obj, path, value) {
  const keys = path.split(".");
  let node = obj;
  keys.slice(0, -1).forEach((key, i) => {
    if (node[key] === undefined || node[key] === null) {
      node[key] = /^\d+$/.test(keys[i + 1]) ? [] : {};
    }
    node = node[key];
  });
  const last = keys[keys.length - 1];
  if (value === undefined) delete node[last];
  else node[last] = value;
}

const splitList = (text) =>
  text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

/**
 * A labelled input bound to `state` at `path`. kind: text | number | list | checkbox | select.
 * `optional` text fields delete the key when emptied.
 */
export function field(state, path, label, opts = {}) {
  const { kind = "text", optional = false, hint, options = [], placeholder } = opts;
  const current = getPath(state, path);
  let input;
  if (kind === "checkbox") {
    input = h("input", { type: "checkbox", checked: current !== false });
    input.addEventListener("change", () => setPath(state, path, input.checked));
  } else if (kind === "select") {
    const values = [...new Set([...(current ? [current] : []), ...options])];
    input = h(
      "select",
      {},
      optional || !current
        ? h("option", { value: "" }, optional ? "(사용 안 함)" : "선택하세요")
        : null,
      values.map((value) => h("option", { value, selected: value === current }, value)),
    );
    input.value = current ?? "";
    input.addEventListener("change", () =>
      setPath(state, path, input.value === "" && optional ? undefined : input.value),
    );
  } else {
    const text = kind === "list" ? (current || []).join(", ") : (current ?? "");
    input = h("input", {
      type: kind === "number" ? "number" : "text",
      value: String(text),
      placeholder,
      autocomplete: "off",
      spellcheck: "false",
    });
    input.addEventListener("input", () => {
      const raw = input.value;
      if (kind === "list") setPath(state, path, splitList(raw));
      else if (kind === "number") setPath(state, path, raw === "" ? undefined : Number(raw));
      else setPath(state, path, raw === "" && optional ? undefined : raw);
    });
  }
  const id = `f-${path.replace(/\W/g, "-")}-${Math.random().toString(36).slice(2, 7)}`;
  input.id = id;
  return h(
    "div",
    { class: kind === "checkbox" ? "field field-check" : "field", "data-path": path },
    h("label", { for: id }, label),
    input,
    hint ? h("small", { class: "hint" }, hint) : null,
    h("small", { class: "field-error", "data-error-for": path }),
  );
}

/** Puts server validation issues next to their fields; returns the ones with no field. */
export function showFieldErrors(root, issues) {
  for (const el of root.querySelectorAll(".field-error")) el.textContent = "";
  for (const el of root.querySelectorAll(".field.invalid")) el.classList.remove("invalid");
  const unmatched = [];
  for (const issue of issues) {
    let target = null;
    for (const el of root.querySelectorAll("[data-error-for]")) {
      const path = el.getAttribute("data-error-for");
      if (issue.path === path || issue.path.startsWith(`${path}.`)) target = el;
    }
    if (target) {
      target.textContent = issue.message;
      target.closest(".field")?.classList.add("invalid");
    } else {
      unmatched.push(issue);
    }
  }
  return unmatched;
}
