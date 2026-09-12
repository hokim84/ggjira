import { type AppConfig, isProfileMode } from "../config.js";
import { createImplementHandler } from "../implement/executor.js";
import type { JiraGateway } from "../jira/gateway.js";
import type { JiraUser } from "../jira/types.js";
import type { CycleDeps } from "../job/cycle.js";
import type { JobStore } from "../job/store.js";
import type { Logger } from "../logger.js";
import { createPmHandler } from "../pm/executor.js";
import { buildPmSystemPrompt } from "../pm/prompt.js";
import { findAgentProfiles } from "../profile/profile.js";
import type { AgentProfile, WorkspaceConfig } from "../profile/types.js";
import { findWorkspaceConfig } from "../profile/workspace.js";
import type { WorkerProvider } from "../worker/provider.js";
import { buildImplementSystemPrompt } from "../worker/prompt.js";
import { type AgentContext, loadAgentContext, verifyRegistration } from "./context.js";
import type { JobHandler } from "./handler.js";
import { canHandle, requiredBackends, unknownCapabilities } from "./capability.js";
import { BackendRegistry } from "./backend.js";
import { readIssueRequirements } from "./requirements.js";
import { composeSystemPrompt } from "./prompt.js";

export interface AgentRuntimeDeps {
  config: AppConfig;
  jira: JiraGateway;
  store: JobStore;
  provider: WorkerProvider;
  worktreesRoot: string;
  logger?: Logger;
}

export interface AgentRuntime {
  self: JiraUser;
  cycleDeps: CycleDeps;
  /** The Agent Profile/Workspace Configuration snapshot loaded at boot; absent in legacy mode. */
  context?: AgentContext;
}

/**
 * Wraps loadAgentContext with a fallback to the last successful load, so a
 * transient Jira failure mid-run doesn't take the agent down — it keeps
 * acting on the most recently known profile/workspace state and logs a
 * warning instead of throwing.
 */
function createContextLoader(
  jira: JiraGateway,
  config: AppConfig,
  initial: AgentContext,
  logger?: Logger,
): () => Promise<AgentContext> {
  let last = initial;
  return async () => {
    try {
      const ctx = await loadAgentContext(jira, config, logger);
      if (ctx) last = ctx;
      return last;
    } catch (error) {
      logger?.warn(
        { layer: "agent", err: error },
        "failed to reload agent profile/workspace from Jira; using the last known value",
      );
      return last;
    }
  };
}

function buildComposedSystemPrompt(
  loadContext: () => Promise<AgentContext>,
  corePolicy: () => string,
): () => Promise<string> {
  return async () => {
    const ctx = await loadContext();
    return composeSystemPrompt({
      corePolicy: corePolicy(),
      ...(ctx.workspace?.projectPolicy ? { projectPolicy: ctx.workspace.projectPolicy } : {}),
      preset: ctx.preset,
      profile: ctx.profile,
    });
  };
}

function buildRosterLoader(
  jira: JiraGateway,
  projectKey: string,
): () => Promise<{ agents: AgentProfile[]; workspace: WorkspaceConfig | null }> {
  return async () => {
    const [agents, workspace] = await Promise.all([
      findAgentProfiles(jira, projectKey),
      findWorkspaceConfig(jira, projectKey),
    ]);
    return { agents, workspace };
  };
}

function createHandlerForRole(
  deps: AgentRuntimeDeps,
  loadContext?: () => Promise<AgentContext>,
): JobHandler {
  const loggerOpt = deps.logger ? { logger: deps.logger } : {};
  const buildSystemPromptOpt = loadContext
    ? {
        buildSystemPrompt: buildComposedSystemPrompt(
          loadContext,
          deps.config.agent.role === "pm" ? buildPmSystemPrompt : buildImplementSystemPrompt,
        ),
      }
    : {};

  if (deps.config.agent.role === "pm") {
    const loadRosterOpt =
      loadContext && isProfileMode(deps.config)
        ? { loadRoster: buildRosterLoader(deps.jira, deps.config.jira.projectKey) }
        : {};
    return createPmHandler({
      config: deps.config,
      jira: deps.jira,
      provider: deps.provider,
      store: deps.store,
      worktreesRoot: deps.worktreesRoot,
      ...loggerOpt,
      ...buildSystemPromptOpt,
      ...loadRosterOpt,
    });
  }
  return createImplementHandler({
    config: deps.config,
    provider: deps.provider,
    store: deps.store,
    worktreesRoot: deps.worktreesRoot,
    ...loggerOpt,
    ...buildSystemPromptOpt,
  });
}

function defaultCapabilities(role: "pm" | "implement"): string[] {
  return role === "pm"
    ? ["planning", "task-decomposition", "dependency-analysis", "capability-analysis"]
    : ["programming", "testing", "review"];
}

