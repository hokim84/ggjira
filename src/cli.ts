#!/usr/bin/env node
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { type AppConfig, ConfigError, loadAppConfig, loadJiraSecretsFromEnv } from "./config.js";
import { JiraApiError, JiraClient } from "./jira/client.js";
import { type CycleDeps, recoverStaleClaims, runPollCycle } from "./job/cycle.js";
import { JobStore } from "./job/store.js";
import type { Logger } from "./logger.js";
import { rootLogger } from "./logger.js";
import { ClaudeCodeCliProvider } from "./worker/claude-code-cli.js";
import { buildTaskSystemPrompt } from "./worker/prompt.js";
import type { WorkerRequest } from "./worker/provider.js";
import {
  changedFilesSince,
  commitAll,
  createWorktree,
  hasUncommittedChanges,
  listManagedWorktrees,
  removeWorktree,
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
  worktrees:prune    Remove old worktrees under data/worktrees/
                       --olderThanDays <n>  default 7

Options:
  -h, --help         Show this help message

Config:
  Reads ./ggjira.config.json (schema in src/config.ts) and Jira credentials
  from environment variables (see .env.example).
`;

const KNOWN_COMMANDS = new Set([
  "run",
  "once",
  "jira:smoke",
  "worker:run",
  "status",
  "worktrees:prune",
]);

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
      const reportingFlag = job.reportingFailed ? "  [reporting to Jira failed]" : "";
      process.stdout.write(
        `  - ${runId}  ${job.status}  updated ${job.updatedAt}${summarySuffix}${reportingFlag}\n`,
      );
    }
  }
}

async function runWorktreesPrune(args: string[]): Promise<void> {
  let olderThanDays = 7;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--olderThanDays") {
      const raw = args[++i];
      if (raw) olderThanDays = Number(raw);
    }
  }

  const config = loadConfigOrPrintError();
  if (!config) return;

  const worktreesRoot = path.resolve("data/worktrees");
  const thresholdMs = olderThanDays * 24 * 60 * 60 * 1000;
  const candidates = listManagedWorktrees(worktreesRoot).filter((w) => w.ageMs > thresholdMs);

  if (candidates.length === 0) {
    process.stdout.write(`Nothing to prune (nothing older than ${olderThanDays}d).\n`);
    return;
  }

  for (const worktree of candidates) {
    const ageDays = (worktree.ageMs / (24 * 60 * 60 * 1000)).toFixed(1);
    process.stdout.write(`Removing ${worktree.path} (age ${ageDays}d)...\n`);
    try {
      await removeWorktree(config.targetRepo.path, worktree.path);
    } catch (error) {
      process.stderr.write(
        `  failed to remove: ${error instanceof Error ? error.message : String(error)}\n`,
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

async function printPollCycle(config: AppConfig, deps: CycleDeps): Promise<void> {
  const outcomes = await runPollCycle(config, deps);
  if (outcomes.length === 0) {
    process.stdout.write("No candidate issues.\n");
    return;
  }

  for (const { issue, job } of outcomes) {
    process.stdout.write(`Processing ${issue.key}: ${issue.summary}\n`);
    if (!job) {
      process.stdout.write("  skipped (already claimed locally)\n");
      continue;
    }
    const reportingFlag = job.reportingFailed ? " [reporting to Jira failed — see job.json]" : "";
    process.stdout.write(
      `  -> ${job.status}${job.summary ? `: ${job.summary}` : ""}${reportingFlag}\n`,
    );
  }
}

interface PollSetup {
  config: AppConfig;
  deps: CycleDeps;
}

async function setUpPolling(): Promise<PollSetup | undefined> {
  const config = loadConfigOrPrintError();
  if (!config) return undefined;

  // Not layer-tagged here: each component (jira/worker/job/reporter/poller)
  // binds its own "layer" field per call, so a pre-bound value here would
  // just show up as a redundant duplicate key alongside it in the JSON logs.
  const logger = rootLogger;
  const jira = createJiraClientOrPrintError(logger);
  if (!jira) return undefined;

  const store = new JobStore();
  const worker = new ClaudeCodeCliProvider(logger);
  const worktreesRoot = path.resolve("data/worktrees");
  mkdirSync(worktreesRoot, { recursive: true });

  const deps: CycleDeps = { jira, store, worker, worktreesRoot, logger };

  const staleClaims = Object.keys(store.listClaims());
  if (staleClaims.length > 0) {
    process.stdout.write(
      `Recovering ${staleClaims.length} stale claim(s) from a previous run: ${staleClaims.join(", ")}\n`,
    );
    await recoverStaleClaims(config, deps);
  }

  return { config, deps };
}

async function runOnce(): Promise<void> {
  const setup = await setUpPolling();
  if (!setup) return;
  await printPollCycle(setup.config, setup.deps);
}

async function runDaemon(): Promise<void> {
  const setup = await setUpPolling();
  if (!setup) return;
  const { config, deps } = setup;

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
    await printPollCycle(config, deps);
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

  if (command === "worktrees:prune") {
    await runWorktreesPrune(rest);
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
