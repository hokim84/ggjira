import { type AppConfig, isProfileMode } from "../config.js";
import type { JiraGateway } from "../jira/gateway.js";
import type { Logger } from "../logger.js";
import type { Preset } from "../profile/presets.js";
import { findPreset } from "../profile/presets.js";
import { getRegistration, parseAgentProfile } from "../profile/profile.js";
import type { AgentProfile, WorkspaceConfig } from "../profile/types.js";
import { findWorkspaceConfig } from "../profile/workspace.js";

export interface AgentContext {
  profile: AgentProfile;
  workspace: WorkspaceConfig | null;
  preset: Preset | null;
}

export class AgentRegistrationMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentRegistrationMismatchError";
  }
}

/**
 * Loads this machine's Agent Profile and the project's Workspace
 * Configuration from Jira. Returns undefined in legacy mode (no
 * agent.profileKey/machineId/jira.projectKey configured) -- callers treat
 * that as "no prompt composition, no roster", matching the pre-profile
 * behavior exactly.
 */
export async function loadAgentContext(
  jira: JiraGateway,
  config: AppConfig,
  logger?: Logger,
): Promise<AgentContext | undefined> {
  if (!isProfileMode(config)) return undefined;

  const issue = await jira.getIssue(config.agent.profileKey);
  const registration = await getRegistration(jira, config.agent.profileKey);
  const profile = parseAgentProfile(issue, registration);
  const workspace = await findWorkspaceConfig(
    jira,
    config.jira.projectKey,
    logger ? { logger } : {},
  );

  return { profile, workspace, preset: findPreset(profile.preset) ?? null };
}

/**
 * Verifies a freshly-loaded profile still belongs to this machine and role.
 * Called once at bootstrap; a mismatch means someone re-joined this profile
 * from another machine, or its Role was edited in Jira -- a configuration
 * problem to surface immediately, not a transient claim race.
 */
export function verifyRegistration(ctx: AgentContext, config: AppConfig): void {
  if (!isProfileMode(config)) return;

  const { profile } = ctx;
  if (!profile.registration || profile.registration.machineId !== config.agent.machineId) {
    throw new AgentRegistrationMismatchError(
      `Agent profile ${profile.issueKey} is not registered to this machine. Run "ggjira setup" to re-join.`,
    );
  }
  if (profile.role !== config.agent.role) {
    throw new AgentRegistrationMismatchError(
      `Agent profile ${profile.issueKey} has role "${profile.role}" in Jira but this machine is ` +
        `configured as "${config.agent.role}". Update one to match.`,
    );
  }
}
