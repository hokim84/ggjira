import { describe, expect, it } from "vitest";
import { ClaimLostError, claimJob } from "../src/agent/claim.js";
import { FakeJiraGateway } from "../src/jira/fake.js";
import { buildTestConfig, buildTestIssue } from "./helpers/fixtures.js";

const config = buildTestConfig();

describe("claimJob", () => {
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

    await expect(claimJob(jira, config, issue, "run-1")).rejects.toBeInstanceOf(ClaimLostError);
    expect(jira.comments).toHaveLength(0);
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