function createDispatchHandler(
  deps: AgentRuntimeDeps,
  loadContext?: () => Promise<AgentContext>,
): JobHandler {
  const backends = new BackendRegistry();
  for (const id of deps.config.agent.backends ?? ["filesystem", "git", "coding-runtime"]) {
    backends.register({ id, isAvailable: () => true });
  }
  const planning = createPmHandler({
    config: deps.config,
    jira: deps.jira,
    provider: deps.provider,
    store: deps.store,
    worktreesRoot: deps.worktreesRoot,
    ...(deps.logger ? { logger: deps.logger } : {}),
    ...(loadContext
      ? {
          buildSystemPrompt: buildComposedSystemPrompt(loadContext, buildPmSystemPrompt),
          loadRoster: buildRosterLoader(deps.jira, deps.config.jira.projectKey ?? ""),
        }
      : {}),
  });
  const implementation = createImplementHandler({
    config: deps.config,
    provider: deps.provider,
    store: deps.store,
    worktreesRoot: deps.worktreesRoot,
    jira: deps.jira,
    ...(deps.logger ? { logger: deps.logger } : {}),
    ...(loadContext
      ? { buildSystemPrompt: buildComposedSystemPrompt(loadContext, buildImplementSystemPrompt) }
      : {}),
  });

  return {
    async run(params) {
      const planningStatus =
        deps.config.workflow.planningStatus ?? deps.config.workflow.readyStatus;
      if (params.issue.statusName === planningStatus) {
        const planningProfile = loadContext ? (await loadContext()).profile : undefined;
        const available = planningProfile?.capabilities.length
          ? planningProfile.capabilities
          : defaultCapabilities(planningProfile?.role ?? "pm");
        const match = canHandle(available, ["planning"]);
        if (!match.ok) {
          return {
            status: "failed",
            summary: "This agent cannot plan the issue.",
            failureReason: `Missing capabilities: ${match.missing.join(", ")}`,
          };
        }
        return planning.run(params);
      }

      if (
        params.issue.statusName ===
        (deps.config.workflow.implementationStatus ?? "AI Implementation")
      ) {
        if (!params.issue.assigneeAccountId) {
          return {
            status: "failed",
            summary: "AI implementation is waiting for an assignee.",
            failureReason: "The Jira issue has no assignee.",
          };
        }
        const requirements = readIssueRequirements(params.issue);
        const unknown = unknownCapabilities(requirements.requiredCapabilities);
        if (unknown.length > 0) {
          return {
            status: "failed",
            summary: "AI implementation has unknown Required Capabilities.",
            failureReason: `Unknown capabilities: ${unknown.join(", ")}`,
          };
        }
        const dependencyKeys = requirements.dependencies
          .map((dependency) => dependency.match(/[A-Z][A-Z0-9_]+-\d+/)?.[0])
          .filter((key): key is string => Boolean(key));
        const incompleteDependencies: string[] = [];
        for (const key of dependencyKeys) {
          const dependency = await deps.jira.getIssue(key);
          if (dependency.statusName !== (deps.config.workflow.completionStatus ?? "Done")) {
            incompleteDependencies.push(`${key} (${dependency.statusName})`);
          }
        }
        if (incompleteDependencies.length > 0) {
          return {
            status: "failed",
            summary: "AI implementation is waiting for dependencies.",
            failureReason: `Incomplete dependencies: ${incompleteDependencies.join(", ")}`,
          };
        }
        const implementationProfile = loadContext ? (await loadContext()).profile : undefined;
        const available = implementationProfile?.capabilities.length
          ? implementationProfile.capabilities
          : defaultCapabilities(implementationProfile?.role ?? "implement");
        const match = canHandle(available, requirements.requiredCapabilities);
        if (!match.ok) {
          return {
            status: "failed",
            summary: "This agent cannot implement the issue.",
            failureReason: `Missing capabilities: ${match.missing.join(", ")}`,
          };
        }
        const missingBackends = await backends.missing(
          requiredBackends(requirements.requiredCapabilities),
        );
        if (missingBackends.length > 0) {
          return {
            status: "failed",
            summary: "This agent does not have the required execution backend.",
            failureReason: `Unavailable backends: ${missingBackends.join(", ")}`,
          };
        }
        return implementation.run(params);
      }

      return {
        status: "failed",
        summary: "The issue is not in an executable workflow state.",
        failureReason: `Unexpected status: ${params.issue.statusName}`,
      };
    },
  };
}

/**
 * Authenticates against Jira, loads this machine's Agent Profile (when
 * configured), and wires up the role's JobHandler. This is the one place
 * that knows about both pm and implement — role modules themselves stay
 * independent of each other (phase 2 §4.1: PM never invokes the implement
 * execution path directly).
 */
export async function bootstrapAgent(deps: AgentRuntimeDeps): Promise<AgentRuntime> {
  const self = await deps.jira.getMyself();

  if (!isProfileMode(deps.config)) {
    const handler =
      deps.config.configVersion === 4 ? createDispatchHandler(deps) : createHandlerForRole(deps);
    return {
      self,
      cycleDeps: {
        jira: deps.jira,
        store: deps.store,
        handler,
        ...(deps.logger ? { logger: deps.logger } : {}),
      },
    };
  }

  const context = await loadAgentContext(deps.jira, deps.config, deps.logger);
  if (!context) {
    // isProfileMode(deps.config) was just checked true, so loadAgentContext
    // cannot legitimately return undefined here.
    throw new Error("Agent profile context failed to load despite profile mode being configured");
  }
  verifyRegistration(context, deps.config);
  if (!context.profile.enabled) {
    deps.logger?.warn(
      { layer: "agent", issueKey: context.profile.issueKey },
      "this agent's profile is disabled in Jira (ggjira-disabled label); polling will be skipped until it is re-enabled",
    );
  }

  const loadContext = createContextLoader(deps.jira, deps.config, context, deps.logger);
  const handler =
    deps.config.configVersion === 4
      ? createDispatchHandler(deps, loadContext)
      : createHandlerForRole(deps, loadContext);

  return {
    self,
    context,
    cycleDeps: {
      jira: deps.jira,
      store: deps.store,
      handler,
      shouldPoll: async () => (await loadContext()).profile.enabled,
      ...(deps.logger ? { logger: deps.logger } : {}),
    },
  };
}
