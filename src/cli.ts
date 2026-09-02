#!/usr/bin/env node
import { mkdirSync, appendFileSync } from "node:fs";
import path from "node:path";
import { ConfigError, loadAppConfig, loadJiraSecretsFromEnv } from "./config.js";
import { JiraApiError, JiraClient } from "./jira/client.js";
import { rootLogger } from "./logger.js";
import { ClaudeCodeCliProvider } from "./worker/claude-code-cli.js";
import type { WorkerRequest } from "./worker/provider.js";
import { buildTaskSystemPrompt } from "./worker/prompt.js";
import {
  changedFilesSince,
  commitAll,
  createWorktree,
  hasUncommittedChanges,
} from "./worker/worktree.js";

try {
  process.loadEnvFile(".env");
} catch {
  // .env is optional; real deployments may set env vars another way.
}

const HELP = `ggjira — Jira-based orchestration for human + AI agent work

Usage:
  ggjira <command> [options]

Commands:
  run                Start the polling daemon (not yet implemented)
  once               Run a single poll cycle (not yet implemented)
  jira:smoke <KEY>   Verify Jira connectivity against one issue
  worker:run         Run the worker provider once, outside the Jira loop
                       --prompt <text>   (required) task instruction for the worker
                       --timeout <ms>    override worker.timeoutMs from config
  status             Show current job state (not yet implemented)

Options:
  -h, --help         Show this help message

Config:
  Reads ./ggjira.config.json (schema in src/config.ts) and Jira credentials
  from environment variables (see .env.example).
`;

const KNOWN_COMMANDS = new Set(["run", "once", "jira:smoke", "worker:run", "status"]);

async function runJiraSmoke(issueKey: string | undefined): Promise<void> {
  if (!issueKey) {
    process.stderr.write("Usage: ggjira jira:smoke <ISSUE-KEY>\n");
    process.exitCode = 1;
    return;
  }

  const logger = rootLogger.child({ layer: "jira", issueKey });

  let client: JiraClient;
  try {
    const secrets = loadJiraSecretsFromEnv();
    client = new JiraClient(secrets, { logger });
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`Config error: ${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  try {
    process.stdout.write(`Fetching ${issueKey}...\n`);
    const issue = await client.getIssue(issueKey);
    process.stdout.write(
      `  summary: ${issue.summary}\n  status:  ${issue.statusName}\n  labels:  ${issue.labels.join(", ") || "(none)"}\n`,
    );

    process.stdout.write("Adding smoke-test comment...\n");
    await client.addComment(
      issueKey,
      "GGJIRA smoke test: this comment confirms Jira API connectivity.",
    );
    process.stdout.write("  comment added.\n");

    process.stdout.write("Fetching available transitions...\n");
    const transitions = await client.getTransitions(issueKey);
    if (transitions.length === 0) {
      process.stdout.write("  (no transitions available from current status)\n");
    } else {
      for (const t of transitions) {
        process.stdout.write(`  - ${t.name}  (-> ${t.toStatusName})\n`);
      }
    }

    process.stdout.write("\njira:smoke OK\n");
  } catch (error) {
    if (error instanceof JiraApiError) {
      logger.error({ status: error.status, endpoint: error.endpoint }, error.message);
      process.stderr.write(
        `Jira API error (${error.status}) on ${error.endpoint}: ${error.message}\n`,
      );
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

async function runWorkerRun(args: string[]): Promise<void> {
  let prompt: string | undefined;
  let timeoutMs: number | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--prompt") {
      prompt = args[++i];
    } else if (args[i] === "--timeout") {
      const raw = args[++i];
      timeoutMs = raw ? Number(raw) : undefined;
    }
  }

  if (!prompt) {
    process.stderr.write("Usage: ggjira worker:run --prompt <text> [--timeout <ms>]\n");
    process.exitCode = 1;
    return;
  }

  const configPath = path.resolve("ggjira.config.json");
  let config: ReturnType<typeof loadAppConfig>;
  try {
    config = loadAppConfig(configPath);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`Config error: ${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const runId = `manual-${Date.now()}`;
  const branch = `ggjira/${runId}`;
  const worktreesRoot = path.resolve("data/worktrees");
  mkdirSync(worktreesRoot, { recursive: true });

  const logger = rootLogger.child({ layer: "worker", runId });

  process.stdout.write(`Creating worktree for branch ${branch}...\n`);
  const worktree = await createWorktree(
    config.targetRepo.path,
    config.targetRepo.baseBranch,
    branch,
    worktreesRoot,
  );
  process.stdout.write(`  worktree: ${worktree.path}\n`);

  const runDir = path.resolve("data/runs/_worker-run", runId);
  mkdirSync(runDir, { recursive: true });
  const workerLogPath = path.join(runDir, "worker.jsonl");

  const request: WorkerRequest = {
    prompt,
    cwd: worktree.path,
    timeoutMs: timeoutMs ?? config.worker.timeoutMs,
    command: config.worker.command,
    model: config.worker.model,
    effort: config.worker.effort,
    permissionMode: config.worker.permissionMode,
    allowedTools: config.worker.allowedTools,
    appendSystemPrompt: buildTaskSystemPrompt(),
  };

  const provider = new ClaudeCodeCliProvider(logger);
  process.stdout.write("Running worker...\n");
  const result = await provider.run(request, {
    onEvent: (line) => {
      appendFileSync(workerLogPath, `${line}\n`);
      try {
        const parsed = JSON.parse(line) as { type?: string };
        process.stdout.write(`  [worker] ${parsed.type ?? "?"}\n`);
      } catch {
        // non-JSON line; already saved to worker.jsonl
      }
    },
  });

  let changedFiles: string[] = [];
  if (result.exitReason === "completed") {
    if (await hasUncommittedChanges(worktree.path)) {
      await commitAll(worktree.path, `GGJIRA worker: ${prompt.slice(0, 72)}`);
      changedFiles = await changedFilesSince(worktree.path, config.targetRepo.baseBranch);
    } else {
      process.stdout.write("  (worker made no file changes; nothing to commit)\n");
    }
  }

  process.stdout.write("\n--- worker:run result ---\n");
  process.stdout.write(`exitReason:  ${result.exitReason}\n`);
  process.stdout.write(`isError:     ${result.isError}\n`);
  process.stdout.write(`durationMs:  ${result.durationMs}\n`);
  process.stdout.write(`summary:     ${result.summary}\n`);
  process.stdout.write(`branch:      ${branch}\n`);
  process.stdout.write(`worktree:    ${worktree.path}\n`);
  process.stdout.write(
    `changedFiles:${changedFiles.length ? `\n  - ${changedFiles.join("\n  - ")}` : " (none)"}\n`,
  );
  process.stdout.write(`workerLog:   ${workerLogPath}\n`);

  process.exitCode = result.exitReason === "completed" && !result.isError ? 0 : 1;
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;

  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    process.exitCode = 0;
    return;
  }

  if (!KNOWN_COMMANDS.has(command)) {
    process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
    process.exitCode = 1;
    return;
  }

  if (command === "jira:smoke") {
    await runJiraSmoke(rest[0]);
    return;
  }

  if (command === "worker:run") {
    await runWorkerRun(rest);
    return;
  }

  rootLogger.warn({ layer: "cli", command, args: rest }, "command not implemented yet");
  process.stderr.write(`"${command}" is not implemented yet (see PLAN.md milestones).\n`);
  process.exitCode = 1;
}

main(process.argv.slice(2)).catch((error: unknown) => {
  rootLogger.error({ layer: "cli", err: error }, "unhandled error");
  process.stderr.write(
    `Unexpected error: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
