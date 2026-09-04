import { type AppConfig, isProfileMode } from "../config.js";
import { createImplementHandler } from "../implement/executor.js";
import type { JiraGateway } from "../jira/gateway.js";
import type { JiraUser } from "../jira/types.js";
import type { CycleDeps } from "../job/cycle.js";
import type { JobStore } from "../job/store.js";
import type { Logger } from "../logger.js";
import { createPmHandler } from "../pm/executor.js";
import { buildPmSystemPrompt } from "../pm/prompt.js";
import type { WorkerProvider } from "../worker/provider.js";
import { buildImplementSystemPrompt } from "../worker/prompt.js";
import { type AgentContext, loadAgentContext, verifyRegistration } from "./context.js";
import type { JobHandler } from "./handler.js";
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
    return createPmHandler({
      config: deps.config,
      jira: deps.jira,
      provider: deps.provider,
      store: deps.store,
      worktreesRoot: deps.worktreesRoot,
      ...loggerOpt,
      ...buildSystemPromptOpt,
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
    const handler = createHandlerForRole(deps);
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
  const handler = createHandlerForRole(deps, loadContext);

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
