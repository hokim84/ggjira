import type { ProviderUsage, ProviderUsageWindow } from "../contracts/api.js";

/**
 * How close a worker's provider is to its plan limits, for assignment (ADR 0029):
 * - `exhausted`: a window is at 100% and has not reset yet — the job would fail on the limit.
 * - `high`: a window is at or above the configured threshold and has not reset yet.
 * - `ok`: anything else, including no report at all.
 */
export type UsagePressure = "ok" | "high" | "exhausted";

const PRESSURE_RANK: Record<UsagePressure, number> = { ok: 0, high: 1, exhausted: 2 };

export function pressureRank(pressure: UsagePressure): number {
  return PRESSURE_RANK[pressure];
}

/** Without a reported reset time a window is trusted for its own length from when it was seen
 *  (5 hours when that is unknown too); after that the value says nothing about now. */
const DEFAULT_WINDOW_MINUTES = 300;

function windowStillApplies(window: ProviderUsageWindow, observedAt: string, now: number): boolean {
  if (window.resetsAt) return Date.parse(window.resetsAt) > now;
  const minutes = window.windowMinutes ?? DEFAULT_WINDOW_MINUTES;
  return Date.parse(observedAt) + minutes * 60_000 > now;
}

export function usagePressure(
  usage: ProviderUsage | undefined,
  now: string,
  highAtPercent: number,
): UsagePressure {
  if (!usage) return "ok";
  const nowMs = Date.parse(now);
  let pressure: UsagePressure = "ok";
  for (const window of usage.windows) {
    if (!windowStillApplies(window, usage.observedAt, nowMs)) continue;
    if (window.usedPercent >= 100) return "exhausted";
    if (window.usedPercent >= highAtPercent) pressure = "high";
  }
  return pressure;
}
