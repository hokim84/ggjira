import type { AgentRole } from "../agent/role.js";
import type { JiraGateway } from "../jira/gateway.js";
import { findPreset } from "./presets.js";
import {
  createAgentProfile,
  disableAgentProfile,
  findAgentProfileById,
  findAgentProfiles,
} from "./profile.js";

/**
 * Human-facing Agent Profile commands (`ggjira agent:list/create/disable`),
 * kept as pure functions over a JiraGateway so they're testable with
 * FakeJiraGateway -- cli.ts only handles argv parsing and building the real
 * JiraClient.
 */
export async function listAgentsCommand(
  jira: JiraGateway,
  projectKey: string,
  print: (line: string) => void,
): Promise<void> {
  const agents = await findAgentProfiles(jira, projectKey);
  if (agents.length === 0) {
    print("No Agent Profiles found in this project.");
    return;
  }
  for (const agent of agents) {
    const status = !agent.enabled
      ? "disabled"
      : agent.registration
        ? `registered (machine ${agent.registration.machineId.slice(0, 8)})`
        : "unregistered";
    print(
      `${agent.agentId}  ${agent.role}  ${agent.preset ?? "(no preset)"}  ${status}  ${agent.issueKey}`,
    );
  }
}

export interface CreateAgentCommandOptions {
  role: AgentRole;
  preset?: string;
  display?: string;
}

export async function createAgentCommand(
  jira: JiraGateway,
  projectKey: string,
  issueTypeName: string,
  agentId: string,
  opts: CreateAgentCommandOptions,
  print: (line: string) => void,
): Promise<void> {
  const existing = await findAgentProfileById(jira, projectKey, agentId);
  if (existing) {
    print(`Agent Profile "${agentId}" already exists: ${existing.issueKey}`);
    return;
  }
  const preset = opts.preset ? findPreset(opts.preset) : undefined;
  const created = await createAgentProfile(jira, {
    projectKey,
    issueTypeName,
    agentId,
    displayName: opts.display ?? agentId,
    role: opts.role,
    preset: preset?.id ?? opts.preset ?? null,
    capabilities: [],
    workStyle: [],
    humanInstructions: [],
  });
  print(`Created Agent Profile ${created.issueKey} (${created.agentId}).`);
}

export async function disableAgentCommand(
  jira: JiraGateway,
  projectKey: string,
  agentId: string,
  print: (line: string) => void,
): Promise<void> {
  const existing = await findAgentProfileById(jira, projectKey, agentId);
  if (!existing) {
    print(`No Agent Profile found for agentId "${agentId}".`);
    return;
  }
  await disableAgentProfile(jira, existing);
  print(`Disabled ${existing.issueKey} (${agentId}).`);
}
