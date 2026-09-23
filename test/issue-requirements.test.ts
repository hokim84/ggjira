import { describe, expect, it } from "vitest";
import { canHandle, requiredBackends } from "../src/issue/capability.js";
import { readIssueRequirements } from "../src/issue/requirements.js";
import { buildTestIssue } from "./helpers/fixtures.js";

describe("issue requirements and capability matching", () => {
  it("matches canonical capabilities and derives backend requirements", () => {
    expect(canHandle(["Programming", "UI", "testing"], ["programming", "ui"])).toEqual({
      ok: true,
      missing: [],
    });
    expect(canHandle(["programming"], ["programming", "ui"]).missing).toEqual(["ui"]);
    expect(requiredBackends(["programming", "art-generation"])).toEqual([
      "filesystem",
      "git",
      "coding-runtime",
      "comfyui",
    ]);
  });

  it("reads human-editable execution requirements from a Jira description", () => {
    const issue = buildTestIssue({
      key: "KAN-1",
      description: [
        "h2. GGJIRA Plan",
        "Objective: Add drag and drop",
        "Suggested Execution Strategy: Preserve InventoryView",
        "",
        "h2. Acceptance Criteria",
        "* valid drop updates through the API",
        "",
        "h2. Required Capabilities",
        "* Programming",
        "* UI",
      ].join("\n"),
    });

    expect(readIssueRequirements(issue)).toMatchObject({
      objective: "Add drag and drop",
      acceptanceCriteria: ["valid drop updates through the API"],
      requiredCapabilities: ["programming", "ui"],
      suggestedExecutionStrategy: "Preserve InventoryView",
    });
  });
});
