import type { AgentRole } from "../agent/role.js";

/** Label identifying an issue as a GGJIRA Agent Profile (`[AGENT] <agentId>`). */
export const AGENT_LABEL = "ggjira-agent";
/** Label identifying an issue as the project's `[GGJIRA] Workspace Configuration`. */
export const WORKSPACE_LABEL = "ggjira-workspace";
/** Presence on an Agent Profile issue means the agent is disabled (independent of registration). */
export const DISABLED_LABEL = "ggjira-disabled";
/** Jira entity property key holding an Agent Profile's machine registration (JSON, never secrets). */
export const REGISTRATION_PROPERTY = "ggjira.registration";

/** Machine-only registration record stored as a Jira issue property, never edited by hand. */
export interface AgentRegistration {
  machineId: string;
  agentId: string;
  jiraAccountId: string;
  registeredAt: string;
  claimToken: string;
  ggjiraVersion: string;
}

/** A parsed `[AGENT] <agentId>` issue: human-edited description + machine-only registration. */
export interface AgentProfile {
  issueKey: string;
  agentId: string;
  displayName: string;
  role: AgentRole;
  /** presets.ts id, or null when unset or unrecognized (a warning, not an error). */
  preset: string | null;
  capabilities: string[];
  workStyle: string[];
  humanInstructions: string[];
  /** false when the issue carries the ggjira-disabled label. */
  enabled: boolean;
  registration: AgentRegistration | null;
}

/** Fields a caller supplies to render or create an Agent Profile description. */
export interface AgentProfileInput {
  agentId: string;
  displayName: string;
  role: AgentRole;
  preset: string | null;
  capabilities: string[];
  workStyle: string[];
  humanInstructions: string[];
}

export interface WorkspaceWorkflow {
  readyStatus: string;
  claimTransitionName: string;
  doneTransitionName: string;
  needsDecisionTransitionName: string | null;
  plannedTransitionName: string | null;
  taskReadyTransitionName: string | null;
  subtaskIssueType: string;
}

/** A parsed `[GGJIRA] Workspace Configuration` issue: the project's shared, human-editable settings. */
export interface WorkspaceConfig {
  issueKey: string;
  /** The issue type Agent Profiles should be created as in this project (from setup's issue-type prompt). */
  issueTypeName: string | null;
  projectKey: string;
  configVersion: number;
  workflow: WorkspaceWorkflow;
  /** Free-text project policy bullet items, rendered into the prompt composition layer. */
  projectPolicy: string[];
}

export interface WorkspaceConfigInput {
  projectKey: string;
  configVersion: number;
  ggjiraVersion: string;
  workflow: WorkspaceWorkflow;
  projectPolicy: string[];
}
