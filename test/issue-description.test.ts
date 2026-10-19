import { describe, expect, it } from "vitest";
import { renderSections } from "../src/issue/description.js";

describe("renderSections", () => {
  it("renders headings, scalars and bullets as Jira wiki markup", () => {
    expect(
      renderSections([
        {
          heading: "GGJIRA Plan",
          scalars: [
            ["Objective", "Ship it"],
            ["Suggested Execution Strategy", null],
          ],
        },
        { heading: "Acceptance Criteria", items: ["It works", "It is tested"] },
        { heading: "Notes", level: 3, items: [] },
      ]),
    ).toBe(
      [
        "h2. GGJIRA Plan",
        "Objective: Ship it",
        "Suggested Execution Strategy: (none)",
        "",
        "h2. Acceptance Criteria",
        "* It works",
        "* It is tested",
        "",
        "h3. Notes",
      ].join("\n"),
    );
  });
});
