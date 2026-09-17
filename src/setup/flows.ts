import os from "node:os";
import { AGENT_ROLES, type AgentRole } from "../agent/role.js";
import {
  type AppConfig,
  AppConfigSchema,
  type JiraEnvSecrets,
  type JiraSecrets,
} from "../config.js";
import { JiraClient } from "../jira/client.js";
import type { JiraGateway } from "../jira/gateway.js";
import type { JiraProjectIssueType, JiraTransition } from "../jira/types.js";
import { PRESETS, type Preset, findPreset } from "../profile/presets.js";
import {
  ProfileAlreadyRegisteredError,
  claimAgentProfile,
  createAgentProfile,
  findAgentProfileById,
  findAgentProfiles,
} from "../profile/profile.js";
import type { AgentProfile, WorkspaceDistribution, WorkspaceWorkflow } from "../profile/types.js";
import {
  createWorkspaceConfig,
  findWorkspaceConfig,
  updateWorkspaceConfig,
} from "../profile/workspace.js";
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
  existingRawConfig?: Record<string, unknown>;
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

/** Prints the project's real Jira statuses as a numbered list, for the status prompts to pick from. */
async function listStatuses(
  ctx: FlowContext,
  jira: JiraGateway,
  projectKey: string,
): Promise<string[]> {
  let statuses: string[] = [];
  try {
    statuses = await jira.listProjectStatuses(projectKey);
  } catch (error) {
    ctx.print(
      `Could not list Jira statuses (${describeJiraError(error)}). Type the status names instead.`,
    );
    return [];
  }
  if (statuses.length > 0) {
    ctx.print(`\nJira statuses in ${projectKey}:`);
    statuses.forEach((status, index) => ctx.print(`  ${index + 1}. ${status}`));
  }
  return statuses;
}

/** Accepts a number from the printed list or the status name itself, and rejects anything else. */
async function askStatus(
  ctx: FlowContext,
  statuses: string[],
  label: string,
  defaultStatus: string | undefined,
): Promise<string> {
  const answer = (await ctx.ask(label, defaultStatus)).trim();
  if (!answer) throw new SetupError(`${label} is required.`);
  const index = Number(answer);
  const picked =
    Number.isInteger(index) && index >= 1 && index <= statuses.length
      ? (statuses[index - 1] as string)
      : answer;
  if (statuses.length > 0 && !statuses.includes(picked)) {
    throw new SetupError(
      `"${picked}" is not a status in this project. Pick one of: ${statuses.join(", ")}.`,
    );
  }
  return picked;
}

export interface WorkflowStatuses {
  implementationStatus: string;
  inProgressStatus: string;
  reviewStatus: string;
}

/**
 * The whole workflow setup: the three board statuses of the AI loop
 * (ADR 0015). Transition names are never asked for -- the runtime resolves
 * the transition that reaches each status when it moves an issue, so a
 * project's transition labels (in any language) can't drift out of the config.
 */
async function askWorkflowStatuses(
  ctx: FlowContext,
  jira: JiraGateway,
  projectKey: string,
  defaults: { [K in keyof WorkflowStatuses]?: string | null | undefined },
): Promise<WorkflowStatuses> {
  const statuses = await listStatuses(ctx, jira, projectKey);
  ctx.print(
    "\nPick the three statuses of the AI loop (enter a number or the status name):\n" +
      "  human moves an issue here -> agent works here -> agent leaves it here for review",
  );
  const implementationStatus = await askStatus(
    ctx,
    statuses,
    "1) AI request status (a human moves an issue here to start the agent)",
    defaults.implementationStatus ?? "AI Implementation",
  );
  const inProgressStatus = await askStatus(
    ctx,
    statuses,
    "2) In-progress status (the agent moves it here while working)",
    defaults.inProgressStatus ?? "In Progress",
  );
  const reviewStatus = await askStatus(
    ctx,
    statuses,
    "3) Review status (the agent moves it here when implementation is done)",
    defaults.reviewStatus ?? "In Review",
  );
  const picked = [implementationStatus, inProgressStatus, reviewStatus];
  if (new Set(picked).size !== picked.length) {
    throw new SetupError(
      `The three statuses must be different from each other (got: ${picked.join(", ")}).`,
    );
  }
  return { implementationStatus, inProgressStatus, reviewStatus };
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SetupError(`${label} is missing or invalid in ggjira.config.json.`);
  }
  return value as Record<string, unknown>;
}

