import type { ProviderUsageWindow } from "../contracts/api.js";
import type { UsageReading } from "./provider.js";

/** Epoch seconds → ISO string; anything else → undefined. */
function secondsToIso(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? new Date(value * 1000).toISOString()
    : undefined;
}

function roundPercent(value: number): number {
  return Math.round(value * 10) / 10;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Codex names windows only by length; give the two familiar ones Claude Code's names. */
function windowIdForMinutes(minutes: number | undefined, fallback: string): string {
  if (minutes === 300) return "five_hour";
  if (minutes === 10080) return "seven_day";
  return fallback;
}

/**
 * Claude Code's stream-json `rate_limit_event`:
 * `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","rateLimitType":"five_hour",
 *   "utilization":0.4,"unifiedWindows":{"five_hour":{"utilization":0.11,"resetsAt":1790674200},...}}}`
 * `utilization` is a 0–1 fraction. Returns undefined for any other line.
 */
export function parseClaudeRateLimitEvent(value: unknown): UsageReading | undefined {
  if (!isRecord(value) || value.type !== "rate_limit_event" || !isRecord(value.rate_limit_info)) {
    return undefined;
  }
  const info = value.rate_limit_info;
  const windows: ProviderUsageWindow[] = [];
  if (isRecord(info.unifiedWindows)) {
    for (const [id, window] of Object.entries(info.unifiedWindows)) {
      if (!isRecord(window) || typeof window.utilization !== "number") continue;
      const resetsAt = secondsToIso(window.resetsAt);
      windows.push({
        id,
        usedPercent: roundPercent(window.utilization * 100),
        ...(resetsAt ? { resetsAt } : {}),
      });
    }
  } else if (typeof info.rateLimitType === "string" && typeof info.utilization === "number") {
    const resetsAt = secondsToIso(info.resetsAt);
    windows.push({
      id: info.rateLimitType,
      usedPercent: roundPercent(info.utilization * 100),
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  return {
    ...(typeof info.status === "string" ? { status: info.status } : {}),
    windows,
  };
}

/**
 * The result of Codex app-server's `account/rateLimits/read`:
 * `{"rateLimits":{"primary":{"usedPercent":3,"windowDurationMins":300,"resetsAt":1790674690},
 *   "secondary":{...},"planType":"plus","rateLimitReachedType":null}}`. `usedPercent` is 0–100.
 */
export function parseCodexRateLimits(value: unknown): UsageReading | undefined {
  if (!isRecord(value) || !isRecord(value.rateLimits)) return undefined;
  const limits = value.rateLimits;
  const windows: ProviderUsageWindow[] = [];
  for (const name of ["primary", "secondary"] as const) {
    const window = limits[name];
    if (!isRecord(window) || typeof window.usedPercent !== "number") continue;
    const minutes =
      typeof window.windowDurationMins === "number" && window.windowDurationMins > 0
        ? Math.round(window.windowDurationMins)
        : undefined;
    const resetsAt = secondsToIso(window.resetsAt);
    windows.push({
      id: windowIdForMinutes(minutes, name),
      usedPercent: roundPercent(window.usedPercent),
      ...(resetsAt ? { resetsAt } : {}),
      ...(minutes ? { windowMinutes: minutes } : {}),
    });
  }
  const reached = typeof limits.rateLimitReachedType === "string";
  return {
    ...(reached ? { status: "rejected" } : {}),
    ...(typeof limits.planType === "string" ? { planType: limits.planType } : {}),
    windows,
  };
}
