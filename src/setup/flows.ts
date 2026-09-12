import os from "node:os";
import { AGENT_ROLES, type AgentRole } from "../agent/role.js";
import {
  AppConfigSchema,
  type AppConfig,
  type JiraEnvSecrets,
  type JiraSecrets,
} from "../config.js";
import { JiraClient } from "../jira/client.js";
import type { JiraGateway } from "../jira/gateway.js";
import type { JiraProjectIssueType } from "../jira/types.js";
import { type Preset, PRESETS, findPreset } from "../profile/presets.js";
import {
  ProfileAlreadyRegisteredError,
  claimAgentProfile,
  createAgentProfile,
  findAgentProfileById,
  findAgentProfiles,
} from "../profile/profile.js";
import type { AgentProfile, WorkspaceWorkflow } from "../profile/types.js";
import { createWorkspaceConfig, findWorkspaceConfig } from "../profile/workspace.js";
import { GGJIRA_VERSION } from "../version.js";
import { SetupError, describeJiraError } from "./errors.js";
import {
  checkIsGitRepo,
  checkJiraConnection,
  checkProviderCommand,
  checkWorkspacePath,
} from "./validators.js";
import { writeConfigFile, writeEnvFile } from "./writers.js";

export type AskFn = (question: string, defaultValue?: string) => Promise<string>;

export interface SetupResult {
  startAgent: boolean;
}

/** Everything a flow needs, shared across Create/Join/Manual so none of them re-derive it. */
export interface FlowContext {
  ask: AskFn;
  askSecret: AskFn;
  print: (line: string) => void;
  configPath: string;
  envPath: string;
  createJira: (secrets: JiraSecrets) => JiraGateway;
  settleMs: number;
  machineIdFactory: () => string;
  existingConfig?: AppConfig;
  existingSecrets?: JiraEnvSecrets;
}

export function defaultCreateJira(secrets: JiraSecrets): JiraGateway {
  return new JiraClient(secrets);
}

export async function askChoice<T extends string>(
  ask: AskFn,
  label: string,
  choices: readonly T[],
  defaultValue: T,
): Promise<T> {
  const answer = (await ask(`${label} (${choices.join("/")})`, defaultValue)).trim();
  return (choices as readonly string[]).includes(answer) ? (answer as T) : defaultValue;
}

function isYes(answer: string): boolean {
  return answer.trim().toLowerCase().startsWith("y");
}

interface LocalSettings {
  workspacePath: string;
  baseBranch: string;
  providerType: "claude-code" | "codex";
  providerCommand: string;
  model: string;
}

const PROVIDER_TYPES = ["claude-code", "codex"] as const;

async function askLocalSettings(ctx: FlowContext): Promise<LocalSettings> {
  const workspacePath = await ctx.ask(
    "Workspace (target repo) path",
    ctx.existingConfig?.workspace.path,
  );
  const workspaceCheck = checkWorkspacePath(workspacePath);
  if (!workspaceCheck.ok) ctx.print(`  warning: ${workspaceCheck.message}`);
  else if (!(await checkIsGitRepo(workspacePath))) ctx.print("  warning: not a git repository");
  const baseBranch = await ctx.ask(
    "Base branch",
    ctx.existingConfig?.workspace.baseBranch ?? "main",
  );

  const providerType = await askChoice(
    ctx.ask,
    "Provider",
    PROVIDER_TYPES,
    ctx.existingConfig?.provider.type ?? "claude-code",
  );
  const providerCommand = providerType === "codex" ? "codex" : "claude";
  const providerCheck = await checkProviderCommand(providerCommand);
  if (!providerCheck.ok) {
    ctx.print(`  warning: could not run "${providerCommand} --version" (${providerCheck.message})`);
  }
  const model = await ctx.ask("Model", ctx.existingConfig?.provider.model ?? "sonnet");

  return { workspacePath, baseBranch, providerType, providerCommand, model };
}

async function askProject(
  ctx: FlowContext,
  jira: JiraGateway,
): Promise<{ key: string; issueTypes: JiraProjectIssueType[] }> {
  let projects: Array<{ key: string; name: string }> = [];
  try {
    projects = await jira.listProjects();
  } catch {
    // Some Jira setups restrict project/search; fall back to asking for the key directly.
  }
  if (projects.length > 0) {
    ctx.print("Projects:");
    for (const project of projects) ctx.print(`  ${project.key}  ${project.name}`);
  }
  const defaultKey =
    ctx.existingConfig?.jira.projectKey ?? (projects.length === 1 ? projects[0]?.key : undefined);
  const projectKey = await ctx.ask("Project key", defaultKey);

  try {
    const project = await jira.getProject(projectKey);
    return { key: project.key, issueTypes: project.issueTypes };
  } catch (error) {
    throw new SetupError(`Could not access project "${projectKey}": ${describeJiraError(error)}`);
  }
}

