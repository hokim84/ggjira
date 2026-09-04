import type { AgentRole } from "../agent/role.js";
import { normalizeKey } from "./description.js";

export interface Preset {
  id: string;
  displayName: string;
  role: AgentRole;
  description: string;
  instructions: string[];
}

/**
 * Static preset table (advanced_plan.md §13: MVP keeps this a fixed list
 * rather than a config-file-driven or inheritable system). Reviewer/Test
 * presets are deferred -- they would need new AgentRole values.
 */
export const PRESETS: readonly Preset[] = [
  {
    id: "pm",
    displayName: "PM",
    role: "pm",
    description: "Analyzes requirement issues and plans work for the implement agents.",
    instructions: [
      "Break requirements into small, independently completable tasks.",
      "Ask a Human Decision when there are multiple materially different approaches instead of guessing.",
    ],
  },
  {
    id: "general-programmer",
    displayName: "General Programmer",
    role: "implement",
    description: "General-purpose implementation across any part of the codebase.",
    instructions: [
      "Prefer the smallest change that satisfies the task's acceptance criteria.",
      "Follow the existing code style and structure rather than introducing new patterns.",
    ],
  },
  {
    id: "unity-programmer",
    displayName: "Unity Programmer",
    role: "implement",
    description: "Implementation work in a Unity/C# project.",
    instructions: [
      "Follow existing Unity project conventions (scene structure, prefabs, naming).",
      "Prefer editor-safe changes; avoid breaking serialized scene/prefab references.",
    ],
  },
  {
    id: "backend-programmer",
    displayName: "Backend Programmer",
    role: "implement",
    description: "Server-side and API implementation work.",
    instructions: [
      "Preserve existing API contracts unless the task explicitly asks to change them.",
      "Add or update tests for any new server-side behavior.",
    ],
  },
];

/** Matches by preset id or display name, case/space/hyphen-insensitive. */
export function findPreset(nameOrId: string | null | undefined): Preset | undefined {
  if (!nameOrId) return undefined;
  const needle = normalizeKey(nameOrId);
  return PRESETS.find(
    (p) => normalizeKey(p.id) === needle || normalizeKey(p.displayName) === needle,
  );
}
