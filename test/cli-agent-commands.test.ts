import { describe, expect, it } from "vitest";
import { FakeJiraGateway } from "../src/jira/fake.js";
import {
  createAgentCommand,
  disableAgentCommand,
  listAgentsCommand,
} from "../src/profile/commands.js";
import { createAgentProfile } from "../src/profile/profile.js";

describe("listAgentsCommand", () => {
  it("prints a message when no agents exist", async () => {
    const jira = new FakeJiraGateway();
    const lines: string[] = [];

    await listAgentsCommand(jira, "KAN", (l) => lines.push(l));

    expect(lines).toEqual(["No Agent Profiles found in this project."]);
  });

  it("lists each agent with its role, preset, status, and issue key", async () => {
    const jira = new FakeJiraGateway();
    await createAgentProfile(jira, {
      projectKey: "KAN",
      issueTypeName: "Task",
      agentId: "unity-implement-01",
      displayName: "Unity Implement 01",
      role: "implement",
      preset: "unity-programmer",
      capabilities: [],
      workStyle: [],
      humanInstructions: [],
    });
    const lines: string[] = [];

    await listAgentsCommand(jira, "KAN", (l) => lines.push(l));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("unity-implement-01");
    expect(lines[0]).toContain("implement");
    expect(lines[0]).toContain("unity-programmer");
    expect(lines[0]).toContain("unregistered");
  });
});

describe("createAgentCommand", () => {
  it("creates a new agent profile", async () => {
    const jira = new FakeJiraGateway();
    const lines: string[] = [];

    await createAgentCommand(
      jira,
      "KAN",
      "Task",
      "backend-01",
      { role: "implement", preset: "backend-programmer" },
      (l) => lines.push(l),
    );

    expect(jira.createdIssues[0]?.summary).toBe("[AGENT] backend-01");
    expect(lines[0]).toContain("Created Agent Profile");
  });

  it("does not create a duplicate when the agentId already exists", async () => {
    const jira = new FakeJiraGateway();
    await createAgentProfile(jira, {
      projectKey: "KAN",
      issueTypeName: "Task",
      agentId: "backend-01",
      displayName: "backend-01",
      role: "implement",
      preset: null,
      capabilities: [],
      workStyle: [],
      humanInstructions: [],
    });
    const lines: string[] = [];

    await createAgentCommand(jira, "KAN", "Task", "backend-01", { role: "implement" }, (l) =>
      lines.push(l),
    );

    expect(jira.createdIssues).toHaveLength(1);
    expect(lines[0]).toContain("already exists");
  });
});

describe("disableAgentCommand", () => {
  it("adds the ggjira-disabled label to the matching agent", async () => {
    const jira = new FakeJiraGateway();
    const profile = await createAgentProfile(jira, {
      projectKey: "KAN",
      issueTypeName: "Task",
      agentId: "backend-01",
      displayName: "backend-01",
      role: "implement",
      preset: null,
      capabilities: [],
      workStyle: [],
      humanInstructions: [],
    });
    const lines: string[] = [];

    await disableAgentCommand(jira, "KAN", "backend-01", (l) => lines.push(l));

    expect(jira.labelChanges).toContainEqual({
      key: profile.issueKey,
      label: "ggjira-disabled",
      action: "add",
    });
    expect(lines[0]).toContain("Disabled");
  });

  it("reports a clear message when the agentId doesn't exist", async () => {
    const jira = new FakeJiraGateway();
    const lines: string[] = [];

    await disableAgentCommand(jira, "KAN", "nonexistent", (l) => lines.push(l));

    expect(lines[0]).toContain("No Agent Profile found");
    expect(jira.labelChanges).toEqual([]);
  });
});
