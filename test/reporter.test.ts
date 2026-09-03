import { describe, expect, it } from "vitest";
import type { ExecutionResult } from "../src/agent/result.js";
import { FakeJiraGateway } from "../src/jira/fake.js";
import { createJob, transitionJob } from "../src/job/job.js";
import {
  buildFailureComment,
  buildStartComment,
  buildSuccessComment,
  reportForResult,
} from "../src/reporter/reporter.js";
import { buildTestConfig, buildTestIssue } from "./helpers/fixtures.js";

const config = buildTestConfig();
const issue = buildTestIssue({ key: "KAN-1" });

describe("comment templates", () => {
  it("buildStartComment includes the runId and agent identity", () => {
    const comment = buildStartComment("run-1", config);
    expect(comment).toContain("run-1");
    expect(comment).toContain("ggjira-implement@test-machine");
  });

  it("buildSuccessComment includes summary, changes, validation and artifacts", () => {
    const job = transitionJob(transitionJob(createJob("KAN-1", "run-1"), "claimed"), "running", {
      branch: "ggjira/KAN-1-run-1",
    });
    const succeeded = transitionJob(job, "succeeded", { summary: "did the thing" });
    const result: ExecutionResult = {
      status: "succeeded",
      summary: "did the thing",
      changes: ["a.ts", "b.ts"],
      validation: ["unit tests passed"],
      artifacts: ["branch: ggjira/KAN-1-run-1"],
    };

    const comment = buildSuccessComment(succeeded, config, result);

    expect(comment).toContain("Implementation completed.");
    expect(comment).toContain("did the thing");
    expect(comment).toContain("a.ts");
    expect(comment).toContain("b.ts");
    expect(comment).toContain("unit tests passed");
    expect(comment).toContain("ggjira/KAN-1-run-1");
    expect(comment).toContain("run-1");
  });

  it("buildSuccessComment omits sections that have nothing to report", () => {
    const job = transitionJob(transitionJob(createJob("KAN-1", "run-1"), "claimed"), "running");
    const succeeded = transitionJob(job, "succeeded", { summary: "nothing to change" });
    const result: ExecutionResult = { status: "succeeded", summary: "nothing to change" };

    const comment = buildSuccessComment(succeeded, config, result);
    expect(comment).not.toContain("Changes:");
    expect(comment).not.toContain("Validation:");
    expect(comment).not.toContain("Artifacts:");
  });

  it("buildFailureComment includes the failure reason and blocking issue", () => {
    let job = transitionJob(createJob("KAN-1", "run-1"), "claimed");
    job = transitionJob(job, "running");
    job = transitionJob(job, "failed", { failureStage: "worker", error: "exit code 1" });
    const result: ExecutionResult = {
      status: "failed",
      summary: "Implementation could not be completed.",
      failureReason: "exit code 1",
      blockingIssue: "GGJ-138",
    };

    const comment = buildFailureComment(job, config, result);
    expect(comment).toContain("Execution failed.");
    expect(comment).toContain("exit code 1");
    expect(comment).toContain("Blocking Issue:");
    expect(comment).toContain("GGJ-138");
  });
});

describe("reportForResult", () => {
  it("posts the success comment then transitions to doneTransitionName", async () => {
    const jira = new FakeJiraGateway();
    jira.seedIssue(issue, [{ id: "31", name: "In Review", toStatusName: "In Review" }]);
    const job = transitionJob(transitionJob(createJob("KAN-1", "run-1"), "claimed"), "running");
    const succeeded = transitionJob(job, "succeeded", { summary: "done" });
    const result: ExecutionResult = { status: "succeeded", summary: "done", changes: ["a.ts"] };

    await reportForResult(jira, config, issue, succeeded, result);

    expect(jira.comments).toHaveLength(1);
    expect(jira.transitions).toEqual([{ key: "KAN-1", transitionName: "In Review" }]);
  });

  it("posts the failure comment then adds the failure label", async () => {
    const jira = new FakeJiraGateway();
    jira.seedIssue(issue);
    let job = transitionJob(createJob("KAN-1", "run-1"), "claimed");
    job = transitionJob(job, "running");
    job = transitionJob(job, "failed", { failureStage: "worker", error: "boom" });
    const result: ExecutionResult = { status: "failed", summary: "failed", failureReason: "boom" };

    await reportForResult(jira, config, issue, job, result);

    expect(jira.comments).toHaveLength(1);
    expect(jira.labelChanges).toEqual([{ key: "KAN-1", label: "ggjira-failed", action: "add" }]);
  });

  it("for a planned result, transitions using plannedTransitionName when configured", async () => {
    const jira = new FakeJiraGateway();
    const withPlannedTransition = buildTestConfig({
      workflow: { ...config.workflow, plannedTransitionName: "Planned" },
    });
    jira.seedIssue(issue, [{ id: "41", name: "Planned", toStatusName: "Planned" }]);
    const job = transitionJob(transitionJob(createJob("KAN-1", "run-1"), "claimed"), "running");
    const succeeded = transitionJob(job, "succeeded", { summary: "planned" });
    const result: ExecutionResult = {
      status: "planned",
      summary: "planned",
      artifacts: ["created: KAN-2"],
    };

    await reportForResult(jira, withPlannedTransition, issue, succeeded, result);

    expect(jira.transitions).toEqual([{ key: "KAN-1", transitionName: "Planned" }]);
  });

  it("for a planned result with no plannedTransitionName configured, labels instead of transitioning", async () => {
    const jira = new FakeJiraGateway();
    jira.seedIssue(issue);
    const job = transitionJob(transitionJob(createJob("KAN-1", "run-1"), "claimed"), "running");
    const succeeded = transitionJob(job, "succeeded", { summary: "planned" });
    const result: ExecutionResult = { status: "planned", summary: "planned" };

    await reportForResult(jira, config, issue, succeeded, result);

    expect(jira.transitions).toHaveLength(0);
    expect(jira.labelChanges).toEqual([{ key: "KAN-1", label: "ggjira-planned", action: "add" }]);
  });

  it("for a needs_decision result, posts the decision request and transitions to needsDecisionTransitionName", async () => {
    const jira = new FakeJiraGateway();
    jira.seedIssue(issue, [{ id: "51", name: "Needs Decision", toStatusName: "Needs Decision" }]);
    const job = transitionJob(transitionJob(createJob("KAN-1", "run-1"), "claimed"), "running");
    const succeeded = transitionJob(job, "succeeded", { summary: "needs a decision" });
    const result: ExecutionResult = {
      status: "needs_decision",
      summary: "needs a decision",
      decisionRequest: "[GGJIRA:DECISION-REQUEST]\n\nQuestion: which approach?",
    };

    await reportForResult(jira, config, issue, succeeded, result);

    expect(jira.comments[0]?.body).toContain("[GGJIRA:DECISION-REQUEST]");
    expect(jira.transitions).toEqual([{ key: "KAN-1", transitionName: "Needs Decision" }]);
  });
});
