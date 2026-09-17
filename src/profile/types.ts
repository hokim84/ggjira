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

/**
 * The project's shared workflow, expressed entirely as board statuses
 * (ADR 0015): a human moves an issue to `implementationStatus`, the agent
 * moves it to `inProgressStatus` while working and to `reviewStatus` when
 * done. Transition names are resolved at run time, never stored.
 */
export interface WorkspaceWorkflow {
  implementationStatus: string;
  inProgressStatus: string;
  reviewStatus: string;
  /**
   * PM only, opt-in: setup doesn't ask, so this is set by editing the Jira issue (or by setup
   * option 5 once human distribution is enabled). Its in-progress/review points reuse
   * inProgressStatus/reviewStatus above -- planning and implementation never need telling apart
   * by status once routing has already happened (ADR 0017).
   */
  planningStatus?: string | null;
  needsDecisionStatus?: string | null;
  subtaskIssueType: string;
}

/**
 * Shared human-approved PM distribution settings (setup option 5). Deliberately excludes
 * `executionAgentOptionId`: that identifies one specific implement machine, so it's asked and
 * stored locally per machine, never centralized here (README §Human-approved PM distribution).
 */
export interface WorkspaceDistribution {
  enabled: boolean;
  executionAgentFieldId?: string | null;
  workspaceId?: string | null;
}

/** A parsed `[GGJIRA] Workspace Configuration` issue: the project's shared, human-editable settings. */
export interface WorkspaceConfig {
  issueKey: string;
  /** The issue type Agent Profiles should be created as in this project (from setup's issue-type prompt). */
  issueTypeName: string | null;
  projectKey: string;
  configVersion: number;
  workflow: WorkspaceWorkflow;
  distribution?: WorkspaceDistribution;
  /** Free-text project policy bullet items, rendered into the prompt composition layer. */
  projectPolicy: string[];
}

export interface WorkspaceConfigInput {
  projectKey: string;
  configVersion: number;
  ggjiraVersion: string;
  workflow: WorkspaceWorkflow;
  distribution?: WorkspaceDistribution;
  projectPolicy: string[];
}