async function askIssueType(ctx: FlowContext, issueTypes: JiraProjectIssueType[]): Promise<string> {
  const nonSubtask = issueTypes.filter((t) => !t.subtask);
  if (nonSubtask.length > 0) {
    ctx.print(`Issue types in this project: ${nonSubtask.map((t) => t.name).join(", ")}`);
  }
  const defaultType =
    nonSubtask.find((t) => t.name.toLowerCase() === "task")?.name ?? nonSubtask[0]?.name ?? "Task";
  return ctx.ask(
    "Issue type for GGJira's own issues (Workspace Configuration, Agent Profiles)",
    defaultType,
  );
}

async function askPreset(ctx: FlowContext, role: AgentRole): Promise<Preset | undefined> {
  const candidates = PRESETS.filter((p) => p.role === role);
  ctx.print(`Presets: ${candidates.map((p) => p.id).join(", ")}`);
  const defaultId = candidates.find((p) => p.id === "general-programmer")?.id ?? candidates[0]?.id;
  const answer = await ctx.ask("Preset", defaultId);
  return findPreset(answer);
}

/** Claims a profile, prompting for a takeover confirmation if it's registered to a different machine. */
async function claimProfileWithTakeoverPrompt(
  ctx: FlowContext,
  jira: JiraGateway,
  profile: Pick<AgentProfile, "issueKey" | "agentId">,
  machineId: string,
): Promise<void> {
  try {
    await claimAgentProfile(jira, profile, machineId, { settleMs: ctx.settleMs });
  } catch (error) {
    if (!(error instanceof ProfileAlreadyRegisteredError)) throw error;
    ctx.print(
      `Agent Profile ${profile.issueKey} (${profile.agentId}) is already registered to another ` +
        `machine (registered ${error.existing.registeredAt}).`,
    );
    const answer = await ctx.ask("Take over this registration for this machine? (y/N)", "n");
    if (!isYes(answer)) {
      throw new SetupError(
        `Aborted: ${profile.issueKey} is already registered to another machine.`,
      );
    }
    await claimAgentProfile(jira, profile, machineId, { settleMs: ctx.settleMs, takeover: true });
  }
}

interface BuildProfileConfigInput {
  jiraBaseUrl: string;
  projectKey: string;
  workspaceIssueKey: string;
  profileKey: string;
  agentId: string;
  role: AgentRole;
  machineId: string;
  workflow: WorkspaceWorkflow;
  local: LocalSettings;
}

/** Assembles the raw (unresolved) config object written to ggjira.config.json for profile mode. */
function buildProfileConfig(input: BuildProfileConfigInput): Record<string, unknown> {
  return {
    configVersion: 4,
    jira: {
      baseUrl: input.jiraBaseUrl,
      projectKey: input.projectKey,
      workspaceIssueKey: input.workspaceIssueKey,
    },
    agent: {
      identity: input.agentId,
      role: input.role,
      machine: input.machineId.slice(0, 8),
      profileKey: input.profileKey,
      machineId: input.machineId,
      backends: ["filesystem", "git", "coding-runtime"],
    },
    workflow: {
      readyStatus: input.workflow.readyStatus,
      claimTransitionName: input.workflow.claimTransitionName,
      doneTransitionName: input.workflow.doneTransitionName,
      planningStatus: input.workflow.readyStatus,
      implementationStatus: "AI Implementation",
      ...(input.workflow.needsDecisionTransitionName
        ? { needsDecisionTransitionName: input.workflow.needsDecisionTransitionName }
        : {}),
      ...(input.workflow.plannedTransitionName
        ? { plannedTransitionName: input.workflow.plannedTransitionName }
        : {}),
    },
    workspace: { path: input.local.workspacePath, baseBranch: input.local.baseBranch },
    provider: {
      type: input.local.providerType,
      command: input.local.providerCommand,
      model: input.local.model,
    },
    pm: {
      subtaskIssueType: input.workflow.subtaskIssueType,
      ...(input.workflow.taskReadyTransitionName
        ? { taskReadyTransitionName: input.workflow.taskReadyTransitionName }
        : {}),
    },
    polling: { intervalMs: 60000 },
  };
}

