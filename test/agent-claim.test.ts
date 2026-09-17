import { describe, expect, it } from "vitest";
import { ClaimLostError, claimJob } from "../src/agent/claim.js";
import { TransitionNotFoundError } from "../src/jira/client.js";
import { FakeJiraGateway } from "../src/jira/fake.js";
import { buildTestConfig, buildTestIssue } from "./helpers/fixtures.js";

const config = buildTestConfig();

describe("claimJob", () => {
  it("claims planning work into the same in-progress status implementation uses (ADR 0017)", async () => {
    const jira = new FakeJiraGateway();
    const issue = buildTestIssue({ key: "KAN-10", statusName: "AI Planning" });
    const planningConfig = buildTestConfig({
      configVersion: 4,
      workflow: {
        ...config.workflow,
        planningStatus: "AI Planning",
        implementationStatus: "AI Implementation",
        inProgressStatus: "In Progress",
        reviewStatus: "In Review",
      },
    });
    jira.seedIssue(issue, [{ id: "31", name: "Start planning", toStatusName: "In Progress" }]);

    await claimJob(jira, planningConfig, issue, "run-plan");

    expect(jira.transitions).toEqual([{ key: "KAN-10", transitionName: "Start planning" }]);
  });

  it("transitions then posts a start comment when the issue is still ready", async () => {
    const jira = new FakeJiraGateway();
    const issue = buildTestIssue({ key: "KAN-1", statusName: "To Do" });
    jira.seedIssue(issue, [{ id: "21", name: "In Progress", toStatusName: "In Progress" }]);

    await claimJob(jira, config, issue, "run-1");

    expect(jira.transitions).toEqual([{ key: "KAN-1", transitionName: "In Progress" }]);
    expect(jira.comments[0]?.body).toContain("run-1");
  });

  it("throws ClaimLostError without writing to Jira when the issue already moved off the ready status", async () => {
    const jira = new FakeJiraGateway();
    const issue = buildTestIssue({ key: "KAN-2", statusName: "In Progress" });
    jira.seedIssue(issue, [{ id: "21", name: "In Progress", toStatusName: "In Progress" }]);

    await expect(claimJob(jira, config, issue, "run-1")).rejects.toBeInstanceOf(ClaimLostError);

    expect(jira.transitions).toHaveLength(0);
    expect(jira.comments).toHaveLength(0);
  });

  it("throws ClaimLostError when the transition itself is rejected (race lost between re-fetch and transition)", async () => {
    const jira = new FakeJiraGateway();
    const issue = buildTestIssue({ key: "KAN-3", statusName: "To Do" });
    jira.seedIssue(issue, [{ id: "21", name: "In Progress", toStatusName: "In Progress" }]);
    jira.failNextTransition("KAN-3");

    const error = await claimJob(jira, config, issue, "run-1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClaimLostError);
    expect((error as ClaimLostError).cause).toBeInstanceOf(Error);
    expect(jira.comments).toHaveLength(0);
  });

  it("preserves a TransitionNotFoundError as the cause, distinguishing a misconfigured claimTransitionName from a real claim race", async () => {
    // A minimal override rather than reconfiguring FakeJiraGateway itself:
    // this simulates what the real JiraClient throws when
    // workflow.claimTransitionName doesn't match any transition actually
    // available on the issue (src/jira/client.ts's transitionIssue).
    class WrongTransitionNameGateway extends FakeJiraGateway {
      override async transitionIssue(key: string, transitionName: string): Promise<void> {
        throw new TransitionNotFoundError(key, transitionName, ["Start Progress", "Done"]);
      }
    }
    const jira = new WrongTransitionNameGateway();
    const issue = buildTestIssue({ key: "KAN-7", statusName: "To Do" });
    jira.seedIssue(issue, [{ id: "21", name: "Start Progress", toStatusName: "In Progress" }]);

    const error = await claimJob(jira, config, issue, "run-1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClaimLostError);
    const cause = (error as ClaimLostError).cause;
    expect(cause).toBeInstanceOf(TransitionNotFoundError);
    expect((cause as TransitionNotFoundError).availableNames).toEqual(["Start Progress", "Done"]);
  });

  it("still succeeds the claim when only the start comment fails (transition already committed)", async () => {
    const jira = new FakeJiraGateway();
    const issue = buildTestIssue({ key: "KAN-4", statusName: "To Do" });
    jira.seedIssue(issue, [{ id: "21", name: "In Progress", toStatusName: "In Progress" }]);
    jira.failNextComment("KAN-4");

    await expect(claimJob(jira, config, issue, "run-1")).resolves.toBeUndefined();
    expect(jira.transitions).toEqual([{ key: "KAN-4", transitionName: "In Progress" }]);
  });
});
