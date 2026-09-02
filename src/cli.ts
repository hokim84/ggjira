#!/usr/bin/env node
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { type AppConfig, ConfigError, loadAppConfig, loadJiraSecretsFromEnv } from "./config.js";
import { JiraApiError, JiraClient } from "./jira/client.js";
import { runJobForIssue } from "./job/runner.js";
import { JobStore } from "./job/store.js";
import type { Logger } from "./logger.js";
import { rootLogger } from "./logger.js";
import { findCandidateIssues } from "./poller/poller.js";
import { ClaudeCodeCliProvider } from "./worker/claude-code-cli.js";
import { buildTaskSystemPrompt } from "./worker/prompt.js";
import type { WorkerRequest } from "./worker/provider.js";
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
  run                Start the polling daemon (Ctrl+C to stop after the current cycle)
  once               Run a single poll cycle and exit
  jira:smoke <KEY>   Verify Jira connectivity against one issue
  worker:run         Run the worker provider once, outside the Jira loop
                       --prompt <text>   (required) task instruction for the worker
                       --timeout <ms>    override worker.timeoutMs from config
  status             Show current job claims and recorded runs

Options:
  -h, --help         Show this help message

Config:
  Reads ./ggjira.config.json (schema in src/config.ts) and Jira credentials
  from environment variables (see .env.example).
`;

const KNOWN_COMMANDS = new Set(["run", "once", "jira:smoke", "worker:run", "status"]);

function loadConfigOrPrintError(): AppConfig | undefined {
  const configPath = path.resolve("ggjira.config.json");
  try {
    return loadAppConfig(configPath);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`Config error: ${error.message}\n`);
      process.exitCode = 1;
      return undefined;
    }
    throw error;
  }
}

function createJiraClientOrPrintError(logger: Logger): JiraClient | undefined {
  try {
    const secrets = loadJiraSecretsFromEnv();
    return new JiraClient(secrets, { logger });
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`Config error: ${error.message}\n`);
      process.exitCode = 1;
      return undefined;
    }
    throw error;
  }
}

async function runJiraSmoke(issueKey: string | undefined): Promise<void> {
  if (!issueKey) {
    process.stderr.write("Usage: ggjira jira:smoke <ISSUE-KEY>\n");
    process.exitCode = 1;
    return;
  }

  const logger = rootLogger.child({ layer: "jira", issueKey });

  const client = createJiraClientOrPrintError(logger);
  if (!client) return;

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

  const config = loadConfigOrPrintError();
  if (!config) return;

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

async function runStatus(): Promise<void> {
  const store = new JobStore();
  const claims = store.listClaims();
  const issueKeys = new Set([...Object.keys(claims), ...store.listIssueKeys()]);

  if (issueKeys.size === 0) {
    process.stdout.write("No jobs recorded yet.\n");
    return;
  }

  for (const issueKey of [...issueKeys].sort()) {
    const claimedRunId = claims[issueKey];
    process.stdout.write(`${issueKey}${claimedRunId ? `  (claimed by ${claimedRunId})` : ""}\n`);

    const runIds = store.listRunIds(issueKey);
    if (runIds.length === 0) {
      process.stdout.write("  (no recorded runs)\n");
      continue;
    }
    for (const runId of runIds) {
      const job = store.loadJob(issueKey, runId);
      if (!job) continue;
      const oneLineSummary = job.summary?.replace(/\s+/g, " ").trim();
      const truncated =
        oneLineSummary && oneLineSummary.length > 100
          ? `${oneLineSummary.slice(0, 100)}…`
          : oneLineSummary;
      const summarySuffix = truncated ? `  "${truncated}"` : "";
      process.stdout.write(
        `  - ${runId}  ${job.status}  updated ${job.updatedAt}${summarySuffix}\n`,
      );
    }
  }
}

function cancellableSleep(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timer: NodeJS.Timeout;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

async function runPollCycle(
  config: AppConfig,
  jira: JiraClient,
  store: JobStore,
  worker: ClaudeCodeCliProvider,
  worktreesRoot: string,
  logger: Logger,
): Promise<void> {
  const candidates = await findCandidateIssues(jira, config, store);
  if (candidates.length === 0) {
    process.stdout.write("No candidate issues.\n");
    return;
  }

  for (const issue of candidates) {
    process.stdout.write(`Processing ${issue.key}: ${issue.summary}\n`);
    const job = await runJobForIssue(issue, config, { jira, store, worker, worktreesRoot, logger });
    if (!job) {
      process.stdout.write("  skipped (already claimed locally)\n");
      continue;
    }
    process.stdout.write(`  -> ${job.status}${job.summary ? `: ${job.summary}` : ""}\n`);
  }
}

interface PollSetup {
  config: AppConfig;
  jira: JiraClient;
  store: JobStore;
  worker: ClaudeCodeCliProvider;
  worktreesRoot: string;
  logger: Logger;
}

function setUpPolling(): PollSetup | undefined {
  const config = loadConfigOrPrintError();
  if (!config) return undefined;

  const logger = rootLogger.child({ layer: "poller" });
  const jira = createJiraClientOrPrintError(logger);
  if (!jira) return undefined;

  const store = new JobStore();
  const worker = new ClaudeCodeCliProvider(logger);
  const worktreesRoot = path.resolve("data/worktrees");
  mkdirSync(worktreesRoot, { recursive: true });

  return { config, jira, store, worker, worktreesRoot, logger };
}

async function runOnce(): Promise<void> {
  const setup = setUpPolling();
  if (!setup) return;
  await runPollCycle(
    setup.config,
    setup.jira,
    setup.store,
    setup.worker,
    setup.worktreesRoot,
    setup.logger,
  );
}

async function runDaemon(): Promise<void> {
  const setup = setUpPolling();
  if (!setup) return;
  const { config, jira, store, worker, worktreesRoot, logger } = setup;

  let stopping = false;
  let resolveStopSignal: () => void = () => {};
  const stopSignal = new Promise<void>((resolve) => {
    resolveStopSignal = resolve;
  });
  const requestStop = () => {
    if (!stopping) {
      stopping = true;
      process.stdout.write("\nShutting down after the current poll cycle...\n");
      resolveStopSignal();
    }
  };
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);

  process.stdout.write(`Polling every ${config.polling.intervalMs}ms. Press Ctrl+C to stop.\n`);
  while (!stopping) {
    await runPollCycle(config, jira, store, worker, worktreesRoot, logger);
    if (stopping) break;
    // Racing against stopSignal means a signal during the idle wait stops us
    // immediately instead of waiting out the rest of the poll interval; the
    // timer is cancelled either way so it doesn't keep the process alive.
    const { promise: idle, cancel: cancelIdle } = cancellableSleep(config.polling.intervalMs);
    await Promise.race([idle, stopSignal]);
    cancelIdle();
  }
  process.stdout.write("Stopped.\n");
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

  if (command === "status") {
    await runStatus();
    return;
  }

  if (command === "once") {
    await runOnce();
    return;
  }

  if (command === "run") {
    await runDaemon();
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
