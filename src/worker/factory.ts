import type { WorkerProviderConfig } from "../contracts/provider.js";
import type { Logger } from "../logger.js";
import { ClaudeCodeCliProvider } from "./claude-code-cli.js";
import { CodexCliProvider } from "./codex-cli.js";
import type { WorkerProvider } from "./provider.js";

/** Builds one entry of `WorkerConfig.providers`, which the worker runtime looks up by the
 *  envelope's `providerId`. */
export function createProviderFromConfig(
  provider: WorkerProviderConfig,
  logger?: Logger,
): WorkerProvider {
  if (provider.type === "codex") {
    return new CodexCliProvider(logger, {
      command: provider.command,
      model: provider.model,
      sandbox: provider.codex.sandbox,
    });
  }
  return new ClaudeCodeCliProvider(logger, {
    command: provider.command,
    model: provider.model,
    effort: provider.claudeCode.effort,
    permissionMode: provider.claudeCode.permissionMode,
    allowedTools: provider.claudeCode.allowedTools,
  });
}
