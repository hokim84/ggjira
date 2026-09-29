import { renderSections } from "../../src/issue/description.js";
import type { RouterConfig, WorkerPolicyConfig, WorkspaceConfig } from "../../src/router/config.js";

/** Shared v5 Router test fixtures (scheduler, worker API, leases, runner end-to-end). */

export const REQUEST_STATUS = "AI 작업 요청";
export const PLANNING_STATUS = "AI 계획 요청";
export const IN_PROGRESS_STATUS = "작업 중";
export const REVIEW_STATUS = "AI 작업 완료";

export const testWorkspace: WorkspaceConfig = {
  id: "ws1",
  repositoryId: "repo1",
  projectKeys: ["KAN"],
  workflow: {
    requestStatus: REQUEST_STATUS,
    planningStatus: PLANNING_STATUS,
    inProgressStatus: IN_PROGRESS_STATUS,
    reviewStatus: REVIEW_STATUS,
  },
};

export function issueDescription(
  opts: { dependencies?: string[]; capabilities?: string[] } = {},
): string {
  return renderSections([
    { heading: "Dependencies", items: opts.dependencies ?? [] },
    { heading: "Required Capabilities", items: opts.capabilities ?? ["programming"] },
  ]);
}

export function buildRouterConfig(overrides: Partial<RouterConfig> = {}): RouterConfig {
  return {
    configVersion: 5,
    jira: { baseUrl: "https://example.atlassian.net" },
    repositories: [{ id: "repo1" }],
    workspaces: [testWorkspace],
    workers: [],
    db: { path: "data/router.sqlite3" },
    http: { host: "127.0.0.1", port: 8787 },
    reconciliation: {
      startupFullSyncOnBoot: true,
      backgroundIntervalMs: 60_000,
      activeJobPollIntervalMs: 5_000,
    },
    execution: { timeoutMs: 60_000 },
    planning: { subtaskIssueType: "Sub-task", maxTasksPerPlan: 10 },
    reporting: { failureLabel: "ggjira-failed" },
    github: { pollIntervalMs: 300_000 },
    scheduling: { usage: { deprioritizeAtPercent: 90, skipExhausted: true } },
    ...overrides,
  };
}

export function workerPolicy(overrides: Partial<WorkerPolicyConfig> = {}): WorkerPolicyConfig {
  return {
    workerId: "worker-1",
    allowedCapabilities: ["programming"],
    allowedRepositoryIds: ["repo1"],
    enabled: true,
    providerId: "default",
    ...overrides,
  };
}

/** A clock that advances by `stepMs` on every read. */
export function makeClock(
  startMs = Date.parse("2026-01-01T00:00:00.000Z"),
  stepMs = 1000,
): () => string {
  let ms = startMs;
  return () => {
    const value = new Date(ms).toISOString();
    ms += stepMs;
    return value;
  };
}

/** A clock that only moves when the test says so. */
export class ManualClock {
  constructor(private ms = Date.parse("2026-01-01T00:00:00.000Z")) {}

  readonly now = (): string => new Date(this.ms).toISOString();

  advance(ms: number): void {
    this.ms += ms;
  }
}

export function makeIdGenerator(prefix: string): () => string {
  let counter = 0;
  return () => `${prefix}-${counter++}`;
}
