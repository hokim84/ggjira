import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeJiraGateway } from "../src/jira/fake.js";
import { JobStore } from "../src/job/store.js";
import { buildAssignedJql, findAssignedJobs } from "../src/poller/poller.js";
import { buildTestConfig, buildTestIssue } from "./helpers/fixtures.js";

const SELF = {
  accountId: "self-id",
  displayName: "GGJIRA Implement",
  emailAddress: "ggjira-implement@example.com",
};

describe("buildAssignedJql", () => {
  it("builds assignee + readyStatus JQL by default", () => {
    const config = buildTestConfig();
    expect(buildAssignedJql(config)).toBe(
      'assignee = currentUser() AND status = "To Do" ORDER BY created ASC',
    );
  });

  it("uses jira.jql verbatim when set", () => {
    const config = buildTestConfig({
      jira: { baseUrl: "https://example.atlassian.net", jql: "project = KAN" },
    });
    expect(buildAssignedJql(config)).toBe("project = KAN");
  });
});

describe("findAssignedJobs", () => {
  let dataDir: string;
  let store: JobStore;
  const config = buildTestConfig();

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "ggjira-poller-test-"));
    store = new JobStore(dataDir);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns issues assigned to this agent that are ready to claim", async () => {
    const jira = new FakeJiraGateway();
    jira.setSelf(SELF);
    jira.seedIssue(
      buildTestIssue({ key: "KAN-1", assigneeAccountId: SELF.accountId, statusName: "To Do" }),
    );
    jira.seedIssue(
      buildTestIssue({ key: "KAN-2", assigneeAccountId: SELF.accountId, statusName: "To Do" }),
    );
    jira.seedIssue(
      buildTestIssue({ key: "KAN-3", assigneeAccountId: "someone-else", statusName: "To Do" }),
    );
    jira.seedIssue(
      buildTestIssue({
        key: "KAN-4",
        assigneeAccountId: SELF.accountId,
        statusName: "In Progress",
      }),
    );

    const candidates = await findAssignedJobs(jira, config, store);

    expect(candidates.map((i) => i.key).sort()).toEqual(["KAN-1", "KAN-2"]);
  });

  it("filters out issues already claimed locally", async () => {
    const jira = new FakeJiraGateway();
    jira.setSelf(SELF);
    jira.seedIssue(
      buildTestIssue({ key: "KAN-1", assigneeAccountId: SELF.accountId, statusName: "To Do" }),
    );
    jira.seedIssue(
      buildTestIssue({ key: "KAN-2", assigneeAccountId: SELF.accountId, statusName: "To Do" }),
    );
    store.claimIssue("KAN-1", "run-1");

    const candidates = await findAssignedJobs(jira, config, store);

    expect(candidates.map((i) => i.key)).toEqual(["KAN-2"]);
  });
});
