import type { RouterConfig, WorkerPolicyConfig, WorkspaceConfig } from "../../src/router/config.js";

/** Shared v5 Router test fixtures (scheduler, worker API, leases, runner end-to-end). */

/** The workspace workflow (ADR 0044, ADR 0047): delegated by status, always planned first. */
export const TODO_STATUS = "할 일";
export const REQUEST_STATUS = "AI 계획 요청";
export const PLAN_REVIEW_STATUS = "계획 검토 대기";
export const IN_PROGRESS_STATUS = "작업 중";
export const REVIEW_STATUS = "결과 검토";
export const DONE_STATUS = "완료";

export const testWorkspace: WorkspaceConfig = {
  id: "ws1",
  repositoryId: "repo1",
  projectKeys: ["KAN"],
  workflow: {
    requestStatus: REQUEST_STATUS,
    planReviewStatus: PLAN_REVIEW_STATUS,
    inProgressStatus: IN_PROGRESS_STATUS,
    reviewStatus: REVIEW_STATUS,
    doneStatus: DONE_STATUS,
  },
};

/** Every move between the workflow's statuses, for seeding issues a test moves around. */
export const WORKFLOW_TRANSITIONS = [
  TODO_STATUS,
  REQUEST_STATUS,
  PLAN_REVIEW_STATUS,
  IN_PROGRESS_STATUS,
  REVIEW_STATUS,
  DONE_STATUS,
].map((status) => ({ id: `t-${status}`, name: `To ${status}`, toStatusName: status }));

/** An issue description as a person might write it. Router never parses it (ADR 0047); it only
 *  goes into the input hash and to the worker as text. */
export function issueDescription(text = "Make the change described in the summary."): string {
  return text;
}

/** A plan that keeps the work in the issue itself, with its contract filled in (ADR 0047): what
 *  `RouterHarness.seedApprovedIssue` approves unless a test passes its own. */
export function singlePlan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    needsDecision: false,
    summary: "One outcome; contract filled in",
    acceptanceCriteria: ["The change works"],
    verification: ["npm run test"],
    requiredCapabilities: ["programming"],
    tasks: [],
    keepTaskKeys: [],
    ...overrides,
  };
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
    jev: { enabled: true, model: "jev-latest", timeoutMs: 5_000 },
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
