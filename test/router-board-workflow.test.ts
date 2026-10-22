import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JobEnvelope } from "../src/contracts/envelope.js";
import { PROTOCOL_VERSION } from "../src/contracts/protocol.js";
import { getOpenJobForIssue } from "../src/router/db/jobs.js";
import { handlePullRequestClosed } from "../src/router/github.js";
import { processReportJournal } from "../src/router/report-processor.js";
import { WORKFLOW_TRANSITIONS, singlePlan, testWorkspace } from "./helpers/router-fixtures.js";
import { type RegisteredWorker, RouterHarness } from "./helpers/router-harness.js";

const w = testWorkspace.workflow;
const sha = (n: number) => n.toString(16).padStart(40, "0");
describe("board workflow", () => {
  let router: RouterHarness;
  let worker: RegisteredWorker;
  let serial = 0;
  beforeEach(async () => {
    router = new RouterHarness();
    worker = await router.connectWorker("worker-1");
    router.jira.setCreatedIssueTransitions(WORKFLOW_TRANSITIONS);
    router.jira.seedIssue(
      {
        key: "KAN-1",
        summary: "Feature",
        description: "Build feature",
        statusName: w.requestStatus,
        assigneeAccountId: "owner",
      },
      WORKFLOW_TRANSITIONS,
    );
  });
  afterEach(async () => {
    await router.close();
  });
  const status = async (key = "KAN-1") => (await router.jira.getIssue(key)).statusName;
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
    const next = await router.next(worker, `board-${++serial}`);
    expect(next.statusCode, next.body).toBe(200);
    const job = next.json() as JobEnvelope;
    expect(
      (
        await router.jobCall(worker, job.jobId, "start", {
          attemptId: job.attemptId,
          leaseToken: job.leaseToken,
        })
      ).json(),
    ).toMatchObject({ granted: true });
    await process();
    return job;
  }
  async function finish(job: JobEnvelope, data: object) {
    const response = await router.post(
      `/api/v1/jobs/${job.jobId}/result`,
      {
        protocolVersion: PROTOCOL_VERSION,
        jobId: job.jobId,
        attemptId: job.attemptId,
        resultId: `r-${job.attemptId}`,
        status: "succeeded",
        summary: "Result",
        ...data,
      },
      worker.token,
    );
    expect(response.statusCode, response.body).toBe(200);
    await process();
  }
  const noChange = {
    scopeCheck: {
      checked: false,
      reason: "No changes needed",
      changedPaths: [],
      outsideAllowed: [],
    },
    implementation: {
      outcome: "completed",
      summary: "Verified existing behavior; no code change is required",
      noChangeReason:
        "The existing behavior meets the request; investigation and checks require no file changes.",
      verification: [{ acceptance: "Works", status: "pass", evidence: "Read and ran checks" }],
    },
  };
  const quality = (passed = true) => ({
    quality: {
      targetSha: sha(9),
      baselineSha: sha(1),
      summary: "Assessment",
      verificationPassed: passed,
      verificationEvidence: [passed ? "Checks passed" : "Checks failed"],
      findings: [],
    },
  });
  async function publish() {
    const job = await start();
    expect(await status()).toBe(w.planningInProgressStatus);
    await finish(job, {
      status: "planned",
      plan: singlePlan({
        tasks: [
          {
            taskId: "feature",
            title: "Build feature",
            description: "Implement feature",
            acceptance: ["Works"],
            verification: ["Run tests"],
          },
        ],
      }),
    });
    await router.reconcile();
  }
  it("moves only when planning actually starts and preserves the request across automatic transition", async () => {
    await router.reconcile();
    expect(await status()).toBe(w.requestStatus);
    const job = await start();
    expect(job.kind).toBe("planning");
    expect(await status()).toBe(w.planningInProgressStatus);
    expect((await router.reconcile()).jobsCancelled).toEqual([]);
    await finish(job, { status: "planned", plan: singlePlan() });
    expect((await router.reconcile()).jobsCreated).toEqual([]);
  });
  it("implements a direct request without a planning job and completes verified no-change work", async () => {
    await router.jira.transitionIssueToStatus("KAN-1", w.inProgressStatus);
    const job = await start();
    expect(job.kind).toBe("implementation");
    expect(job.executionContract?.inScope.join(" ")).toContain("Build feature");
    await finish(job, noChange);
    expect(await status()).toBe(w.implementationCompleteStatus);
    expect((await router.reconcile()).jobsCreated).toEqual([]);
  });
  it("does not complete an unverified result without a PR", async () => {
    await router.jira.transitionIssueToStatus("KAN-1", w.inProgressStatus);
    await finish(await start(), {});
    expect(await status()).toBe(w.inProgressStatus);
    expect((await router.jira.getIssue("KAN-1")).labels).toContain("ggjira-failed");
  });
  it("approves children separately and moves the parent when the first child actually starts", async () => {
    await publish();
    expect(await status()).toBe(w.planningInProgressStatus);
    expect(getOpenJobForIssue(router.db, "KAN-1001")).toBeUndefined();
    await router.jira.transitionIssueToStatus("KAN-1001", w.inProgressStatus);
    const child = await start();
    expect(child.issueSnapshot.key).toBe("KAN-1001");
    expect(await status()).toBe(w.inProgressStatus);
    await finish(child, noChange);
    await router.reconcile();
    await process();
    expect(await status()).toBe(w.integrationPendingStatus);
    const check = await start();
    expect(check.kind).toBe("integration_check");
    await finish(check, quality());
    expect(await status()).toBe(w.implementationCompleteStatus);
    expect((await router.reconcile()).jobsCreated).toEqual([]);
  });
  it("waits for merge, validates integration, and never automatically moves to Done", async () => {
    await router.jira.transitionIssueToStatus("KAN-1", w.inProgressStatus);
    const job = await start();
    await finish(job, {
      ...noChange,
      pullRequest: { repo: "org/repo", number: 1, url: "https://github.com/org/repo/pull/1" },
      git: {
        repository: "git",
        committed: true,
        baseBranch: "main",
        baseSha: sha(1),
        headSha: sha(2),
      },
    });
    expect(await status()).toBe(w.integrationPendingStatus);
    expect((await router.reconcile()).jobsCreated).toEqual([]);
    handlePullRequestClosed(
      router.db,
      router.config,
      {
        repo: "org/repo",
        number: 1,
        merged: true,
        by: "human",
        headSha: sha(2),
        mergeSha: sha(3),
        targetBranch: "main",
      },
      router.clock.now(),
    );
    await process();
    expect(await status()).toBe(w.integrationPendingStatus);
    const check = await start();
    expect(check.qualityContext?.integration.mergeCommits).toEqual([sha(3)]);
    await finish(check, quality());
    expect(await status()).toBe(w.implementationCompleteStatus);
  });
  it("posts advisory review without forcing changes or completing the issue", async () => {
    await router.jira.transitionIssueToStatus("KAN-1", w.inProgressStatus);
    await finish(await start(), noChange);
    await router.jira.transitionIssueToStatus("KAN-1", w.reviewStatus);
    const review = await start();
    expect(review.kind).toBe("quality_review");
    await finish(review, quality(false));
    expect(await status()).toBe(w.reviewStatus);
    expect((await router.reconcile()).jobsCreated).toEqual([]);
    await router.jira.transitionIssueToStatus("KAN-1", w.doneStatus);
    expect(await status()).toBe(w.doneStatus);
  });
  it("uses the latest review when a human requests rework", async () => {
    await router.jira.transitionIssueToStatus("KAN-1", w.inProgressStatus);
    await finish(await start(), noChange);
    await router.jira.transitionIssueToStatus("KAN-1", w.reviewStatus);
    await finish(await start(), quality());
    await router.jira.transitionIssueToStatus("KAN-1", w.inProgressStatus);
    const rework = await start();
    expect(rework.executionContract?.inScope.join(" ")).toContain("Latest advisory review");
  });
  it("does not overwrite a human's Done with a late report", async () => {
    await router.jira.transitionIssueToStatus("KAN-1", w.inProgressStatus);
    const job = await start();
    await router.jira.transitionIssueToStatus("KAN-1", w.doneStatus);
    await finish(job, noChange);
    expect(await status()).toBe(w.doneStatus);
  });
  it("retries a failed integration check only on a new assignee comment", async () => {
    await publish();
    await router.jira.transitionIssueToStatus("KAN-1001", w.inProgressStatus);
    await finish(await start(), noChange);
    await router.reconcile();
    await process();
    const check = await start();
    await finish(check, quality(false));
    expect(await status()).toBe(w.integrationPendingStatus);
    expect((await router.reconcile()).jobsCreated).toEqual([]);
    router.clock.advance(1000);
    router.jira.seedComment("KAN-1", {
      body: "재시도",
      authorAccountId: "other",
      created: router.clock.now(),
    });
    expect((await router.reconcile()).jobsCreated).toEqual([]);
    router.jira.seedComment("KAN-1", {
      body: "재시도",
      authorAccountId: "owner",
      created: router.clock.now(),
    });
    const retry = await start();
    expect(retry.kind).toBe("integration_check");
    expect(retry.approvalId).not.toBe(check.approvalId);
    await finish(retry, quality());
    expect(await status()).toBe(w.implementationCompleteStatus);
  });
  it("does not finalize a parent if a child is reopened during integration validation", async () => {
    await publish();
    await router.jira.transitionIssueToStatus("KAN-1001", w.inProgressStatus);
    await finish(await start(), noChange);
    await router.reconcile();
    await process();
    const check = await start();
    await router.jira.transitionIssueToStatus("KAN-1001", w.inProgressStatus);
    await finish(check, quality());
    expect(await status()).toBe(w.integrationPendingStatus);
    const childRework = await start();
    expect(childRework.kind).toBe("implementation");
    expect(await status()).toBe(w.inProgressStatus);
    await finish(childRework, noChange);
    await router.reconcile();
    await process();
    const freshCheck = await start();
    expect(freshCheck.kind).toBe("integration_check");
    expect(freshCheck.approvalId).not.toBe(check.approvalId);
    await finish(freshCheck, quality());
    expect(await status()).toBe(w.implementationCompleteStatus);
  });
  it("keeps the same planning lane while a numbered answer starts a new request", async () => {
    const first = await start();
    await finish(first, {
      status: "needs_decision",
      plan: {
        needsDecision: true,
        summary: "Choose",
        decision: {
          question: "Which storage?",
          options: [
            { id: "sql", title: "SQL" },
            { id: "file", title: "File" },
          ],
        },
      },
    });
    expect(await status()).toBe(w.planningInProgressStatus);
    router.jira.seedComment("KAN-1", { body: "2", authorAccountId: "owner" });
    const continued = await start();
    expect(continued.kind).toBe("planning");
    expect(continued.approvalId).not.toBe(first.approvalId);
    expect(continued.planningContext?.humanDecision).toMatchObject({ optionId: "file" });
    expect(await status()).toBe(w.planningInProgressStatus);
  });
  it("runs parent rework without reopening completed children or prematurely aggregating completion", async () => {
    await publish();
    await router.jira.transitionIssueToStatus("KAN-1001", w.inProgressStatus);
    await finish(await start(), noChange);
    await router.reconcile();
    await process();
    await finish(await start(), quality());
    await router.jira.transitionIssueToStatus("KAN-1", w.reviewStatus);
    await finish(await start(), quality());
    await router.jira.transitionIssueToStatus("KAN-1", w.inProgressStatus);
    const rework = await start();
    expect(rework.kind).toBe("implementation");
    expect(rework.issueSnapshot.key).toBe("KAN-1");
    expect(await status()).toBe(w.inProgressStatus);
    expect(await status("KAN-1001")).toBe(w.implementationCompleteStatus);
    await finish(rework, noChange);
    expect(await status()).toBe(w.implementationCompleteStatus);
  });
});