function validateAndWrite(
  ctx: FlowContext,
  raw: Record<string, unknown>,
  secrets: { email: string; apiToken: string },
): void {
  const result = AppConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new SetupError(`Generated config failed validation: ${result.error.message}`);
  }
  writeEnvFile(ctx.envPath, secrets);
  writeConfigFile(ctx.configPath, raw);
  ctx.print(`\nWrote ${ctx.envPath} and ${ctx.configPath}.`);
}

/**
 * "Create GGJira Workspace" -- the first PM machine for a project
 * (advanced_plan.md §7). Finds or creates the project's Workspace
 * Configuration and a PM Agent Profile, registers this machine against it,
 * and optionally creates an (unregistered) implement Agent Profile other
 * machines can join.
 */
export async function runCreateWorkspaceFlow(ctx: FlowContext): Promise<SetupResult> {
  const { ask, askSecret, print } = ctx;

  const baseUrl = await ask(
    "Jira URL",
    ctx.existingConfig?.jira.baseUrl ?? "https://your-domain.atlassian.net",
  );
  const email = await ask("Jira account email", ctx.existingSecrets?.email);
  const apiToken = await askSecret("Jira API token", ctx.existingSecrets?.apiToken);

  print("Checking Jira connection...");
  const jira = ctx.createJira({ baseUrl, email, apiToken });
  const connection = await checkJiraConnection(jira);
  if (!connection.ok) throw new SetupError(`Could not connect to Jira: ${connection.message}`);
  print(`  ${connection.message}`);

  const { key: projectKey, issueTypes } = await askProject(ctx, jira);

  let workspace = await findWorkspaceConfig(jira, projectKey);
  if (workspace) {
    print(`Found an existing GGJira workspace: ${workspace.issueKey} -- reusing it.`);
  } else {
    print("No GGJira workspace found in this project yet. Let's create one.");
    const readyStatus = await ask(
      "Ready-to-claim Jira status",
      ctx.existingConfig?.workflow.readyStatus ?? "To Do",
    );
    const claimTransitionName = await ask(
      "Claim transition name",
      ctx.existingConfig?.workflow.claimTransitionName ?? "In Progress",
    );
    const doneTransitionName = await ask(
      "Done transition name",
      ctx.existingConfig?.workflow.doneTransitionName ?? "In Review",
    );
    const needsDecisionTransitionName = await ask(
      "Needs-decision transition name",
      ctx.existingConfig?.workflow.needsDecisionTransitionName ?? "Needs Decision",
    );
    const issueTypeName = await askIssueType(ctx, issueTypes);

    workspace = await createWorkspaceConfig(jira, {
      projectKey,
      configVersion: 4,
      ggjiraVersion: GGJIRA_VERSION,
      issueTypeName,
      workflow: {
        readyStatus,
        claimTransitionName,
        doneTransitionName,
        needsDecisionTransitionName,
        plannedTransitionName: "Plan Review",
        taskReadyTransitionName: null,
        subtaskIssueType: "Subtask",
      },
      projectPolicy: [],
    });
    print(`Created ${workspace.issueKey}.`);
  }

  const agentId = await ask(
    "Agent ID for this PM machine",
    ctx.existingConfig?.agent.profileKey ? ctx.existingConfig.agent.identity : "pm-01",
  );
  let profile = await findAgentProfileById(jira, projectKey, agentId);
  if (profile) {
    print(
      `Found an existing Agent Profile: ${profile.issueKey} (${profile.agentId}) -- reusing it.`,
    );
  } else {
    profile = await createAgentProfile(jira, {
      projectKey,
      issueTypeName: workspace.issueTypeName ?? "Task",
      agentId,
      displayName: agentId,
      role: "pm",
      preset: "pm",
      capabilities: [
        "planning",
        "task-decomposition",
        "dependency-analysis",
        "capability-analysis",
      ],
      workStyle: [],
      humanInstructions: [],
    });
    print(`Created Agent Profile ${profile.issueKey} (${profile.agentId}).`);
  }

  const machineId = ctx.existingConfig?.agent.machineId ?? ctx.machineIdFactory();
  await claimProfileWithTakeoverPrompt(ctx, jira, profile, machineId);

  const createImplementAnswer = await ask("Create an implement agent profile now? (y/N)", "n");
  if (isYes(createImplementAnswer)) {
    const implementId = await ask("Implement Agent ID", "implement-01");
    const preset = await askPreset(ctx, "implement");
    const implementProfile = await createAgentProfile(jira, {
      projectKey,
      issueTypeName: workspace.issueTypeName ?? "Task",
      agentId: implementId,
      displayName: implementId,
      role: "implement",
      preset: preset?.id ?? null,
      capabilities: ["programming", "testing", "review"],
      workStyle: [],
      humanInstructions: [],
    });
    print(
      `Created Agent Profile ${implementProfile.issueKey} (${implementProfile.agentId}). Join it from another machine with "ggjira" -> "Join as Agent".`,
    );
  }

  const local = await askLocalSettings(ctx);

  const raw = buildProfileConfig({
    jiraBaseUrl: baseUrl,
    projectKey,
    workspaceIssueKey: workspace.issueKey,
    profileKey: profile.issueKey,
    agentId: profile.agentId,
    role: "pm",
    machineId,
    workflow: workspace.workflow,
    local,
  });
  validateAndWrite(ctx, raw, { email, apiToken });

  print(`Setup complete. PM Agent "${profile.agentId}" registered (${profile.issueKey}).`);
  const startAnswer = await ask("Start the agent now? (Y/n)", "y");
  return { startAgent: !startAnswer.trim().toLowerCase().startsWith("n") };
}

