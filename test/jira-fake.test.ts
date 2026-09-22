import { describe, expect, it } from "vitest";
import { FakeJiraGateway } from "../src/jira/fake.js";

describe("FakeJiraGateway", () => {
  it("createIssue seeds labels from the input", async () => {
    const jira = new FakeJiraGateway();

    const { key } = await jira.createIssue({
      projectKey: "KAN",
      issueTypeName: "Task",
      summary: "[AGENT] pm-01",
      labels: ["ggjira-agent"],
    });

    const issue = await jira.getIssue(key);
    expect(issue.labels).toEqual(["ggjira-agent"]);
  });

  it("findable by labels JQL after createIssue seeds them", async () => {
    const jira = new FakeJiraGateway();
    await jira.createIssue({
      projectKey: "KAN",
      issueTypeName: "Task",
      summary: "[AGENT] pm-01",
      labels: ["ggjira-agent"],
    });

    const found = await jira.searchIssues('project = "KAN" AND labels = "ggjira-agent"');

    expect(found).toHaveLength(1);
  });

  it("seedProject / listProjects / getProject round-trip", async () => {
    const jira = new FakeJiraGateway();
    jira.seedProject({
      key: "KAN",
      name: "Kanban",
      issueTypes: [
        { name: "Task", subtask: false },
        { name: "Subtask", subtask: true },
      ],
    });

    const projects = await jira.listProjects();
    expect(projects).toEqual([{ key: "KAN", name: "Kanban" }]);

    const project = await jira.getProject("KAN");
    expect(project.issueTypes).toEqual([
      { name: "Task", subtask: false },
      { name: "Subtask", subtask: true },
    ]);
  });

  it("getIssueProperty returns null when unset, then reflects setIssueProperty", async () => {
    const jira = new FakeJiraGateway();

    expect(await jira.getIssueProperty("KAN-1", "ggjira.registration")).toBeNull();

    await jira.setIssueProperty("KAN-1", "ggjira.registration", { machineId: "m1" });

    expect(await jira.getIssueProperty("KAN-1", "ggjira.registration")).toEqual({
      machineId: "m1",
    });
  });

  it("setIssueProperty on one issue does not leak to another", async () => {
    const jira = new FakeJiraGateway();

    await jira.setIssueProperty("KAN-1", "ggjira.registration", { machineId: "m1" });

    expect(await jira.getIssueProperty("KAN-2", "ggjira.registration")).toBeNull();
  });

  it("getIssueChangelog is empty until a transition or seeded entry adds one", async () => {
    const jira = new FakeJiraGateway();
    jira.seedIssue({ key: "KAN-1", statusName: "To Do" }, [
      { id: "1", name: "Start", toStatusName: "In Progress" },
    ]);

    expect(await jira.getIssueChangelog("KAN-1")).toEqual([]);

    await jira.transitionIssue("KAN-1", "Start");

    const changelog = await jira.getIssueChangelog("KAN-1");
    expect(changelog).toHaveLength(1);
    expect(changelog[0]?.items).toEqual([
      { field: "status", fromString: "To Do", toString: "In Progress" },
    ]);
  });

  it("transitionIssueToStatus records a status changelog entry, but a no-op transition does not", async () => {
    const jira = new FakeJiraGateway();
    jira.seedIssue({ key: "KAN-1", statusName: "To Do" }, [
      { id: "1", name: "Start", toStatusName: "In Progress" },
    ]);

    await jira.transitionIssueToStatus("KAN-1", "In Progress");
    expect(await jira.getIssueChangelog("KAN-1")).toHaveLength(1);

    await jira.transitionIssueToStatus("KAN-1", "In Progress");
    expect(await jira.getIssueChangelog("KAN-1")).toHaveLength(1);
  });

  it("seedChangelogEntry lets a test inject history directly", async () => {
    const jira = new FakeJiraGateway();

    jira.seedChangelogEntry("KAN-1", {
      created: "2026-01-01T00:00:00.000Z",
      items: [{ field: "status", fromString: null, toString: "AI 작업 요청" }],
    });

    const changelog = await jira.getIssueChangelog("KAN-1");
    expect(changelog).toEqual([
      {
        id: expect.any(String),
        created: "2026-01-01T00:00:00.000Z",
        items: [{ field: "status", fromString: null, toString: "AI 작업 요청" }],
      },
    ]);
  });
});
