import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeJiraGateway } from "../src/jira/fake.js";
import { openRouterDb } from "../src/router/db/connection.js";
import { getOpenJobForIssue } from "../src/router/db/jobs.js";
import { listOpenReadinessHolds } from "../src/router/db/readiness-holds.js";
import { RuleDecisionProvider } from "../src/router/decision.js";
import { processReadinessNotices } from "../src/router/report-processor.js";
import { reconcileCandidates, type SchedulerDeps } from "../src/router/scheduler.js";
import {
  buildRouterConfig,
  issueDescription,
  makeClock,
  makeIdGenerator,
  PLANNING_STATUS,
  REQUEST_STATUS,
} from "./helpers/router-fixtures.js";

/** ADR 0034 / task doc §5 scenario 2: an implementation request without acceptance criteria or
 *  verification never starts, gets exactly one notice, and re-polling does not repeat it. */
describe("readiness holds", () => {
  let dataDir: string;
  let db: Database.Database;
  let jira: FakeJiraGateway;
  let deps: SchedulerDeps;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "ggjira-router-readiness-test-"));
    db = openRouterDb(path.join(dataDir, "router.sqlite3"));
    jira = new FakeJiraGateway();
    const config = buildRouterConfig();
    deps = {
      db,
      jira,
      config,
      decisionProvider: new RuleDecisionProvider(),
      now: makeClock(),
      genId: makeIdGenerator("id"),
    };
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function seed(statusName: string, description: string): void {
    jira.seedIssue({
      key: "KAN-1",
      statusName,
      projectKey: "KAN",
      assigneeAccountId: "user-1",
      description,
    });
  }

  async function holdNotices(): Promise<string[]> {
    return (await jira.getComments("KAN-1"))
      .map((comment) => comment.body)
      .filter((body) => body.includes("[GGJIRA:HOLD:"));
  }

  it("creates no job, records one hold and posts one notice across repeated polls", async () => {
    seed(REQUEST_STATUS, issueDescription({ acceptance: [], verification: [] }));

    const first = await reconcileCandidates(deps, []);
    expect(first.jobsCreated).toEqual([]);
    expect(first.held).toEqual([
      expect.objectContaining({ issueKey: "KAN-1", reason: expect.stringContaining("not ready") }),
    ]);
    expect(getOpenJobForIssue(db, "KAN-1")).toBeUndefined();

    await processReadinessNotices({ db, jira, now: deps.now });
    await reconcileCandidates(deps, []);
    await reconcileCandidates(deps, []);
    await processReadinessNotices({ db, jira, now: deps.now });

    const holds = listOpenReadinessHolds(db);
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({
      missing: ["acceptance", "verification"],
      seenCount: 3,
      noticeStatus: "posted",
    });
    const notices = await holdNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("Acceptance Criteria and no Verification");
    expect(getOpenJobForIssue(db, "KAN-1")).toBeUndefined();
  });

  it("does not post twice when the marker comment already exists (uncertain write, restart)", async () => {
    seed(REQUEST_STATUS, issueDescription({ verification: [] }));
    await reconcileCandidates(deps, []);
    const [hold] = listOpenReadinessHolds(db);
    jira.seedComment("KAN-1", { body: `[GGJIRA:HOLD:${hold?.id}]\nposted before a crash` });

    const report = await processReadinessNotices({ db, jira, now: deps.now });

    expect(report.posted).toEqual([hold?.id]);
    expect(await holdNotices()).toHaveLength(1);
  });

  it("keeps a notice pending when Jira fails the write, and posts it on the next pass", async () => {
    seed(REQUEST_STATUS, issueDescription({ verification: [] }));
    await reconcileCandidates(deps, []);
    jira.failNextComment("KAN-1");

    const failed = await processReadinessNotices({ db, jira, now: deps.now });
    expect(failed.posted).toEqual([]);
    expect(failed.deferred).toHaveLength(1);
    expect(listOpenReadinessHolds(db)[0]).toMatchObject({
      noticeStatus: "pending",
      noticeTries: 1,
    });

    const retried = await processReadinessNotices({ db, jira, now: deps.now });
    expect(retried.posted).toHaveLength(1);
    expect(await holdNotices()).toHaveLength(1);
  });

  it("dispatches once the human adds the missing sections, and resolves the hold", async () => {
    seed(REQUEST_STATUS, issueDescription({ verification: [] }));
    await reconcileCandidates(deps, []);
    await processReadinessNotices({ db, jira, now: deps.now });

    await jira.updateIssueDescription("KAN-1", issueDescription());
    const report = await reconcileCandidates(deps, []);

    expect(report.jobsCreated).toHaveLength(1);
    expect(getOpenJobForIssue(db, "KAN-1")?.kind).toBe("implementation");
    expect(listOpenReadinessHolds(db)).toEqual([]);
  });

  it("posts a new notice when an edit leaves a different gap", async () => {
    seed(REQUEST_STATUS, issueDescription({ acceptance: [], verification: [] }));
    await reconcileCandidates(deps, []);
    await processReadinessNotices({ db, jira, now: deps.now });

    await jira.updateIssueDescription("KAN-1", issueDescription({ verification: [] }));
    await reconcileCandidates(deps, []);
    await processReadinessNotices({ db, jira, now: deps.now });

    const holds = listOpenReadinessHolds(db);
    expect(holds).toHaveLength(1);
    expect(holds[0]?.missing).toEqual(["verification"]);
    expect(await holdNotices()).toHaveLength(2);
  });

  it("dispatches a planning request whose contract is incomplete", async () => {
    seed(PLANNING_STATUS, issueDescription({ acceptance: [], verification: [] }));

    const report = await reconcileCandidates(deps, []);

    expect(report.jobsCreated).toHaveLength(1);
    expect(getOpenJobForIssue(db, "KAN-1")?.kind).toBe("planning");
    expect(listOpenReadinessHolds(db)).toEqual([]);
  });

  it("resolves the hold, without a notice, once the issue leaves the request statuses", async () => {
    seed(REQUEST_STATUS, issueDescription({ verification: [] }));
    await reconcileCandidates(deps, []);
    seed("To Do", issueDescription({ verification: [] }));

    await reconcileCandidates(deps, []);
    await processReadinessNotices({ db, jira, now: deps.now });

    expect(listOpenReadinessHolds(db)).toEqual([]);
    expect(await holdNotices()).toEqual([]);
  });
});
