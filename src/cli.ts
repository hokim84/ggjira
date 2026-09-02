#!/usr/bin/env node
import { ConfigError, loadJiraSecretsFromEnv } from "./config.js";
import { JiraApiError, JiraClient } from "./jira/client.js";
import { rootLogger } from "./logger.js";

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
  worker:run         Run the worker provider once, outside the Jira loop (not yet implemented)
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
