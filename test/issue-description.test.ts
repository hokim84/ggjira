import { describe, expect, it } from "vitest";
import { getItems, getScalar, parseSections, renderSections } from "../src/issue/description.js";

describe("parseSections / renderSections", () => {
  it("round-trips a rendered section back through the parser", () => {
    const rendered = renderSections([
      {
        heading: "Agent Profile",
        scalars: [
          ["Agent ID", "unity-implement-01"],
          ["Role", "implement"],
          ["Preset", null],
        ],
      },
      { heading: "Capabilities", items: ["Unity", "C#", "Git"] },
    ]);

    const sections = parseSections(rendered);

    expect(getScalar(sections, "Agent Profile", "Agent ID")).toBe("unity-implement-01");
    expect(getScalar(sections, "Agent Profile", "Role")).toBe("implement");
    expect(getScalar(sections, "Agent Profile", "Preset")).toBeNull();
    expect(getItems(sections, "Capabilities")).toEqual(["Unity", "C#", "Git"]);
  });

  it("strips bold decoration around a heading title", () => {
    const sections = parseSections("h3. *Role*\n* implement");
    expect(getItems(sections, "Role")).toEqual(["implement"]);
  });

  it("accepts any h1-h6 heading level", () => {
    const sections = parseSections("h6. Notes\n* one");
    expect(getItems(sections, "Notes")).toEqual(["one"]);
  });

  it("accepts a plain '- ' bullet the same as '* '", () => {
    const sections = parseSections("h2. Work Style\n- prefer small diffs\n* keep tests green");
    expect(getItems(sections, "Work Style")).toEqual(["prefer small diffs", "keep tests green"]);
  });

  it("treats blank lines and unknown sections as harmless", () => {
    const text = [
      "Some preamble text before any heading",
      "",
      "h2. Mystery Section",
      "* untracked item",
      "",
      "h2. Capabilities",
      "* Unity",
    ].join("\n");

    const sections = parseSections(text);

    expect(getItems(sections, "Capabilities")).toEqual(["Unity"]);
    // Callers only ever look up known section names, so the unknown one
    // being present in the map (rather than special-cased) is fine.
    expect(getItems(sections, "Mystery Section")).toEqual(["untracked item"]);
  });

  it("maps '(none)' and empty scalar values to null", () => {
    const sections = parseSections("h2. Agent Profile\nPreset: (none)\nDisplay Name: ");
    expect(getScalar(sections, "Agent Profile", "Preset")).toBeNull();
    expect(getScalar(sections, "Agent Profile", "Display Name")).toBeNull();
  });

  it("ignores content inside {code} and {noformat} fences", () => {
    const text = [
      "h2. Human Instructions",
      "* real instruction",
      "{code}",
      "* not a real instruction",
      "Role: fake",
      "{code}",
      "* another real instruction",
    ].join("\n");

    const sections = parseSections(text);

    expect(getItems(sections, "Human Instructions")).toEqual([
      "real instruction",
      "another real instruction",
    ]);
  });

  it("normalizes multi-word scalar labels for lookup regardless of spacing", () => {
    const sections = parseSections("h2. Workflow\nReady Status: To Do");
    expect(getScalar(sections, "Workflow", "readystatus")).toBe("To Do");
    expect(getScalar(sections, "Workflow", "Ready   Status")).toBe("To Do");
  });
});
