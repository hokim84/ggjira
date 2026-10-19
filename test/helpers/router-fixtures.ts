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

/** A `label`-mode workspace (ADR 0037) on the ordinary four-status workflow. */
export const TODO_STATUS = "To Do";
export const LABEL_IN_PROGRESS_STATUS = "In Progress";
export const LABEL_REVIEW_STATUS = "Review";
export const DONE_STATUS = "Done";
export const OPT_IN_LABEL = "ai-enabled";

export const labelWorkspace: WorkspaceConfig = {
  id: "ws1",
  repositoryId: "repo1",
  projectKeys: ["KAN"],
  workflow: {
    mode: "label",
    optInLabel: OPT_IN_LABEL,
    requestStatus: TODO_STATUS,
    inProgressStatus: LABEL_IN_PROGRESS_STATUS,
    reviewStatus: LABEL_REVIEW_STATUS,
    doneStatus: DONE_STATUS,
  },
};

/** Every move between the four statuses, for seeding issues in a `label`-mode workspace. */
export const LABEL_TRANSITIONS = [
  TODO_STATUS,
  LABEL_IN_PROGRESS_STATUS,
  LABEL_REVIEW_STATUS,
  DONE_STATUS,
].map((status) => ({ id: `t-${status}`, name: `To ${status}`, toStatusName: status }));

/** A `delegation`-mode workspace (ADR 0044): delegated by status, always planned first. */
export const DELEGATION_TODO_STATUS = "할 일";
export const DELEGATION_REQUEST_STATUS = "AI 계획 요청";
export const PLAN_REVIEW_STATUS = "계획 검토 대기";
export const SHARED_IN_PROGRESS_STATUS = "작업 중";
export const RESULT_REVIEW_STATUS = "결과 검토";
export const DELEGATION_DONE_STATUS = "완료";

export const delegationWorkspace: WorkspaceConfig = {
  id: "ws1",
  repositoryId: "repo1",
  projectKeys: ["KAN"],
  workflow: {
    mode: "delegation",
    requestStatus: DELEGATION_REQUEST_STATUS,
    planReviewStatus: PLAN_REVIEW_STATUS,
    inProgressStatus: SHARED_IN_PROGRESS_STATUS,
    reviewStatus: RESULT_REVIEW_STATUS,
    doneStatus: DELEGATION_DONE_STATUS,
  },
};

/** Every move between the delegation workflow's statuses. */
export const DELEGATION_TRANSITIONS = [
  DELEGATION_TODO_STATUS,
  DELEGATION_REQUEST_STATUS,
  PLAN_REVIEW_STATUS,
  SHARED_IN_PROGRESS_STATUS,
  RESULT_REVIEW_STATUS,
  DELEGATION_DONE_STATUS,
].map((status) => ({ id: `t-${status}`, name: `To ${status}`, toStatusName: status }));

/** A description whose scope contract is complete (ADR 0034) unless `acceptance`/`verification`
 *  is passed as `[]`, so implementation requests built from it dispatch by default. */
export function issueDescription(
  opts: {
    dependencies?: string[];
    capabilities?: string[];
    acceptance?: string[];
    verification?: string[];
  } = {},
): string {
  return renderSections([
    { heading: "Acceptance Criteria", items: opts.acceptance ?? ["The change works"] },
    { heading: "Verification", items: opts.verification ?? ["npm run test"] },
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
