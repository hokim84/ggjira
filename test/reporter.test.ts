import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { FakeJiraGateway } from "../src/jira/fake.js";
import type { JiraIssue } from "../src/jira/types.js";
import { createJob, transitionJob } from "../src/job/job.js";
import {
  buildFailureComment,
  buildStartComment,
  buildSuccessComment,
  claimIssueInJira,
  reportFailure,
  reportSuccess,
} from "../src/reporter/reporter.js";

const config: AppConfig = {
  jira: {
    jql: 'project = KAN AND labels = "ggjira"',
    inProgressTransitionName: "In Progress",
    successTransitionName: "In Review",
    failureLabel: "ggjira-failed",
  },
  polling: { intervalMs: 60000 },
  targetRepo: { path: "/tmp/repo", baseBranch: "main" },
  worker: {
    command: "claude",
    model: "sonnet",
    effort: "high",
    timeoutMs: 60000,
    permissionMode: "acceptEdits",
    allowedTools: [],
  },
  concurrency: { maxConcurrentJobs: 1 },
};

const issue: JiraIssue = {
  key: "KAN-1",
  id: "10000",
  summary: "Do the thing",
  description: null,
  statusName: "To Do",
  labels: ["ggjira"],
};

describe("comment templates", () => {
  it("buildStartComment includes the runId", () => {
    expect(buildStartComment("run-1")).toContain("run-1");
  });

  it("buildSuccessComment includes summary, branch, changed files and log path", () => {
    const job = transitionJob(transitionJob(createJob("KAN-1", "run-1"), "claimed"), "running", {
      branch: "ggjira/KAN-1-run-1",
    });
    const succeeded = transitionJob(job, "succeeded", { summary: "did the thing" });

    const comment = buildSuccessComment(
      succeeded,
      ["a.ts", "b.ts"],
      "/data/runs/KAN-1/run-1/worker.jsonl",
    );

    expect(comment).toContain("did the thing");
    expect(comment).toContain("ggjira/KAN-1-run-1");
    expect(comment).toContain("a.ts");
    expect(comment).toContain("b.ts");
    expect(comment).toContain("worker.jsonl");
  });

  it("buildSuccessComment reports zero changed files clearly", () => {
    const job = transitionJob(transitionJob(createJob("KAN-1", "run-1"), "claimed"), "running");
    const succeeded = transitionJob(job, "succeeded", { summary: "nothing to change" });

    const comment = buildSuccessComment(succeeded, [], "/log");
    expect(comment).toContain("변경된 파일 없음");
  });

  it("buildFailureComment includes the failure stage and error", () => {
    let job = transitionJob(createJob("KAN-1", "run-1"), "claimed");
    job = transitionJob(job, "running");
    job = transitionJob(job, "failed", { failureStage: "worker", error: "exit code 1" });

    const comment = buildFailureComment(job);
    expect(comment).toContain("worker");
    expect(comment).toContain("exit code 1");
  });
});

describe("Jira write functions", () => {
  it("claimIssueInJira transitions then comments, in order", async () => {
    const jira = new FakeJiraGateway();
    jira.seedIssue(issue, [{ id: "21", name: "In Progress", toStatusName: "In Progress" }]);

    await claimIssueInJira(jira, config, issue, "run-1");

    expect(jira.transitions).toEqual([{ key: "KAN-1", transitionName: "In Progress" }]);
    expect(jira.comments[0]?.body).toContain("run-1");
  });

  it("reportSuccess comments then transitions to the success status", async () => {
    const jira = new FakeJiraGateway();
    jira.seedIssue(issue, [{ id: "31", name: "In Review", toStatusName: "In Review" }]);
    const job = transitionJob(transitionJob(createJob("KAN-1", "run-1"), "claimed"), "running");
    const succeeded = transitionJob(job, "succeeded", { summary: "done" });

    await reportSuccess(jira, config, issue, succeeded, ["a.ts"], "/log");

    expect(jira.comments).toHaveLength(1);
    expect(jira.transitions).toEqual([{ key: "KAN-1", transitionName: "In Review" }]);
  });

  it("reportFailure comments then labels the issue", async () => {
    const jira = new FakeJiraGateway();
    jira.seedIssue(issue);
    let job = transitionJob(createJob("KAN-1", "run-1"), "claimed");
    job = transitionJob(job, "running");
    job = transitionJob(job, "failed", { failureStage: "worker", error: "boom" });

    await reportFailure(jira, config, issue, job);

    expect(jira.comments).toHaveLength(1);
    expect(jira.labelChanges).toEqual([{ key: "KAN-1", label: "ggjira-failed", action: "add" }]);
  });
});
