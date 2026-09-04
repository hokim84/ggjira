import { describe, expect, it } from "vitest";
import { composeSystemPrompt } from "../src/agent/prompt.js";
import type { Preset } from "../src/profile/presets.js";
import type { AgentProfile } from "../src/profile/types.js";

const preset: Preset = {
  id: "unity-programmer",
  displayName: "Unity Programmer",
  role: "implement",
  description: "Unity/C# work",
  instructions: ["Follow existing Unity project conventions."],
};

const profile: AgentProfile = {
  issueKey: "KAN-11",
  agentId: "unity-implement-01",
  displayName: "Unity Implement 01",
  role: "implement",
  preset: "unity-programmer",
  capabilities: ["Unity", "C#"],
  workStyle: ["prefer small diffs"],
  humanInstructions: ["favor maintainability over performance"],
  enabled: true,
  registration: null,
};

describe("composeSystemPrompt", () => {
  it("returns exactly corePolicy when no other layers are given (legacy mode)", () => {
    expect(composeSystemPrompt({ corePolicy: "CORE" })).toBe("CORE");
  });

  it("omits a layer entirely when its content is empty", () => {
    const result = composeSystemPrompt({
      corePolicy: "CORE",
      projectPolicy: [],
      preset: null,
      profile: { ...profile, capabilities: [], workStyle: [], humanInstructions: [] },
    });

    expect(result).not.toContain("Project Policy");
    expect(result).not.toContain("Role Preset");
    expect(result).not.toContain("Human Instructions");
    expect(result).toContain("## Agent Profile: unity-implement-01");
  });

  it("renders layers in order: core -> project policy -> preset -> profile -> human instructions", () => {
    const result = composeSystemPrompt({
      corePolicy: "CORE",
      projectPolicy: ["keep PRs small"],
      preset,
      profile,
    });

    const coreIdx = result.indexOf("CORE");
    const policyIdx = result.indexOf("## Project Policy");
    const presetIdx = result.indexOf("## Role Preset: Unity Programmer");
    const profileIdx = result.indexOf("## Agent Profile: unity-implement-01");
    const humanIdx = result.indexOf("## Human Instructions");

    expect(coreIdx).toBeLessThan(policyIdx);
    expect(policyIdx).toBeLessThan(presetIdx);
    expect(presetIdx).toBeLessThan(profileIdx);
    expect(profileIdx).toBeLessThan(humanIdx);
  });

  it("includes capabilities, work style, and human instructions content", () => {
    const result = composeSystemPrompt({ corePolicy: "CORE", profile });

    expect(result).toContain("Capabilities: Unity, C#");
    expect(result).toContain("- prefer small diffs");
    expect(result).toContain("- favor maintainability over performance");
  });
});