function resolveAgentSelection(
  agents: AgentProfile[],
  selection: string,
): AgentProfile | undefined {
  const trimmed = selection.trim();
  const index = Number(trimmed);
  if (Number.isInteger(index) && index >= 1 && index <= agents.length) {
    return agents[index - 1];
  }
  return agents.find((a) => a.agentId === trimmed);
}

/**
 * "Join as Agent" -- registers this machine against an existing Agent
 * Profile a PM (or a human) already created in Jira (advanced_plan.md §8).
 */
export async function runJoinAgentFlow(ctx: FlowContext): Promise<SetupResult> {
  const { ask, askSecret, print } = ctx;

  const baseUrl = await ask(
    "Jira URL",
    ctx.existingConfig?.jira.baseUrl ?? "https://your-domain.atlassian.net",
  );
  const email = await ask("Jira account email", ctx.existingSecrets?.email);
  const apiToken = await askSecret("Jira API token", ctx.existingSecrets?.apiToken);

  print("Checking Jira connection...");
  const jira = ctx.createJira({ baseUrl, email, apiToken });
  const connection = await checkJiraConnection(jira);
  if (!connection.ok) throw new SetupError(`Could not connect to Jira: ${connection.message}`);
  print(`  ${connection.message}`);

  const { key: projectKey } = await askProject(ctx, jira);

  const workspace = await findWorkspaceConfig(jira, projectKey);
  if (!workspace) {
    throw new SetupError(
      `No GGJira workspace found in project ${projectKey}. Run "Create GGJira Workspace" on the PM machine first.`,
    );
  }

  const agents = await findAgentProfiles(jira, projectKey, { includeDisabled: false });
  if (agents.length === 0) {
    throw new SetupError(
      `No Agent Profiles found in project ${projectKey}. Ask the PM to create one first.`,
    );
  }

  print("Available agents:");
  agents.forEach((agent, index) => {
    const status = agent.registration
      ? `registered (machine ${agent.registration.machineId.slice(0, 8)})`
      : "unregistered";
    print(
      `  ${index + 1}. ${agent.agentId}  ${agent.role}  ${agent.preset ?? "(no preset)"}  ${status}`,
    );
  });

  const defaultSelection = ctx.existingConfig?.agent.profileKey
    ? agents.find((a) => a.issueKey === ctx.existingConfig?.agent.profileKey)?.agentId
    : undefined;
  const selection = await ask("Select an agent (number or agent ID)", defaultSelection);
  const profile = resolveAgentSelection(agents, selection);
  if (!profile) {
    throw new SetupError(`No agent matching "${selection}".`);
  }

  const machineId = ctx.existingConfig?.agent.machineId ?? ctx.machineIdFactory();
  await claimProfileWithTakeoverPrompt(ctx, jira, profile, machineId);

  const local = await askLocalSettings(ctx);

  const raw = buildProfileConfig({
    jiraBaseUrl: baseUrl,
    projectKey,
    workspaceIssueKey: workspace.issueKey,
    profileKey: profile.issueKey,
    agentId: profile.agentId,
    role: profile.role,
    machineId,
    workflow: workspace.workflow,
    local,
  });
  validateAndWrite(ctx, raw, { email, apiToken });

  print("Agent registered.");
  const startAnswer = await ask("Start the agent now? (Y/n)", "y");
  const startAgent = !startAnswer.trim().toLowerCase().startsWith("n");
  if (startAgent) print(`Starting ${profile.agentId}...`);
  return { startAgent };
}

