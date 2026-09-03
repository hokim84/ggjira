import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { ClaudeCodeCliProvider } from "./claude-code-cli.js";
import { CodexCliProvider } from "./codex-cli.js";
import type { WorkerProvider } from "./provider.js";

/** Builds the WorkerProvider named by `config.provider.type`. */
export function createProvider(config: AppConfig, logger?: Logger): WorkerProvider {
  if (config.provider.type === "codex") {
    return new CodexCliProvider(logger, {
      command: config.provider.command,
      model: config.provider.model,
      sandbox: config.provider.codex.sandbox,
    });
  }
  return new ClaudeCodeCliProvider(logger, {
    command: config.provider.command,
    model: config.provider.model,
    effort: config.provider.claudeCode.effort,
    permissionMode: config.provider.claudeCode.permissionMode,
    allowedTools: config.provider.claudeCode.allowedTools,
  });
}
