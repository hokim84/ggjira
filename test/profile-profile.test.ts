import { describe, expect, it } from "vitest";
import { FakeJiraGateway } from "../src/jira/fake.js";
import {
  InvalidProfileError,
  ProfileAlreadyRegisteredError,
  ProfileClaimLostError,
  agentProfileSummary,
  claimAgentProfile,
  createAgentProfile,
  disableAgentProfile,
  findAgentProfileById,
  findAgentProfiles,
  getRegistration,
  parseAgentProfile,
} from "../src/profile/profile.js";
import { AGENT_LABEL } from "../src/profile/types.js";
import type { AgentProfileInput } from "../src/profile/types.js";

const baseInput: AgentProfileInput & { projectKey: string; issueTypeName: string } = {
  projectKey: "KAN",
  issueTypeName: "Task",
  agentId: "unity-implement-01",
  displayName: "Unity Implement 01",
  role: "implement",
  preset: "unity-programmer",
  capabilities: ["Unity", "C#"],
  workStyle: ["prefer small diffs"],
  humanInstructions: ["favor maintainability"],
};

describe("createAgentProfile / findAgentProfiles / findAgentProfileById", () => {
  it("creates a labeled, unassigned profile issue", async () => {
    const jira = new FakeJiraGateway();

    const created = await createAgentProfile(jira, baseInput);

    expect(jira.createdIssues[0]?.summary).toBe(agentProfileSummary("unity-implement-01"));
    expect(jira.createdIssues[0]?.labels).toEqual([AGENT_LABEL]);
    expect(jira.assignments).toEqual([{ key: created.issueKey, accountId: null }]);
    expect(created.enabled).toBe(true);
    expect(created.registration).toBeNull();
  });

  it("finds a created profile via findAgentProfileById", async () => {
    const jira = new FakeJiraGateway();
    await createAgentProfile(jira, baseInput);

    const found = await findAgentProfileById(jira, "KAN", "unity-implement-01");

    expect(found?.displayName).toBe("Unity Implement 01");
    expect(found?.capabilities).toEqual(["Unity", "C#"]);
  });

  it("returns null from findAgentProfileById when no such agentId exists", async () => {
    const jira = new FakeJiraGateway();
    expect(await findAgentProfileById(jira, "KAN", "nonexistent")).toBeNull();
  });

  it("excludes disabled profiles when includeDisabled is false", async () => {
    const jira = new FakeJiraGateway();
    const profile = await createAgentProfile(jira, baseInput);
    await disableAgentProfile(jira, profile);

    const all = await findAgentProfiles(jira, "KAN");
    const enabledOnly = await findAgentProfiles(jira, "KAN", { includeDisabled: false });

    expect(all).toHaveLength(1);
    expect(enabledOnly).toHaveLength(0);
  });

  it("reflects a human's edit to the description on the next parse", async () => {
    const jira = new FakeJiraGateway();
    const profile = await createAgentProfile(jira, baseInput);
    const issue = await jira.getIssue(profile.issueKey);

    const edited = issue.description?.replace(
      "* favor maintainability",
      "* favor maintainability\n* record architecture decisions in Jira",
    );
    jira.seedIssue({ ...issue, description: edited ?? null });

    const found = await findAgentProfileById(jira, "KAN", "unity-implement-01");

    expect(found?.humanInstructions).toEqual([
      "favor maintainability",
      "record architecture decisions in Jira",
    ]);
  });

  it("throws InvalidProfileError when the summary is not in [AGENT] <id> form", () => {
    const badIssue = {
      key: "KAN-1",
      id: "1",
      summary: "Not an agent profile",
      description: "h2. Agent Profile\nRole: implement",
      statusName: "To Do",
      labels: [AGENT_LABEL],
      assigneeAccountId: null,
      issueTypeName: "Task",
      parentKey: null,
      projectKey: "KAN",
    };

    expect(() => parseAgentProfile(badIssue, null)).toThrow(InvalidProfileError);
  });
});

describe("claimAgentProfile", () => {
  const settleMs = 0;

  it("claims an unregistered profile, writing the property and posting a comment", async () => {
    const jira = new FakeJiraGateway();
    const profile = await createAgentProfile(jira, baseInput);

    const result = await claimAgentProfile(jira, profile, "machine-a", { settleMs });

    expect(result.outcome).toBe("claimed");
    expect(result.registration.machineId).toBe("machine-a");
    const stored = await getRegistration(jira, profile.issueKey);
    expect(stored).toEqual(result.registration);
    expect(jira.comments).toHaveLength(1);
    expect(jira.comments[0]?.body).toContain("GGJIRA agent registered");
  });

  it("re-claiming from the same machine is idempotent and posts no extra comment", async () => {
    const jira = new FakeJiraGateway();
    const profile = await createAgentProfile(jira, baseInput);
    await claimAgentProfile(jira, profile, "machine-a", { settleMs });

    const result = await claimAgentProfile(jira, profile, "machine-a", { settleMs });

    expect(result.outcome).toBe("reclaimed");
    expect(jira.comments).toHaveLength(1);
  });

  it("refuses to claim a profile already registered to a different machine", async () => {
    const jira = new FakeJiraGateway();
    const profile = await createAgentProfile(jira, baseInput);
    await claimAgentProfile(jira, profile, "machine-a", { settleMs });

    await expect(claimAgentProfile(jira, profile, "machine-b", { settleMs })).rejects.toThrow(
      ProfileAlreadyRegisteredError,
    );
  });

  it("takeover: true lets a different machine force-claim", async () => {
    const jira = new FakeJiraGateway();
    const profile = await createAgentProfile(jira, baseInput);
    await claimAgentProfile(jira, profile, "machine-a", { settleMs });

    const result = await claimAgentProfile(jira, profile, "machine-b", {
      settleMs,
      takeover: true,
    });

    expect(result.outcome).toBe("taken_over");
    expect(result.registration.machineId).toBe("machine-b");
    expect(jira.comments).toHaveLength(2);
  });

  it("throws ProfileClaimLostError when another machine's claim wins the settle race", async () => {
    const jira = new FakeJiraGateway();
    const profile = await createAgentProfile(jira, baseInput);

    class RacyGateway extends FakeJiraGateway {
      async setIssueProperty(key: string, propertyKey: string, value: unknown): Promise<void> {
        await super.setIssueProperty(key, propertyKey, value);
        // Simulate a competing machine's write landing right after ours,
        // before we re-read to confirm.
        await super.setIssueProperty(key, propertyKey, {
          ...(value as Record<string, unknown>),
          machineId: "machine-c",
          claimToken: "someone-elses-token",
        });
      }
    }
    const racyJira = new RacyGateway();
    const created = await createAgentProfile(racyJira, baseInput);

    await expect(claimAgentProfile(racyJira, created, "machine-a", { settleMs })).rejects.toThrow(
      ProfileClaimLostError,
    );
  });
});
