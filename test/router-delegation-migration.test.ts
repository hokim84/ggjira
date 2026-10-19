import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceConfig } from "../src/router/config.js";
import { getApprovalHoldActor } from "../src/router/db/holds.js";
import { createJob, getOpenJobForIssue, transitionJobState } from "../src/router/db/jobs.js";
import {
  DELEGATION_BASELINE_ACTOR,
  type DelegationMigrationPlan,
  applyDelegationMigration,
  planDelegationMigration,
} from "../src/router/delegation-migration.js";
import {
  DONE_STATUS,
  MIGRATION_IN_PROGRESS_STATUS,
  MIGRATION_REVIEW_STATUS,
  MIGRATION_TRANSITIONS,
  TODO_STATUS,
  UNRELATED_LABEL,
  migrationWorkspace,
} from "./helpers/router-fixtures.js";
import { RouterHarness } from "./helpers/router-harness.js";

const REQUEST = "AI 계획 요청";
const PLAN_REVIEW = "계획 검토 대기";
const TARGET = { requestStatus: REQUEST, planReviewStatus: PLAN_REVIEW };
const TRANSITIONS = [
  ...MIGRATION_TRANSITIONS,
  ...[REQUEST, PLAN_REVIEW].map((status) => ({
    id: `t-${status}`,
    name: status,
    toStatusName: status,
  })),
];

/** The label workspace after the switch: same shared statuses, plus the delegation ones. */
const delegationOfLegacy: WorkspaceConfig = {
  ...migrationWorkspace,
  workflow: {
    mode: "delegation",
    requestStatus: REQUEST,
    planReviewStatus: PLAN_REVIEW,
    inProgressStatus: MIGRATION_IN_PROGRESS_STATUS,
    reviewStatus: MIGRATION_REVIEW_STATUS,
    doneStatus: DONE_STATUS,
  },
};

/**
 * ADR 0044 / runbook §34: moving an M4 `label` workspace onto status delegation. Nothing moves in
 * Jira, no label becomes a delegation, and nothing the workspace did before the switch counts as
 * a request or an approval afterwards (docs/M4_STATUS_DELEGATION_CHANGE_REVIEW.md §5 scenario 13).
 */
describe("delegation migration (ADR 0044)", () => {
  let router: RouterHarness;

  beforeEach(() => {
    router = new RouterHarness({ config: { workspaces: [{ ...migrationWorkspace }] } });
    router.jira.seedProjectStatuses("KAN", [
      TODO_STATUS,
      MIGRATION_IN_PROGRESS_STATUS,
      MIGRATION_REVIEW_STATUS,
      DONE_STATUS,
      REQUEST,
      PLAN_REVIEW,
    ]);
  });

  afterEach(async () => {
    await router.close();
  });

  async function seed(key: string, status: string, labels: string[] = []): Promise<void> {
    router.jira.seedIssue(
      {
        key,
        summary: `Work on ${key}`,
        statusName: TODO_STATUS,
        projectKey: "KAN",
        assigneeAccountId: "user-1",
        labels,
      },
      TRANSITIONS,
    );
    if (status !== TODO_STATUS) await router.jira.transitionIssueToStatus(key, status);
  }

  function workspace(): WorkspaceConfig {
    return router.config.workspaces[0] as WorkspaceConfig;
  }

  function plan(): Promise<DelegationMigrationPlan> {
    return planDelegationMigration({
      db: router.db,
      jira: router.jira,
      workspace: workspace(),
      target: TARGET,
      now: router.clock.now(),
    });
  }

  function apply(migrationPlan: DelegationMigrationPlan) {
    return applyDelegationMigration({
      db: router.db,
      jira: router.jira,
      workspace: workspace(),
      plan: migrationPlan,
      now: router.clock.now,
    });
  }

  it("lists what the switch means, refuses while a job may run, then starts nothing on its own (13)", async () => {
    await seed("KAN-1", TODO_STATUS, [UNRELATED_LABEL]); // waited for AI under the label rules
    await seed("KAN-2", MIGRATION_IN_PROGRESS_STATUS, [UNRELATED_LABEL]); // its job is still queued
    await seed("KAN-3", MIGRATION_REVIEW_STATUS, [UNRELATED_LABEL]);
    await seed("KAN-4", REQUEST); // moved to the new request status before the switch
    const queued = createJob(router.db, {
      id: "job-2",
      issueKey: "KAN-2",
      workspaceId: "ws1",
      repositoryId: "repo1",
      kind: "implementation",
      approvalId: "approval-2",
      now: router.clock.now(),
    });

    const migrationPlan = await plan();
    expect(
      Object.fromEntries(migrationPlan.entries.map((entry) => [entry.issueKey, entry.action])),
    ).toEqual({ "KAN-1": "manual", "KAN-2": "blocked", "KAN-3": "keep", "KAN-4": "keep" });
    await expect(apply(migrationPlan)).rejects.toThrow(/may still run/);

    transitionJobState(router.db, queued.id, "cancelled", router.clock.now());
    const results = await apply(migrationPlan);
    expect(results.find((result) => result.issueKey === "KAN-4")?.outcome).toBe("applied");
    const [entry] = await router.jira.getIssueChangelog("KAN-4");
    expect(getApprovalHoldActor(router.db, "KAN-4", entry?.id ?? "")).toBe(
      DELEGATION_BASELINE_ACTOR,
    );
    // Nothing in Jira moved, and no label was touched.
    expect(router.jira.transitions.map((move) => move.key)).toEqual(["KAN-2", "KAN-3", "KAN-4"]);

    router.config.workspaces.splice(0, 1, delegationOfLegacy);
    const report = await router.reconcile();
    expect(report.jobsCreated).toEqual([]);
    expect(report.held).toEqual([
      expect.objectContaining({
        issueKey: "KAN-4",
        reason: expect.stringContaining("requested before the switch to delegation"),
      }),
    ]);

    // From here on a human delegates by moving the issue; that is a new request.
    await router.jira.transitionIssueToStatus("KAN-1", REQUEST);
    await router.jira.transitionIssueToStatus("KAN-4", TODO_STATUS);
    await router.jira.transitionIssueToStatus("KAN-4", REQUEST);
    await router.reconcile();
    expect(getOpenJobForIssue(router.db, "KAN-1")?.kind).toBe("planning");
    expect(getOpenJobForIssue(router.db, "KAN-4")?.kind).toBe("planning");
    expect(getOpenJobForIssue(router.db, "KAN-3")).toBeUndefined();
  });

  it("rejects request or plan-review statuses the old rules already use", async () => {
    await expect(
      planDelegationMigration({
        db: router.db,
        jira: router.jira,
        workspace: workspace(),
        target: { requestStatus: TODO_STATUS, planReviewStatus: PLAN_REVIEW },
        now: router.clock.now(),
      }),
    ).rejects.toThrow(/already a status of workspace/);
  });

  it("is reachable through the admin API", async () => {
    await seed("KAN-1", TODO_STATUS, [UNRELATED_LABEL]);
    const response = await router.adminCall("POST", "/migrations/delegation/plan", {
      workspaceId: "ws1",
      target: TARGET,
    });
    expect(response.statusCode).toBe(200);
    const migrationPlan = response.json() as DelegationMigrationPlan;
    expect(migrationPlan.entries.map((entry) => entry.action)).toEqual(["manual"]);

    const applied = await router.adminCall("POST", "/migrations/delegation/apply", migrationPlan);
    expect(applied.statusCode).toBe(200);
  });
});