/** Updates only the polling interval and the three v4 workflow statuses. */
export async function runWorkflowSettingsFlow(ctx: FlowContext): Promise<SetupResult> {
  const raw = ctx.existingRawConfig;
  const secrets = ctx.existingSecrets;
  if (!raw) throw new SetupError("No existing ggjira.config.json found. Run full setup first.");
  if (!secrets)
    throw new SetupError("No valid Jira credentials found in .env. Run full setup first.");

  const jiraConfig = requireObject(raw.jira, "jira");
  const workflow =
    raw.workflow && typeof raw.workflow === "object" && !Array.isArray(raw.workflow)
      ? (raw.workflow as Record<string, unknown>)
      : {};
  const polling =
    raw.polling && typeof raw.polling === "object" && !Array.isArray(raw.polling)
      ? (raw.polling as Record<string, unknown>)
      : {};
  const baseUrl = jiraConfig.baseUrl;
  const projectKey = jiraConfig.projectKey;
  if (typeof baseUrl !== "string" || !baseUrl) {
    throw new SetupError("jira.baseUrl is missing or invalid in ggjira.config.json.");
  }
  if (typeof projectKey !== "string" || !projectKey) {
    throw new SetupError("jira.projectKey is missing or invalid in ggjira.config.json.");
  }

  ctx.print("Checking Jira connection...");
  const jira = ctx.createJira({ baseUrl, email: secrets.email, apiToken: secrets.apiToken });
  const connection = await checkJiraConnection(jira);
  if (!connection.ok) throw new SetupError(`Could not connect to Jira: ${connection.message}`);
  ctx.print(`  ${connection.message}`);

  const statuses = await askWorkflowStatuses(ctx, jira, projectKey, {
    implementationStatus:
      typeof workflow.implementationStatus === "string" ? workflow.implementationStatus : undefined,
    inProgressStatus:
      typeof workflow.inProgressStatus === "string" ? workflow.inProgressStatus : undefined,
    reviewStatus: typeof workflow.reviewStatus === "string" ? workflow.reviewStatus : undefined,
  });

  const currentIntervalMs =
    typeof polling.intervalMs === "number" && polling.intervalMs > 0 ? polling.intervalMs : 60000;
  const secondsText = await ctx.ask("Polling interval (seconds)", String(currentIntervalMs / 1000));
  const seconds = Number(secondsText);
  const intervalMs = seconds * 1000;
  if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isInteger(intervalMs)) {
    throw new SetupError("Polling interval must be a positive number of seconds.");
  }

  const updated = {
    ...raw,
    workflow: { ...workflow, ...statuses },
    polling: { ...polling, intervalMs },
  };
  const result = AppConfigSchema.safeParse(updated);
  if (!result.success) {
    throw new SetupError(`Updated config failed validation: ${result.error.message}`);
  }

  const workspace = await findWorkspaceConfig(jira, projectKey);
  if (workspace) {
    await updateWorkspaceConfig(jira, workspace, {
      ggjiraVersion: GGJIRA_VERSION,
      projectPolicy: workspace.projectPolicy,
      ...(workspace.distribution ? { distribution: workspace.distribution } : {}),
      workflow: { ...workspace.workflow, ...statuses },
    });
    ctx.print(`Updated workflow statuses in ${workspace.issueKey}.`);
  }

  writeConfigFile(ctx.configPath, updated);
  ctx.print(`Updated ${ctx.configPath} (polling: ${seconds}s).`);
  return { startAgent: false };
}

