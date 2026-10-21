import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLAN_TASK_PROPERTY_KEY } from "../src/pm/metadata.js";
import type { JobEnvelope } from "../src/contracts/envelope.js";
import { PROTOCOL_VERSION } from "../src/contracts/protocol.js";
import { getOpenJobForIssue } from "../src/router/db/jobs.js";
import { handlePullRequestClosed } from "../src/router/github.js";
import { readIssueDelegation } from "../src/router/issue-delegation.js";
import { latestPlanningRequest } from "../src/router/planning-requests.js";
import { processReportJournal } from "../src/router/report-processor.js";
import {
  DONE_STATUS,
  IN_PROGRESS_STATUS,
  REQUEST_STATUS,
  REVIEW_STATUS,
  WORKFLOW_TRANSITIONS,
  singlePlan,
  testWorkspace,
} from "./helpers/router-fixtures.js";
import { type RegisteredWorker, RouterHarness } from "./helpers/router-harness.js";

const sha = (n: number) => n.toString(16).padStart(40, "0");
const task = {
  taskId: "feature",
  title: "Deliver the feature",
  description: "Implement the complete outcome",
  acceptance: ["Works"],
  verification: ["Run integration tests"],
};
const plan = () => singlePlan({ tasks: [task] });
const finding = (category = "new_debt", id = "duplication") => ({
  id,
  category,
  summary: id,
  evidence: ["src/feature.ts:10 repeated handling"],
  impact: "Future edits can diverge",
  remediation: task,
});

