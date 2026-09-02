import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { FakeJiraGateway } from "../src/jira/fake.js";
import type { JiraIssue } from "../src/jira/types.js";
import { JobStore } from "../src/job/store.js";
import { findCandidateIssues } from "../src/poller/poller.js";

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

function issue(key: string): JiraIssue {
  return { key, id: key, summary: "s", description: null, statusName: "To Do", labels: ["ggjira"] };
}

describe("findCandidateIssues", () => {
  let dataDir: string;
  let store: JobStore;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "ggjira-poller-test-"));
    store = new JobStore(dataDir);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns issues matching the configured JQL", async () => {
    const jira = new FakeJiraGateway();
    jira.seedIssue(issue("KAN-1"));
    jira.seedIssue(issue("KAN-2"));

    const candidates = await findCandidateIssues(jira, config, store);

    expect(candidates.map((i) => i.key).sort()).toEqual(["KAN-1", "KAN-2"]);
  });

  it("filters out issues already claimed locally", async () => {
    const jira = new FakeJiraGateway();
    jira.seedIssue(issue("KAN-1"));
    jira.seedIssue(issue("KAN-2"));
    store.claimIssue("KAN-1", "run-1");

    const candidates = await findCandidateIssues(jira, config, store);

    expect(candidates.map((i) => i.key)).toEqual(["KAN-2"]);
  });
});
