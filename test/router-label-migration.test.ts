import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listAudit } from "../src/router/db/audit.js";
import { getOpenJobForIssue, transitionJobState } from "../src/router/db/jobs.js";
import type { LabelMigrationPlan } from "../src/router/label-migration.js";
import {
  IN_PROGRESS_STATUS,
  issueDescription,
  OPT_IN_LABEL,
  PLANNING_STATUS,
  REQUEST_STATUS,
  REVIEW_STATUS,
  testWorkspace,
} from "./helpers/router-fixtures.js";
import { RouterHarness } from "./helpers/router-harness.js";

const DECISION_STATUS = "결정 대기";
const TODO = "To Do";
const REVIEW = "Review";
const TARGET = { optInLabel: OPT_IN_LABEL, toDoStatus: TODO, reviewStatus: REVIEW };
const NO_CONTRACT = "Just a sentence.";

const legacyWorkspace = {
  ...testWorkspace,
  workflow: { ...testWorkspace.workflow, needsDecisionStatus: DECISION_STATUS },
};

/** ADR 0037 / runbook §27: moving a legacy workspace onto the label workflow (M4-07). */
describe("legacy → label migration", () => {
  let dir: string;
  let configPath: string;
  let router: RouterHarness;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ggjira-label-migration-"));
    configPath = path.join(dir, "router.config.json");
    router = new RouterHarness({ configPath, config: { workspaces: [legacyWorkspace] } });
    writeFileSync(configPath, JSON.stringify(router.config, null, 2));
  });

  afterEach(async () => {
    await router.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function seed(key: string, statusName: string, description = issueDescription()): void {
    router.jira.seedIssue(
      {
        key,
        summary: `Work on ${key}`,
        statusName,
        projectKey: "KAN",
        assigneeAccountId: "user-1",
        description,
      },
      [TODO, REVIEW].map((status) => ({ id: status, name: status, toStatusName: status })),
    );
  }

  async function plan(): Promise<LabelMigrationPlan> {
    const response = await router.adminCall("POST", "/migrations/label/plan", {
      workspaceId: "ws1",
      target: TARGET,
    });
    expect(response.statusCode).toBe(200);
    return response.json() as LabelMigrationPlan;
  }

  function approveAll(value: LabelMigrationPlan): LabelMigrationPlan {
    return { ...value, entries: value.entries.map((entry) => ({ ...entry, approved: true })) };
  }

  it("proposes an action per legacy status, changes nothing in Jira, and approves nothing", async () => {
    seed("KAN-1", REQUEST_STATUS);
    seed("KAN-2", PLANNING_STATUS, NO_CONTRACT);
    seed("KAN-3", PLANNING_STATUS);
    seed("KAN-4", REVIEW_STATUS);
    seed("KAN-5", DECISION_STATUS);
    seed("KAN-6", IN_PROGRESS_STATUS);
    seed("KAN-7", "Done");

    const proposal = await plan();

    expect(proposal.entries.map((entry) => [entry.issueKey, entry.action])).toEqual([
      ["KAN-1", "add-label-and-request"],
      ["KAN-2", "add-label-and-request"],
      ["KAN-3", "manual"], // a planning request label mode would implement instead
      ["KAN-4", "move-to-review"],
      ["KAN-5", "manual"],
      ["KAN-6", "manual"],
    ]);
    expect(proposal.entries.every((entry) => !entry.approved)).toBe(true);
    expect(router.jira.labelChanges).toEqual([]);
    expect(router.jira.transitions).toEqual([]);
  });

  it("marks an issue whose job may still run as blocked", async () => {
    seed("KAN-1", REQUEST_STATUS);
    await router.reconcile();
    expect(getOpenJobForIssue(router.db, "KAN-1")?.state).toBe("queued");

    const [entry] = (await plan()).entries;
    expect(entry).toMatchObject({ action: "blocked" });
  });

  it("applies only approved, actionable entries, confirms each in Jira, and audits them", async () => {
    seed("KAN-1", REQUEST_STATUS);
    seed("KAN-4", REVIEW_STATUS);
    seed("KAN-5", DECISION_STATUS);
    const proposal = await plan();
    proposal.entries = proposal.entries.map((entry) => ({
      ...entry,
      approved: entry.issueKey !== "KAN-4",
    }));

    const response = await router.adminCall("POST", "/migrations/label/apply", proposal);

    expect(response.statusCode).toBe(200);
    expect((response.json() as { results: unknown[] }).results).toEqual([
      expect.objectContaining({ issueKey: "KAN-1", outcome: "applied" }),
      expect.objectContaining({ issueKey: "KAN-4", outcome: "skipped", detail: "not approved" }),
      expect.objectContaining({ issueKey: "KAN-5", outcome: "skipped" }),
    ]);
    const migrated = await router.jira.getIssue("KAN-1");
    expect([migrated.statusName, migrated.labels]).toEqual([TODO, [OPT_IN_LABEL]]);
    expect((await router.jira.getIssue("KAN-4")).statusName).toBe(REVIEW_STATUS);
    expect(listAudit(router.db, "KAN-1").map((entry) => entry.action)).toEqual([
      "migration.label.applied",
    ]);
    // Still legacy: nothing was started by moving it.
    expect((await router.reconcile()).jobsCreated).toEqual([]);
  });

  it("skips an issue that changed since the plan and carries on after a failure", async () => {
    seed("KAN-1", REQUEST_STATUS);
    seed("KAN-2", REQUEST_STATUS);
    seed("KAN-3", REVIEW_STATUS);
    const proposal = approveAll(await plan());
    // KAN-1 was moved on by a human; KAN-2 cannot reach To Do in this workflow.
    router.jira.seedIssue({ ...(await router.jira.getIssue("KAN-1")), statusName: "Done" });
    router.jira.seedIssue({ ...(await router.jira.getIssue("KAN-2")) }, []);

    const response = await router.adminCall("POST", "/migrations/label/apply", proposal);

    const results = (response.json() as { results: Array<{ issueKey: string; outcome: string }> })
      .results;
    expect(results.map((result) => [result.issueKey, result.outcome])).toEqual([
      ["KAN-1", "skipped"],
      ["KAN-2", "failed"],
      ["KAN-3", "applied"],
    ]);
    expect((await router.jira.getIssue("KAN-3")).statusName).toBe(REVIEW);
  });

  it("refuses a target status the project does not have", async () => {
    router.jira.seedProjectStatuses("KAN", [REQUEST_STATUS, TODO, "검토 중"]);
    const response = await router.adminCall("POST", "/migrations/label/plan", {
      workspaceId: "ws1",
      target: TARGET,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ message: expect.stringContaining('"Review"') });
  });

  it("refuses a target To Do that is a legacy request status", async () => {
    const response = await router.adminCall("POST", "/migrations/label/plan", {
      workspaceId: "ws1",
      target: { ...TARGET, toDoStatus: REQUEST_STATUS },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "not_migratable" });
  });

  describe("switching the workspace to label mode", () => {
    const labelConfig = () => ({
      ...router.config,
      workspaces: [
        {
          ...legacyWorkspace,
          workflow: {
            mode: "label",
            optInLabel: OPT_IN_LABEL,
            requestStatus: TODO,
            inProgressStatus: IN_PROGRESS_STATUS,
            reviewStatus: REVIEW,
          },
        },
      ],
    });

    it("is refused while a job may still run under the legacy rules", async () => {
      seed("KAN-1", REQUEST_STATUS);
      await router.reconcile();

      const response = await router.adminCall("PUT", "/config", labelConfig());

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: "workspace_busy" });
      expect(router.admin.readConfig().pendingApply).toBe(false);
    });

    it("is allowed once the only open job has failed, and then picks up migrated issues", async () => {
      seed("KAN-1", REQUEST_STATUS);
      await router.reconcile();
      const job = getOpenJobForIssue(router.db, "KAN-1");
      for (const state of ["leased", "running", "failed"] as const) {
        transitionJobState(router.db, job?.id as string, state, router.clock.now());
      }
      seed("KAN-2", REQUEST_STATUS);
      const proposal = await plan();
      proposal.entries = proposal.entries.map((entry) => ({
        ...entry,
        approved: entry.issueKey === "KAN-2",
      }));
      await router.adminCall("POST", "/migrations/label/apply", proposal);

      const response = await router.adminCall("PUT", "/config", labelConfig());
      expect(response.statusCode).toBe(200);

      // The harness's scheduler reads its own config object; mirror the applied one.
      Object.assign(router.config, labelConfig());
      await router.reconcile();
      expect(getOpenJobForIssue(router.db, "KAN-2")?.state).toBe("queued");
    });
  });
});
