import type { AppConfig } from "../config.js";
import { createImplementHandler } from "../implement/executor.js";
import type { JiraGateway } from "../jira/gateway.js";
import type { JiraUser } from "../jira/types.js";
import type { CycleDeps } from "../job/cycle.js";
import type { JobStore } from "../job/store.js";
import type { Logger } from "../logger.js";
import { createPmHandler } from "../pm/executor.js";
import type { WorkerProvider } from "../worker/provider.js";
import type { JobHandler } from "./handler.js";

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
}

function createHandlerForRole(deps: AgentRuntimeDeps): JobHandler {
  const loggerOpt = deps.logger ? { logger: deps.logger } : {};
  if (deps.config.agent.role === "pm") {
    return createPmHandler({
      config: deps.config,
      jira: deps.jira,
      provider: deps.provider,
      store: deps.store,
      worktreesRoot: deps.worktreesRoot,
      ...loggerOpt,
    });
  }
  return createImplementHandler({
    config: deps.config,
    provider: deps.provider,
    store: deps.store,
    worktreesRoot: deps.worktreesRoot,
    ...loggerOpt,
  });
}

/**
 * Authenticates against Jira and wires up the role's JobHandler. This is the
 * one place that knows about both pm and implement — role modules
 * themselves stay independent of each other (phase 2 §4.1: PM never invokes
 * the implement execution path directly).
 */
export async function bootstrapAgent(deps: AgentRuntimeDeps): Promise<AgentRuntime> {
  const self = await deps.jira.getMyself();
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
