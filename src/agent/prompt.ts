import type { Preset } from "../profile/presets.js";
import type { AgentProfile } from "../profile/types.js";

export interface PromptLayers {
  /** The role's own base instructions (buildPmSystemPrompt() / buildImplementSystemPrompt()). */
  corePolicy: string;
  projectPolicy?: string[];
  preset?: Preset | null;
  profile?: AgentProfile | null;
}

/**
 * Layers a Workspace Configuration's Project Policy, a Role Preset, and an
 * Agent Profile's capabilities/work style/human instructions on top of the
 * role's own core system prompt (advanced_plan.md §5). Any layer that is
 * absent or empty is omitted rather than rendered blank, so a legacy
 * (non-profile-mode) config produces exactly `corePolicy` unchanged.
 */
export function composeSystemPrompt(layers: PromptLayers): string {
  const parts = [layers.corePolicy];

  if (layers.projectPolicy?.length) {
    parts.push("", "## Project Policy", ...layers.projectPolicy.map((item) => `- ${item}`));
  }

  if (layers.preset) {
    parts.push("", `## Role Preset: ${layers.preset.displayName}`, ...layers.preset.instructions);
  }

  if (layers.profile) {
    const { profile } = layers;
    const profileLines = [`## Agent Profile: ${profile.agentId} (${profile.displayName})`];
    if (profile.capabilities.length) {
      profileLines.push(`Capabilities: ${profile.capabilities.join(", ")}`);
    }
    if (profile.workStyle.length) {
      profileLines.push("Work style:", ...profile.workStyle.map((item) => `- ${item}`));
    }
    parts.push("", ...profileLines);

    if (profile.humanInstructions.length) {
      parts.push(
        "",
        "## Human Instructions",
        ...profile.humanInstructions.map((item) => `- ${item}`),
      );
    }
  }

  return parts.join("\n");
}
