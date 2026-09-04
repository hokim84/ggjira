import { describe, expect, it } from "vitest";
import { PRESETS, findPreset } from "../src/profile/presets.js";

describe("findPreset", () => {
  it("matches by exact id", () => {
    expect(findPreset("unity-programmer")?.displayName).toBe("Unity Programmer");
  });

  it("matches by display name, case/space/hyphen-insensitive", () => {
    expect(findPreset("Unity Programmer")?.id).toBe("unity-programmer");
    expect(findPreset("unityprogrammer")?.id).toBe("unity-programmer");
    expect(findPreset("UNITY-PROGRAMMER")?.id).toBe("unity-programmer");
  });

  it("returns undefined for an unknown name", () => {
    expect(findPreset("nonexistent-preset")).toBeUndefined();
  });

  it("returns undefined for null/undefined", () => {
    expect(findPreset(null)).toBeUndefined();
    expect(findPreset(undefined)).toBeUndefined();
  });

  it("every preset has a role of pm or implement", () => {
    for (const preset of PRESETS) {
      expect(["pm", "implement"]).toContain(preset.role);
    }
  });
});