/**
 * The original linear setup flow (pre-Agent-Profile): every value entered by
 * hand, no Jira issues created. Kept verbatim as "Manual setup (legacy)" so
 * existing installs and the constraint of not requiring a Jira Agent Profile
 * (advanced_plan.md's own §25 exclusions lean this direction for anyone who
 * doesn't want it) keep working exactly as before.
 */
export async function runManualFlow(ctx: FlowContext): Promise<SetupResult> {
  const { ask, askSecret, print } = ctx;

  const baseUrl = await ask(
    "Jira URL",
    ctx.existingConfig?.jira.baseUrl ?? "https://your-domain.atlassian.net",
  );
  const email = await ask("Jira account email", ctx.existingSecrets?.email);
  const apiToken = await askSecret("Jira API token", ctx.existingSecrets?.apiToken);

  print("Checking Jira connection...");
  const jira = ctx.createJira({ baseUrl, email, apiToken });
  const connection = await checkJiraConnection(jira);
  if (!connection.ok) {
    throw new SetupError(`Could not connect to Jira: ${connection.message}`);
  }
  print(`  ${connection.message}`);

  const identity = await ask(
    "Agent identity",
    ctx.existingConfig?.agent.identity ?? connection.self?.displayName ?? "ggjira-implement",
  );
  const role = await askChoice<AgentRole>(
    ask,
    "Role",
    AGENT_ROLES,
    ctx.existingConfig?.agent.role ?? "implement",
  );
  const machine = await ask("Machine name", ctx.existingConfig?.agent.machine ?? os.hostname());

  const workspacePath = await ask(
    "Workspace (target repo) path",
    ctx.existingConfig?.workspace.path,
  );
  const workspaceCheck = checkWorkspacePath(workspacePath);
  if (!workspaceCheck.ok) print(`  warning: ${workspaceCheck.message}`);
  else if (!(await checkIsGitRepo(workspacePath))) print("  warning: not a git repository");
  const baseBranch = await ask("Base branch", ctx.existingConfig?.workspace.baseBranch ?? "main");

  const providerType = await askChoice(
    ask,
    "Provider",
    PROVIDER_TYPES,
    ctx.existingConfig?.provider.type ?? "claude-code",
  );
  const providerCommand = providerType === "codex" ? "codex" : "claude";
  const providerCheck = await checkProviderCommand(providerCommand);
  if (!providerCheck.ok) {
    print(`  warning: could not run "${providerCommand} --version" (${providerCheck.message})`);
  }
  const model = await ask("Model", ctx.existingConfig?.provider.model ?? "sonnet");

  // Defaults match GGJIRA's own suggested Jira workflow (README "Jira 준비"):
  // create a board with these exact status/transition names, or override
  // them here to match an existing board.
  const readyStatus = await ask(
    "Ready-to-claim Jira status",
    ctx.existingConfig?.workflow.readyStatus ?? "To Do",
  );
  const claimTransitionName = await ask(
    "Claim transition name",
    ctx.existingConfig?.workflow.claimTransitionName ?? "In Progress",
  );
  const doneTransitionName = await ask(
    "Done transition name",
    ctx.existingConfig?.workflow.doneTransitionName ?? "In Review",
  );

  let needsDecisionTransitionName: string | undefined;
  let implementAssignee: string | undefined;
  if (role === "pm") {
    needsDecisionTransitionName = await ask(
      "Needs-decision transition name",
      ctx.existingConfig?.workflow.needsDecisionTransitionName ?? "Needs Decision",
    );
    implementAssignee = await ask(
      "Implement agent's Jira email (assignee for generated subtasks)",
      ctx.existingConfig?.pm.implementAssignee,
    );
  }

  const raw = {
    jira: { baseUrl },
    agent: { identity, role, machine },
    workflow: {
      readyStatus,
      claimTransitionName,
      doneTransitionName,
      ...(needsDecisionTransitionName ? { needsDecisionTransitionName } : {}),
    },
    workspace: { path: workspacePath, baseBranch },
    provider: { type: providerType, command: providerCommand, model },
    pm: implementAssignee ? { implementAssignee } : {},
    polling: { intervalMs: 60000 },
  };

  validateAndWrite(ctx, raw, { email, apiToken });
  print(
    'Run "ggjira once" to try a single poll cycle, or "ggjira setup --check" to re-validate later.',
  );

  return { startAgent: false };
}