describe("child approvals and parent completion quality gate", () => {
  let router: RouterHarness;
  let worker: RegisteredWorker;
  let serial: number;
  beforeEach(async () => {
    router = new RouterHarness();
    serial = 0;
    router.jira.setCreatedIssueTransitions(WORKFLOW_TRANSITIONS);
    worker = await router.connectWorker("worker-1");
    router.jira.seedIssue(
      {
        key: "KAN-1",
        summary: "Feature",
        description: "Deliver feature",
        projectKey: "KAN",
        statusName: REQUEST_STATUS,
        assigneeAccountId: "user-1",
      },
      WORKFLOW_TRANSITIONS,
    );
  });
  afterEach(async () => {
    await router.close();
  });
  async function process() {
    const report = await processReportJournal({
      db: router.db,
      jira: router.jira,
      now: router.clock.now,
    });
    expect(report.blocked).toEqual([]);
  }
  async function start() {
    await router.reconcile();
    const response = await router.next(worker, `new-${++serial}`);
    expect(response.statusCode).toBe(200);
    const envelope = response.json() as JobEnvelope;
    expect(
      (
        await router.jobCall(worker, envelope.jobId, "start", {
          attemptId: envelope.attemptId,
          leaseToken: envelope.leaseToken,
        })
      ).json(),
    ).toMatchObject({ granted: true });
    return envelope;
  }
  async function finish(envelope: JobEnvelope, data: object) {
    const result = {
      protocolVersion: PROTOCOL_VERSION,
      jobId: envelope.jobId,
      attemptId: envelope.attemptId,
      resultId: `result-${envelope.attemptId}`,
      status: "succeeded",
      summary: "Done",
      ...data,
    };
    const response = await router.post(
      `/api/v1/jobs/${envelope.jobId}/result`,
      result,
      worker.token,
    );
    expect(response.statusCode).toBe(200);
    await process();
    return result;
  }
  async function publish(value = plan()) {
    const pm = await start();
    expect(pm.planningContext?.lifecycleVersion).toBe(2);
    await finish(pm, { status: "planned", plan: value });
    await router.reconcile();
    return pm;
  }
  it("records child approval baselines even before Jira search indexes the created child", async () => {
    const search = router.jira.searchIssues.bind(router.jira);
    const delayed = vi
      .spyOn(router.jira, "searchIssues")
      .mockImplementation(async (jql, options) =>
        jql.includes("parent =") ? [] : search(jql, options),
      );
    await publish();
    expect(
      router.db
        .prepare("SELECT task_id,entry_id FROM child_approval_baselines WHERE parent_key='KAN-1'")
        .all(),
    ).toEqual([{ task_id: "feature", entry_id: "created:KAN-1001" }]);
    delayed.mockRestore();
    await router.jira.transitionIssueToStatus("KAN-1001", IN_PROGRESS_STATUS);
    expect((await start()).kind).toBe("implementation");
  });
  async function completeChild(key = "KAN-1001", number = 1) {
    await router.jira.transitionIssueToStatus(key, IN_PROGRESS_STATUS);
    const child = await start();
    expect(child.kind).toBe("implementation");
    expect(child.integration).toMatchObject({ baseBranch: "main" });
    await finish(child, {
      pullRequest: { repo: "org/repo", number, url: `https://github.com/org/repo/pull/${number}` },
      git: {
        repository: "git",
        committed: true,
        baseBranch: "main",
        baseSha: sha(1),
        headSha: sha(number + 10),
      },
      implementation: {
        outcome: "completed",
        summary: "Done",
        verification: [{ acceptance: "Works", status: "pass", evidence: "tests pass" }],
      },
    });
    return child;
  }
  async function merge(number = 1) {
    handlePullRequestClosed(
      router.db,
      router.config,
      {
        repo: "org/repo",
        number,
        merged: true,
        by: "reviewer",
        headSha: sha(number + 10),
        mergeSha: sha(number + 20),
        targetBranch: "main",
      },
      router.clock.now(),
    );
    await process();
  }
  async function evaluate(findings: object[] = [], verificationPassed = true) {
    const job = await start();
    expect(job.kind).toBe("quality_review");
    await finish(job, {
      quality: {
        targetSha: sha(21),
        baselineSha: sha(1),
        summary: "Integrated review",
        verificationPassed,
        verificationEvidence: ["npm test passed"],
        findings,
      },
    });
    return job;
  }
  async function answer(body: string, authorAccountId = "user-1") {
    router.clock.advance(1000);
    router.jira.seedComment("KAN-1", { body, authorAccountId, created: router.clock.now() });
    await router.reconcile();
    await process();
  }
  async function ready() {
    await publish();
    await completeChild();
    await merge();
  }

  it("publishes waiting children, never starts the parent, and requires an individual child move", async () => {
    await publish();
    expect(latestPlanningRequest(router.db, "KAN-1")?.lifecycle_version).toBe(2);
    expect(getOpenJobForIssue(router.db, "KAN-1001")).toBeUndefined();
    expect((await router.jira.getIssue("KAN-1")).statusName).toBe(REQUEST_STATUS);
    expect((await router.reconcile()).jobsCreated).toEqual([]);
    await completeChild();
    expect((await router.jira.getIssue("KAN-1")).statusName).toBe(REQUEST_STATUS);
  });
  it("rejects a parent-only plan", async () => {
    await publish(singlePlan());
    expect(router.jira.createdIssues).toHaveLength(0);
    expect(router.db.prepare("SELECT outcome FROM plan_reviews").get()).toEqual({
      outcome: "not_applied",
    });
  });
  it("requires real integration, then evaluates once and moves only to result review", async () => {
    await publish();
    await completeChild();
    await router.jira.transitionIssueToStatus("KAN-1001", DONE_STATUS);
    expect((await router.reconcile()).jobsCreated).toEqual([]);
    await merge();
    const evaluation = await evaluate();
    const verification = await start();
    expect(verification.qualityContext).toMatchObject({
      verificationOnly: true,
      expectedSha: sha(21),
    });
    await finish(verification, {
      quality: {
        targetSha: sha(21),
        baselineSha: sha(1),
        summary: "Still current",
        verificationPassed: true,
        verificationEvidence: ["rechecked"],
        findings: [],
      },
    });
    await router.reconcile();
    await process();
    await router.reconcile();
    expect((await router.jira.getIssue("KAN-1")).statusName).toBe(REVIEW_STATUS);
    expect((await router.reconcile()).jobsCreated).toEqual([]);
    expect(router.db.prepare("SELECT COUNT(*) AS n FROM quality_cycles").get()).toEqual({ n: 2 });
    expect(evaluation.qualityContext?.resultIds).toHaveLength(1);
  });
  it("asks one candidate at a time and requires a reason for deferral", async () => {
    await ready();
    await evaluate([finding(), finding("existing_debt", "logging")]);
    await router.reconcile();
    await process();
    expect(
      router.jira.comments.filter((comment) => comment.body.includes("질문 1/2")),
    ).toHaveLength(1);
    expect(router.jira.comments.some((comment) => comment.body.includes("질문 2/2"))).toBe(false);
    await answer("2", "other");
    expect(router.db.prepare("SELECT * FROM quality_decisions").all()).toHaveLength(0);
    await answer("2");
    expect(router.jira.createdIssues).toHaveLength(1);
    await answer("이번 릴리스 영향이 없어 후속 처리");
    expect(router.jira.createdIssues).toHaveLength(2);
    expect(router.jira.createdIssues[1]?.parentKey).toBeUndefined();
    await router.reconcile();
    await process();
    expect(router.jira.comments.some((comment) => comment.body.includes("질문 2/2"))).toBe(true);
    expect((await router.jira.getIssue("KAN-1")).statusName).toBe(REQUEST_STATUS);
    await router.restart();
    await router.reconcile();
    await process();
    expect(router.jira.createdIssues).toHaveLength(2);
  });
  it("creates an adopted improvement once and requires a new manual start", async () => {
    await ready();
    await evaluate([finding("defect")], false);
    await router.reconcile();
    await process();
    await answer("1");
    await router.reconcile();
    await process();
    expect(router.jira.createdIssues).toHaveLength(2);
    expect(getOpenJobForIssue(router.db, "KAN-1002")).toBeUndefined();
    expect((await router.jira.getIssue("KAN-1")).statusName).toBe(REQUEST_STATUS);
    await completeChild("KAN-1002", 2);
    await merge(2);
    const recheck = await evaluate();
    expect(recheck.qualityContext?.previousFindings.length).toBeGreaterThan(0);
    expect(recheck.qualityContext?.integration.mergeCommits).toHaveLength(2);
  });
  it("cannot bypass a defect through deferral, and accepts a subsequent valid answer", async () => {
    await ready();
    await evaluate([finding("defect")]);
    await router.reconcile();
    await process();
    await answer("2 나중에 처리");
    expect(router.jira.createdIssues).toHaveLength(1);
    await answer("1");
    expect(router.jira.createdIssues).toHaveLength(2);
  });
  it("holds failed verification without treating a successful agent call as a pass", async () => {
    await ready();
    await evaluate([], false);
    await router.reconcile();
    await process();
    expect((await router.jira.getIssue("KAN-1")).statusName).toBe(REQUEST_STATUS);
    expect((await router.reconcile()).jobsCreated).toEqual([]);
  });
  it("requires a fresh assignee retry after an evaluation failure", async () => {
    await ready();
    const evaluation = await start();
    await finish(evaluation, { status: "failed", failureReason: "Git unavailable" });
    expect((await router.reconcile()).jobsCreated).toEqual([]);
    await answer("재시도", "other");
    expect(router.db.prepare("SELECT * FROM quality_cycles").all()).toHaveLength(1);
    await answer("재시도");
    expect(router.db.prepare("SELECT * FROM quality_cycles").all()).toHaveLength(2);
  });
  it("exposes child progress while the parent stays in AI review", async () => {
    await ready();
    const view = await readIssueDelegation(
      { db: router.db, jira: router.jira },
      testWorkspace,
      await router.jira.getIssue("KAN-1"),
    );
    expect(view).toMatchObject({ stage: "coordinating", quality: { completed: 1, total: 1 } });
  });
  it("waits for merged dependency code before starting a second child", async () => {
    await publish(
      singlePlan({
        tasks: [task, { ...task, taskId: "ui", title: "UI", dependencies: ["feature"] }],
      }),
    );
    await router.jira.transitionIssueToStatus("KAN-1002", IN_PROGRESS_STATUS);
    await completeChild();
    expect(getOpenJobForIssue(router.db, "KAN-1002")?.state).toBe("waiting");
    await merge();
    const ui = await start();
    expect(ui.issueSnapshot.key).toBe("KAN-1002");
    expect(ui.integration?.mergeCommits).toEqual([sha(21)]);
  });
  it("preserves running work on a parent edit and requires explicit replanning after it settles", async () => {
    await publish();
    await router.jira.transitionIssueToStatus("KAN-1001", IN_PROGRESS_STATUS);
    const child = await start();
    router.jira.seedIssue(
      { ...(await router.jira.getIssue("KAN-1")), description: "Changed requirements" },
      WORKFLOW_TRANSITIONS,
    );
    const oldRequest = latestPlanningRequest(router.db, "KAN-1")?.id;
    await router.reconcile();
    expect(getOpenJobForIssue(router.db, "KAN-1001")?.state).toBe("running");
    expect(latestPlanningRequest(router.db, "KAN-1")?.id).toBe(oldRequest);
    await finish(child, {});
    expect((await router.reconcile()).jobsCreated).toEqual([]);
    await answer("재계획");
    expect(latestPlanningRequest(router.db, "KAN-1")?.id).not.toBe(oldRequest);
    expect(getOpenJobForIssue(router.db, "KAN-1")?.kind).toBe("planning");
  });
  it("holds a candidate and consumes subsequent replacement answers once", async () => {
    await ready();
    await evaluate([finding()]);
    await router.reconcile();
    await process();
    await answer("4 영향 확인 필요");
    expect((await router.reconcile()).jobsCreated).toEqual([]);
    await answer("3 중복은 서로 다른 정책이라 수용");
    await router.reconcile();
    expect(getOpenJobForIssue(router.db, "KAN-1")?.kind).toBe("quality_review");
    expect(router.db.prepare("SELECT * FROM quality_decisions").all()).toHaveLength(2);
  });
  it("respects manual parent completion and records incomplete verification", async () => {
    await publish();
    await router.jira.transitionIssueToStatus("KAN-1", DONE_STATUS);
    await router.reconcile();
    expect((await router.jira.getIssue("KAN-1")).statusName).toBe(DONE_STATUS);
    expect(
      router.db
        .prepare(
          "SELECT reason FROM attention_items WHERE cause='parent closed before quality gate'",
        )
        .get(),
    ).toBeDefined();
  });
  it("refuses the final transition if a child is reopened after evaluation", async () => {
    await ready();
    await evaluate();
    await evaluate();
    await router.reconcile();
    await router.jira.transitionIssueToStatus("KAN-1001", IN_PROGRESS_STATUS);
    await process();
    expect((await router.jira.getIssue("KAN-1")).statusName).toBe(REQUEST_STATUS);
  });
  it("does not adopt a child move made before publication finished", async () => {
    const write = router.jira.setIssueProperty.bind(router.jira);
    const spy = vi
      .spyOn(router.jira, "setIssueProperty")
      .mockImplementation(async (key, property, value) => {
        await write(key, property, value);
        if (property === PLAN_TASK_PROPERTY_KEY)
          await router.jira.transitionIssueToStatus(key, IN_PROGRESS_STATUS);
      });
    await publish();
    spy.mockRestore();
    expect(getOpenJobForIssue(router.db, "KAN-1001")).toBeUndefined();
    await router.jira.transitionIssueToStatus("KAN-1001", REQUEST_STATUS);
    await completeChild();
  });
  it("reuses an existing follow-up for the exact same finding after explicit reassessment", async () => {
    await ready();
    await evaluate([finding()]);
    await router.reconcile();
    await process();
    await answer("2 다음 릴리스에 개선");
    expect(router.jira.createdIssues).toHaveLength(2);
    await answer("재시도");
    await evaluate([finding()]);
    await router.reconcile();
    await process();
    expect(router.jira.createdIssues).toHaveLength(2);
    const carried = router.db
      .prepare("SELECT source_cycle_id FROM quality_decisions WHERE source_cycle_id IS NOT NULL")
      .all();
    expect(carried).toHaveLength(1);
  });
  it("keeps completed contracts during a replan and rejects colliding new task IDs", async () => {
    await ready();
    router.jira.seedIssue(
      { ...(await router.jira.getIssue("KAN-1")), description: "Extended outcome" },
      WORKFLOW_TRANSITIONS,
    );
    await answer("재계획");
    const pm = await start();
    expect(pm.planningContext?.existingTaskContracts).toMatchObject([
      { issueKey: "KAN-1001", taskId: "feature" },
    ]);
    await finish(pm, {
      status: "planned",
      plan: singlePlan({ tasks: [task], keepTaskKeys: ["KAN-1001"] }),
    });
    expect(router.jira.createdIssues).toHaveLength(1);
    expect(
      router.db.prepare("SELECT outcome FROM plan_reviews ORDER BY rowid DESC LIMIT 1").get(),
    ).toEqual({ outcome: "not_applied" });
  });
  it("supports a keep-only replan without turning the parent into an implementation", async () => {
    await ready();
    router.jira.seedIssue(
      { ...(await router.jira.getIssue("KAN-1")), description: "Clarified acceptance" },
      WORKFLOW_TRANSITIONS,
    );
    await answer("재계획");
    const pm = await start();
    await finish(pm, {
      status: "planned",
      plan: singlePlan({ tasks: [], keepTaskKeys: ["KAN-1001"] }),
    });
    await router.reconcile();
    expect(router.jira.createdIssues).toHaveLength(1);
    expect(getOpenJobForIssue(router.db, "KAN-1")?.kind).toBe("quality_review");
  });
});
