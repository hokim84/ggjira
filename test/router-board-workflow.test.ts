import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JobEnvelope } from "../src/contracts/envelope.js";
import { PROTOCOL_VERSION } from "../src/contracts/protocol.js";
import { getAttempt } from "../src/router/db/attempts.js";
import { listAudit } from "../src/router/db/audit.js";
import { getJob, getOpenJobForIssue } from "../src/router/db/jobs.js";
import { latestJudgment, listReviewTargets } from "../src/router/db/review-targets.js";
import { handlePullRequestClosed } from "../src/router/github.js";
import { expireLeases } from "../src/router/leases.js";
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
        ...(job.qualityContext?.expectedSha && "quality" in data
          ? { quality: { ...(data.quality as object), targetSha: job.qualityContext.expectedSha } }
          : {}),
      },
      worker.token,
    );
    expect(response.statusCode, response.body).toBe(200);
    await process();
  }
  const noChange = {
    git: { repository: "git", committed: false, baseBranch: "main", baseSha: sha(1) },
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
  async function publish(two = false) {
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
          ...(two
            ? [
                {
                  taskId: "ui",
                  title: "UI",
                  description: "Use feature",
                  acceptance: ["Works"],
                  verification: ["Run tests"],
                  dependencies: ["feature"],
                },
              ]
            : []),
        ],
      }),
    });
    await router.reconcile();
  }
  async function assembleNoChange() {
    const job = await start();
    expect(job.kind).toBe("assemble_pr");
    await finish(job, {
      git: {
        repository: "git",
        committed: false,
        baseBranch: "main",
        baseSha: sha(1),
        headSha: sha(1),
      },
      changes: [],
    });
    expect(await status()).toBe(w.integrationPendingStatus);
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
    await assembleNoChange();
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
  it("runs dependencies from published commits, creates one parent PR, and validates only after merge", async () => {
    await publish(true);
    await router.jira.transitionIssueToStatus("KAN-1002", w.inProgressStatus);
    await router.reconcile();
    expect((await router.next(worker, `waiting-${++serial}`)).statusCode).toBe(204);
    await router.jira.transitionIssueToStatus("KAN-1001", w.inProgressStatus);
    const first = await start();
    expect(first.deferPullRequest).toBe(true);
    await finish(first, {
      ...noChange,
      branch: "ggjira/first",
      artifacts: ["pushed: origin/ggjira/first"],
      git: {
        repository: "git",
        committed: true,
        baseBranch: "main",
        baseSha: sha(1),
        headSha: sha(2),
      },
    });
    expect(await status("KAN-1001")).toBe(w.implementationCompleteStatus);
    expect(router.db.prepare("SELECT COUNT(*) n FROM pull_requests").get()).toEqual({ n: 0 });
    const second = await start();
    expect(second.issueSnapshot.key).toBe("KAN-1002");
    expect(second.integration?.resultCommits).toContain(sha(2));
    await finish(second, {
      ...noChange,
      branch: "ggjira/second",
      artifacts: ["pushed: origin/ggjira/second"],
      git: {
        repository: "git",
        committed: true,
        baseBranch: "main",
        baseSha: sha(2),
        headSha: sha(3),
      },
    });
    const aggregate = await start();
    expect(aggregate.kind).toBe("assemble_pr");
    expect(aggregate.assembly?.children.map((c) => c.issueKey)).toEqual(["KAN-1001", "KAN-1002"]);
    await finish(aggregate, {
      branch: "ggjira/aggregate",
      pullRequest: { repo: "org/repo", number: 10, url: "https://github.com/org/repo/pull/10" },
      git: {
        repository: "git",
        committed: true,
        baseBranch: "main",
        baseSha: sha(1),
        headSha: sha(4),
      },
    });
    expect(await status()).toBe(w.integrationPendingStatus);
    expect(router.db.prepare("SELECT COUNT(*) n FROM pull_requests").get()).toEqual({ n: 1 });
    expect((await router.reconcile()).jobsCreated).toEqual([]);
    handlePullRequestClosed(
      router.db,
      router.config,
      {
        repo: "org/repo",
        number: 10,
        merged: true,
        by: "human",
        headSha: sha(4),
        mergeSha: sha(5),
        targetBranch: "main",
      },
      router.clock.now(),
    );
    await process();
    const check = await start();
    expect(check.kind).toBe("integration_check");
    expect(check.qualityContext?.expectedSha).toBe(sha(5));
    expect(check.qualityContext?.resultIds).toHaveLength(3);
    await finish(check, quality());
    expect(await status()).toBe(w.implementationCompleteStatus);
    expect(await status("KAN-1002")).toBe(w.implementationCompleteStatus);
  });
  it("keeps a child with unverified checks waiting until a person confirms it (ADR 0061)", async () => {
    await publish();
    await router.jira.transitionIssueToStatus("KAN-1001", w.inProgressStatus);
    await finish(await start(), {
      branch: "ggjira/first",
      artifacts: ["pushed: origin/ggjira/first"],
      changes: ["src/a.ts"],
      validation: ['"npm test" passed'],
      git: {
        repository: "git",
        committed: true,
        baseBranch: "main",
        baseSha: sha(1),
        headSha: sha(2),
      },
      scopeCheck: {
        checked: true,
        changedPaths: [{ path: "src/a.ts", change: "modified" }],
        outsideAllowed: [],
      },
      implementation: {
        outcome: "completed",
        summary: "Added the panel",
        scopeDeviations: [],
        risks: [],
        verification: [
          { acceptance: "Works", status: "pass", method: "executed", evidence: "npm test" },
          {
            acceptance: "The panel scrolls on screen",
            status: "not_verified",
            method: "inspected",
            evidence: "no display on the worker",
          },
        ],
      },
    });
    // Kept on the remote and in progress: not failed, not done, nothing to aggregate yet.
    expect(await status("KAN-1001")).toBe(w.inProgressStatus);
    expect((await router.jira.getIssue("KAN-1001")).labels).not.toContain("ggjira-failed");
    const waiting = router.jira.comments.filter((c) => c.key === "KAN-1001").at(-1)?.body;
    expect(waiting).toContain("사람 확인 대기");
    expect(waiting).toContain("- The panel scrolls on screen");
    await router.reconcile();
    expect((await router.next(worker, `waiting-${++serial}`)).statusCode).toBe(204);

    const humanCheck = async () =>
      (await router.adminCall("GET", "/issues/KAN-1001")).json().delegation.humanCheck;
    expect(await humanCheck()).toEqual(["The panel scrolls on screen"]);

    const target = listReviewTargets(router.db, "KAN-1001")[0]?.id as string;
    const judge = (action: string, note?: string) =>
      router.adminCall("POST", `/reviews/${target}/judgments`, {
        action,
        ...(note ? { note } : {}),
      });
    // A hold records an opinion and completes nothing.
    expect((await judge("hold", "Checking the layout first")).statusCode).toBe(201);
    await process();
    expect(await status("KAN-1001")).toBe(w.inProgressStatus);

    expect((await judge("confirm")).statusCode).toBe(201);
    await process();
    expect(await status("KAN-1001")).toBe(w.implementationCompleteStatus);
    expect(router.jira.comments.filter((c) => c.key === "KAN-1001").at(-1)?.body).toContain(
      "사람 확인 완료",
    );
    expect(await humanCheck()).toBeNull();
    const aggregate = await start();
    expect(aggregate.kind).toBe("assemble_pr");
    expect(aggregate.assembly?.children.map((c) => c.headSha)).toEqual([sha(2)]);
  });

  const awaitingCheck = (head: number, base = 1) => ({
    branch: `ggjira/child-${head}`,
    artifacts: [`pushed: origin/ggjira/child-${head}`],
    changes: ["src/a.ts"],
    validation: ['"npm test" passed'],
    git: {
      repository: "git",
      committed: true,
      baseBranch: "main",
      baseSha: sha(base),
      headSha: sha(head),
    },
    scopeCheck: {
      checked: true,
      changedPaths: [{ path: "src/a.ts", change: "modified" }],
      outsideAllowed: [],
    },
    implementation: {
      outcome: "completed",
      summary: "Added the panel",
      scopeDeviations: [],
      risks: [],
      verification: [
        { acceptance: "Works", status: "pass", method: "executed", evidence: "npm test" },
        {
          acceptance: "The panel scrolls on screen",
          status: "not_verified",
          method: "inspected",
          evidence: "no display on the worker",
        },
      ],
    },
  });

  it("takes a person's move to implementation complete in Jira as the confirmation (ADR 0061)", async () => {
    await publish(true);
    await router.jira.transitionIssueToStatus("KAN-1002", w.inProgressStatus);
    await router.jira.transitionIssueToStatus("KAN-1001", w.inProgressStatus);
    await finish(await start(), awaitingCheck(2));
    expect(await status("KAN-1001")).toBe(w.inProgressStatus);
    expect(router.jira.comments.filter((c) => c.key === "KAN-1001").at(-1)?.body).toContain(
      `이슈를 "${w.implementationCompleteStatus}"(으)로 옮기세요`,
    );
    // The dependent child waits while the result waits for a person.
    await router.reconcile();
    expect((await router.next(worker, `waiting-${++serial}`)).statusCode).toBe(204);

    // The person checks it and moves the card; no Router UI involved.
    await router.jira.transitionIssueToStatus("KAN-1001", w.implementationCompleteStatus);
    const second = await start();
    expect(second.issueSnapshot.key).toBe("KAN-1002");
    expect(second.integration?.resultCommits).toContain(sha(2));
    const target = listReviewTargets(router.db, "KAN-1001")[0]?.id as string;
    expect(latestJudgment(router.db, target)).toMatchObject({
      action: "judgment.confirm",
      actor: "jira",
      authentication: "jira-status",
    });

    await finish(second, { ...noChange, ...awaitingCheck(3, 2) });
    await router.jira.transitionIssueToStatus("KAN-1002", w.implementationCompleteStatus);
    const aggregate = await start();
    expect(aggregate.kind).toBe("assemble_pr");
    expect(aggregate.assembly?.children.map((c) => c.headSha)).toEqual([sha(2), sha(3)]);
  });

  it("does not take a manual completion of a failed or unfinished child as a confirmation", async () => {
    await publish();
    await router.jira.transitionIssueToStatus("KAN-1001", w.inProgressStatus);
    const child = await start();
    const failing = awaitingCheck(2);
    failing.implementation.verification[1] = {
      ...failing.implementation.verification[1],
      status: "fail",
    } as (typeof failing.implementation.verification)[number];
    await finish(child, failing);
    await router.jira.transitionIssueToStatus("KAN-1001", w.implementationCompleteStatus);
    await router.reconcile();
    expect((await router.next(worker, `manual-${++serial}`)).statusCode).toBe(204);
  });

  it("reruns a run left recovery_required on the assignee's 재시도 comment (ADR 0062)", async () => {
    await router.jira.transitionIssueToStatus("KAN-1", w.inProgressStatus);
    const lost = await start();
    router.clock.advance(31_000);
    expireLeases(router.db, router.clock.now());
    expect(getJob(router.db, lost.jobId)?.state).toBe("recovery_required");

    // Jira hears about it once, with what to do.
    await router.reconcile();
    await router.reconcile();
    await process();
    const notices = router.jira.comments.filter(
      (c) => c.key === "KAN-1" && c.body.includes("실행이 멈췄는지 GGJIRA가 확인할 수 없어"),
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]?.body).toContain('"재시도"');

    router.clock.advance(1000);
    router.jira.seedComment("KAN-1", {
      body: "재시도",
      authorAccountId: "other",
      created: router.clock.now(),
    });
    expect((await router.reconcile()).jobsCreated).toEqual([]);
    expect(getJob(router.db, lost.jobId)?.state).toBe("recovery_required");

    router.jira.seedComment("KAN-1", {
      body: "재시도",
      authorAccountId: "owner",
      created: router.clock.now(),
    });
    const rerun = await start();
    expect(rerun.jobId).not.toBe(lost.jobId);
    expect(rerun.approvalId).not.toBe(lost.approvalId);
    expect(getJob(router.db, lost.jobId)?.state).toBe("cancelled");
    expect(getAttempt(router.db, lost.attemptId)?.state).toBe("superseded");
    expect(listAudit(router.db, lost.jobId)).toContainEqual(
      expect.objectContaining({ action: "job.resolved", actor: "jira:owner" }),
    );
    // The old attempt's late result is not applied to the issue.
    const late = await router.post(
      `/api/v1/jobs/${lost.jobId}/result`,
      {
        protocolVersion: PROTOCOL_VERSION,
        jobId: lost.jobId,
        attemptId: lost.attemptId,
        resultId: `late-${lost.attemptId}`,
        status: "succeeded",
        summary: "Late",
        ...noChange,
      },
      worker.token,
    );
    expect(late.statusCode).not.toBe(500);
    await process();
    expect(await status()).toBe(w.inProgressStatus);
  });

  it("withdraws an aggregate when a child is reopened, without rerunning successful siblings", async () => {
    await publish();
    await router.jira.transitionIssueToStatus("KAN-1001", w.inProgressStatus);
    await finish(await start(), noChange);
    const aggregate = await start();
    expect(aggregate.kind).toBe("assemble_pr");
    await router.jira.transitionIssueToStatus("KAN-1001", w.inProgressStatus);
    await router.reconcile();
    await finish(aggregate, {
      git: { repository: "git", committed: false, baseSha: sha(1), headSha: sha(1) },
      changes: [],
    });
    expect(await status()).toBe(w.inProgressStatus);
    expect(router.db.prepare("SELECT COUNT(*) n FROM pull_requests").get()).toEqual({ n: 0 });
  });
  it("does not aggregate a manually completed child whose approved inputs changed", async () => {
    await publish();
    await router.jira.transitionIssueToStatus("KAN-1001", w.inProgressStatus);
    await finish(await start(), noChange);
    const issue = await router.jira.getIssue("KAN-1001");
    await router.jira.updateIssueDescription(
      issue.key,
      `${issue.description}\nChanged requirement`,
    );
    await router.reconcile();
    await process();
    expect(router.db.prepare("SELECT COUNT(*) n FROM jobs WHERE kind='assemble_pr'").get()).toEqual(
      { n: 0 },
    );
    expect(await status()).toBe(w.inProgressStatus);
  });
  it("rejects a successful integration report for a different SHA", async () => {
    await publish();
    await router.jira.transitionIssueToStatus("KAN-1001", w.inProgressStatus);
    await finish(await start(), noChange);
    await assembleNoChange();
    const check = await start();
    expect(check.kind).toBe("integration_check");
    const response = await router.post(
      `/api/v1/jobs/${check.jobId}/result`,
      {
        protocolVersion: PROTOCOL_VERSION,
        jobId: check.jobId,
        attemptId: check.attemptId,
        resultId: `wrong-${check.attemptId}`,
        status: "succeeded",
        summary: "Wrong target",
        ...quality(),
      },
      worker.token,
    );
    expect(response.statusCode).toBe(200);
    await process();
    expect(await status()).toBe(w.integrationPendingStatus);
    expect(getOpenJobForIssue(router.db, "KAN-1")?.state).toBe("failed");
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
    await assembleNoChange();
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
    await assembleNoChange();
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
    await assembleNoChange();
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
    await assembleNoChange();
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
