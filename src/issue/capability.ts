export const CAPABILITIES = [
  "planning",
  "task-decomposition",
  "dependency-analysis",
  "capability-analysis",
  "programming",
  "ui",
  "testing",
  "review",
  "art-generation",
  "art-review",
  "unity",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const KNOWN_CAPABILITIES = new Set<string>(CAPABILITIES);

const CAPABILITY_BACKENDS: Readonly<Record<string, readonly string[]>> = {
  programming: ["filesystem", "git", "coding-runtime"],
  ui: ["filesystem", "git", "coding-runtime"],
  testing: ["filesystem", "coding-runtime"],
  unity: ["unity"],
  "art-generation": ["comfyui"],
};

export function normalizeCapabilities(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))];
}

export function unknownCapabilities(values: readonly string[]): string[] {
  return normalizeCapabilities(values).filter((value) => !KNOWN_CAPABILITIES.has(value));
}

export interface CapabilityMatch {
  ok: boolean;
  missing: string[];
}

export function canHandle(
  available: readonly string[],
  required: readonly string[],
): CapabilityMatch {
  const offered = new Set(normalizeCapabilities(available));
  const missing = normalizeCapabilities(required).filter((capability) => !offered.has(capability));
  return { ok: missing.length === 0, missing };
}

export function requiredBackends(capabilities: readonly string[]): string[] {
  return [
    ...new Set(
      normalizeCapabilities(capabilities).flatMap(
        (capability) => CAPABILITY_BACKENDS[capability] ?? [],
      ),
    ),
  ];
}