/** Enables/configures the human-approved PM plan and execution-agent distribution workflow. */
export async function runDistributionSettingsFlow(ctx: FlowContext): Promise<SetupResult> {
  const raw = ctx.existingRawConfig;
  const secrets = ctx.existingSecrets;
  if (!raw) throw new SetupError("No existing ggjira.config.json found. Run full setup first.");
  if (!secrets)
    throw new SetupError("No valid Jira credentials found in .env. Run full setup first.");

  const jiraConfig = requireObject(raw.jira, "jira");
  const agent = requireObject(raw.agent, "agent");
  const workflow = requireObject(raw.workflow, "workflow");
  const previous =
    raw.distribution && typeof raw.distribution === "object" && !Array.isArray(raw.distribution)
      ? (raw.distribution as Record<string, unknown>)
      : {};
  const baseUrl = jiraConfig.baseUrl;
  const projectKey = jiraConfig.projectKey;
  if (typeof baseUrl !== "string" || typeof projectKey !== "string") {
    throw new SetupError("jira.baseUrl and jira.projectKey are required for distribution setup.");
  }

  const jira = ctx.createJira({ baseUrl, email: secrets.email, apiToken: secrets.apiToken });
  const connection = await checkJiraConnection(jira);
  if (!connection.ok) throw new SetupError(`Could not connect to Jira: ${connection.message}`);
  const enabled = isYes(
    await ctx.ask("Enable human plan approval and agent distribution? (Y/n)", "y"),
  );
  if (!enabled) {
    const updated = { ...raw, distribution: { ...previous, enabled: false } };
    writeConfigFile(ctx.configPath, updated);
    const workspace = await findWorkspaceConfig(jira, projectKey);
    if (workspace) {
      await updateWorkspaceConfig(jira, workspace, {
        ggjiraVersion: GGJIRA_VERSION,
        projectPolicy: workspace.projectPolicy,
        workflow: workspace.workflow,
        distribution: workspace.distribution
          ? { ...workspace.distribution, enabled: false }
          : { enabled: false },
      });
      ctx.print(`Disabled human distribution in ${workspace.issueKey}.`);
    }
    ctx.print(`Updated ${ctx.configPath} (human distribution disabled).`);
    return { startAgent: false };
  }

  const statuses = await listStatuses(ctx, jira, projectKey);
  const askConfiguredStatus = (label: string, field: string, fallback: string) =>
    askStatus(
      ctx,
      statuses,
      label,
      typeof workflow[field] === "string" ? (workflow[field] as string) : fallback,
    );
  const implementationStatus = await askConfiguredStatus(
    "1) Implementation request status",
    "implementationStatus",
    "AI Implementation",
  );
  const inProgressStatus = await askConfiguredStatus(
    "2) Implementation in-progress status",
    "inProgressStatus",
    "In Progress",
  );
  const reviewStatus = await askConfiguredStatus(
    "3) Implementation review status",
    "reviewStatus",
    "In Review",
  );
  // Planning reuses inProgressStatus/reviewStatus above -- a claimed plan and a claimed
  // implementation never need telling apart by status once routing is done (ADR 0017), so
  // there's nothing to ask beyond where a plan *request* starts.
  const planningStatus = await askConfiguredStatus(
    "4) Planning request status",
    "planningStatus",
    "AI Planning",
  );
  const fieldIdInput = await ctx.ask(
    "Execution agent Jira single-select field ID (customfield_12345 or 12345; not the field name)",
    typeof previous.executionAgentFieldId === "string" ? previous.executionAgentFieldId : undefined,
  );
  const fieldId = /^\d+$/.test(fieldIdInput.trim())
    ? `customfield_${fieldIdInput.trim()}`
    : fieldIdInput.trim();
  const workspaceId = await ctx.ask(
    "Canonical workspace ID",
    typeof previous.workspaceId === "string" ? previous.workspaceId : projectKey,
  );
  let executionAgentOptionId: string | undefined;
  if (agent.role === "implement") {
    executionAgentOptionId = await ctx.ask(
      "This agent's option ID in the execution-agent field",
      typeof previous.executionAgentOptionId === "string"
        ? previous.executionAgentOptionId
        : undefined,
    );
  }

  const updated = {
    ...raw,
    workflow: {
      ...workflow,
      implementationStatus,
      inProgressStatus,
      reviewStatus,
      planningStatus,
    },
    distribution: {
      enabled: true,
      executionAgentFieldId: fieldId,
      workspaceId,
      ...(executionAgentOptionId ? { executionAgentOptionId } : {}),
    },
  };
  const parsed = AppConfigSchema.safeParse(updated);
  if (!parsed.success) {
    throw new SetupError(`Updated config failed validation: ${parsed.error.message}`);
  }
  writeConfigFile(ctx.configPath, updated);

  // Statuses, the custom-field ID, and the workspace ID must agree across every machine (the
  // same failure ADR 0015 fixed for the three base statuses); executionAgentOptionId names one
  // specific implement machine, so it's never centralized here (README §Human-approved PM
  // distribution) -- each machine still enters its own when it runs this flow or joins.
  const workspace = await findWorkspaceConfig(jira, projectKey);
  if (workspace) {
    await updateWorkspaceConfig(jira, workspace, {
      ggjiraVersion: GGJIRA_VERSION,
      projectPolicy: workspace.projectPolicy,
      workflow: {
        ...workspace.workflow,
        implementationStatus,
        inProgressStatus,
        reviewStatus,
        planningStatus,
      },
      distribution: { enabled: true, executionAgentFieldId: fieldId, workspaceId },
    });
    ctx.print(`Updated distribution settings in ${workspace.issueKey}.`);
  }

  ctx.print(`Updated ${ctx.configPath} (human distribution enabled).`);
  return { startAgent: false };
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
  /** From the Workspace Configuration issue's Distribution section, if setup option 5 ran. */
  distribution?: WorkspaceDistribution;
  /** This machine's own option ID in the execution-agent field; never shared (see WorkspaceDistribution). */
  executionAgentOptionId?: string;
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
      implementationStatus: input.workflow.implementationStatus,
      inProgressStatus: input.workflow.inProgressStatus,
      reviewStatus: input.workflow.reviewStatus,
      // Planning is opt-in and setup never asks for it: it only lands in the
      // config when the Workspace Configuration issue declares it by hand.
      ...(input.workflow.planningStatus ? { planningStatus: input.workflow.planningStatus } : {}),
      ...(input.workflow.needsDecisionStatus
        ? { needsDecisionStatus: input.workflow.needsDecisionStatus }
        : {}),
    },
    workspace: { path: input.local.workspacePath, baseBranch: input.local.baseBranch },
    provider: {
      type: input.local.providerType,
      command: input.local.providerCommand,
      model: input.local.model,
    },
    pm: { subtaskIssueType: input.workflow.subtaskIssueType },
    polling: { intervalMs: 60000 },
    ...(input.distribution?.enabled
      ? {
          distribution: {
            enabled: true,
            executionAgentFieldId: input.distribution.executionAgentFieldId,
            workspaceId: input.distribution.workspaceId,
            ...(input.executionAgentOptionId
              ? { executionAgentOptionId: input.executionAgentOptionId }
              : {}),
          },
        }
      : {}),
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
    print(
      `  AI request: "${workspace.workflow.implementationStatus}"` +
        ` -> in progress: "${workspace.workflow.inProgressStatus}"` +
        ` -> review: "${workspace.workflow.reviewStatus}"`,
    );
    const changeAnswer = await ask("Change these statuses? (y/N)", "n");
    if (isYes(changeAnswer)) {
      const statuses = await askWorkflowStatuses(ctx, jira, projectKey, workspace.workflow);
      workspace = await updateWorkspaceConfig(jira, workspace, {
        ggjiraVersion: GGJIRA_VERSION,
        projectPolicy: workspace.projectPolicy,
        ...(workspace.distribution ? { distribution: workspace.distribution } : {}),
        workflow: { ...workspace.workflow, ...statuses },
      });
      print(`Updated ${workspace.issueKey}.`);
    }
  } else {
    print("No GGJira workspace found in this project yet. Let's create one.");
    const statuses = await askWorkflowStatuses(ctx, jira, projectKey, {
      implementationStatus: ctx.existingConfig?.workflow.implementationStatus,
      inProgressStatus: ctx.existingConfig?.workflow.inProgressStatus,
      reviewStatus: ctx.existingConfig?.workflow.reviewStatus,
    });
    const issueTypeName = await askIssueType(ctx, issueTypes);

    workspace = await createWorkspaceConfig(jira, {
      projectKey,
      configVersion: 4,
      ggjiraVersion: GGJIRA_VERSION,
      issueTypeName,
      workflow: { ...statuses, subtaskIssueType: "Subtask" },
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

  // A joining machine asks nothing about the workflow: the statuses come from
  // the project's Workspace Configuration, which the PM machine already set.
  print(
    `Workflow: AI request "${workspace.workflow.implementationStatus}"` +
      ` -> in progress "${workspace.workflow.inProgressStatus}"` +
      ` -> review "${workspace.workflow.reviewStatus}"`,
  );

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

  // Statuses and the custom field come from the shared Workspace Configuration issue -- only
  // this machine's own option ID in that field is asked here (README §Human-approved PM
  // distribution: "Each implement machine stores its own option ID").
  let executionAgentOptionId: string | undefined;
  if (workspace.distribution?.enabled) {
    print(
      `Human distribution is enabled (execution agent field ${workspace.distribution.executionAgentFieldId}).`,
    );
    if (profile.role === "implement") {
      executionAgentOptionId = await ask(
        "This agent's option ID in the execution-agent field",
        ctx.existingConfig?.distribution.executionAgentOptionId,
      );
    }
  }

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
    ...(workspace.distribution ? { distribution: workspace.distribution } : {}),
    ...(executionAgentOptionId ? { executionAgentOptionId } : {}),
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
