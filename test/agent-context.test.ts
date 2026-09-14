import { describe, expect, it } from "vitest";
import {
  AgentRegistrationMismatchError,
  loadAgentContext,
  verifyRegistration,
} from "../src/agent/context.js";
import { FakeJiraGateway } from "../src/jira/fake.js";
import { claimAgentProfile, createAgentProfile } from "../src/profile/profile.js";
import type { AgentProfileInput } from "../src/profile/types.js";
import { createWorkspaceConfig } from "../src/profile/workspace.js";
import { buildProfileModeConfig, buildTestConfig } from "./helpers/fixtures.js";

const profileInput: AgentProfileInput & { projectKey: string; issueTypeName: string } = {
  projectKey: "KAN",
  issueTypeName: "Task",
  agentId: "unity-implement-01",
  displayName: "Unity Implement 01",
  role: "implement",
  preset: "unity-programmer",
  capabilities: ["Unity"],
  workStyle: [],
  humanInstructions: ["favor maintainability"],
};

const workspaceInput = {
  projectKey: "KAN",
  configVersion: 3,
  ggjiraVersion: "0.1.0",
  issueTypeName: "Task",
  workflow: {
    implementationStatus: "AI Implementation",
    inProgressStatus: "In Progress",
    reviewStatus: "In Review",
    subtaskIssueType: "Subtask",
  },
  projectPolicy: [],
};

describe("loadAgentContext", () => {
  it("returns undefined in legacy mode (no profileKey/machineId/projectKey configured)", async () => {
    const jira = new FakeJiraGateway();
    const config = buildTestConfig();

    expect(await loadAgentContext(jira, config)).toBeUndefined();
  });

  it("loads profile + workspace + preset in profile mode", async () => {
    const jira = new FakeJiraGateway();
    jira.setSelf({ accountId: "acc-1", displayName: "Test", emailAddress: null });
    const profile = await createAgentProfile(jira, profileInput);
    await createWorkspaceConfig(jira, workspaceInput);
    await claimAgentProfile(jira, profile, "1d88f0a2-1111-4111-8111-111111111111", {
      settleMs: 0,
    });
    const baseAgent = buildProfileModeConfig().agent;
    const config = buildProfileModeConfig({
      agent: { ...baseAgent, profileKey: profile.issueKey },
    });

    const ctx = await loadAgentContext(jira, config);

    expect(ctx?.profile.agentId).toBe("unity-implement-01");
    expect(ctx?.workspace?.projectKey).toBe("KAN");
    expect(ctx?.preset?.id).toBe("unity-programmer");
  });
});

describe("verifyRegistration", () => {
  it("is a no-op in legacy mode", () => {
    const config = buildTestConfig();
    expect(() =>
      verifyRegistration(
        {
          profile: {
            issueKey: "KAN-11",
            agentId: "x",
            displayName: "x",
            role: "implement",
            preset: null,
            capabilities: [],
            workStyle: [],
            humanInstructions: [],
            enabled: true,
            registration: null,
          },
          workspace: null,
          preset: null,
        },
        config,
      ),
    ).not.toThrow();
  });

  it("throws when the profile is unregistered", () => {
    const config = buildProfileModeConfig();
    expect(() =>
      verifyRegistration(
        {
          profile: {
            issueKey: "KAN-11",
            agentId: "x",
            displayName: "x",
            role: "implement",
            preset: null,
            capabilities: [],
            workStyle: [],
            humanInstructions: [],
            enabled: true,
            registration: null,
          },
          workspace: null,
          preset: null,
        },
        config,
      ),
    ).toThrow(AgentRegistrationMismatchError);
  });

  it("throws when the profile is registered to a different machine", () => {
    const config = buildProfileModeConfig();
    expect(() =>
      verifyRegistration(
        {
          profile: {
            issueKey: "KAN-11",
            agentId: "x",
            displayName: "x",
            role: "implement",
            preset: null,
            capabilities: [],
            workStyle: [],
            humanInstructions: [],
            enabled: true,
            registration: {
              machineId: "some-other-machine",
              agentId: "x",
              jiraAccountId: "acc-1",
              registeredAt: new Date().toISOString(),
              claimToken: "t",
              ggjiraVersion: "0.1.0",
            },
          },
          workspace: null,
          preset: null,
        },
        config,
      ),
    ).toThrow(AgentRegistrationMismatchError);
  });

  it("throws when the profile's Role doesn't match the local config's role", () => {
    const config = buildProfileModeConfig({
      agent: { ...buildProfileModeConfig().agent, role: "pm" },
    });
    expect(() =>
      verifyRegistration(
        {
          profile: {
            issueKey: "KAN-11",
            agentId: "x",
            displayName: "x",
            role: "implement",
            preset: null,
            capabilities: [],
            workStyle: [],
            humanInstructions: [],
            enabled: true,
            registration: {
              machineId: config.agent.machineId as string,
              agentId: "x",
              jiraAccountId: "acc-1",
              registeredAt: new Date().toISOString(),
              claimToken: "t",
              ggjiraVersion: "0.1.0",
            },
          },
          workspace: null,
          preset: null,
        },
        config,
      ),
    ).toThrow(AgentRegistrationMismatchError);
  });

  it("does not throw when the profile is registered to this machine and roles match", () => {
    const config = buildProfileModeConfig();
    expect(() =>
      verifyRegistration(
        {
          profile: {
            issueKey: "KAN-11",
            agentId: "x",
            displayName: "x",
            role: "implement",
            preset: null,
            capabilities: [],
            workStyle: [],
            humanInstructions: [],
            enabled: true,
            registration: {
              machineId: config.agent.machineId as string,
              agentId: "x",
              jiraAccountId: "acc-1",
              registeredAt: new Date().toISOString(),
              claimToken: "t",
              ggjiraVersion: "0.1.0",
            },
          },
          workspace: null,
          preset: null,
        },
        config,
      ),
    ).not.toThrow();
  });
});
