#!/usr/bin/env node
import { rootLogger } from "./logger.js";

const HELP = `ggjira — Jira-based orchestration for human + AI agent work

Usage:
  ggjira <command> [options]

Commands:
  run                Start the polling daemon (not yet implemented)
  once               Run a single poll cycle (not yet implemented)
  jira:smoke <KEY>   Verify Jira connectivity against one issue (not yet implemented)
  worker:run         Run the worker provider once, outside the Jira loop (not yet implemented)
  status             Show current job state (not yet implemented)

Options:
  -h, --help         Show this help message

Config:
  Reads ./ggjira.config.json (schema in src/config.ts) and Jira credentials
  from environment variables (see .env.example).
`;

const KNOWN_COMMANDS = new Set(["run", "once", "jira:smoke", "worker:run", "status"]);

function main(argv: string[]): void {
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

  rootLogger.warn({ layer: "cli", command, args: rest }, "command not implemented yet");
  process.stderr.write(`"${command}" is not implemented yet (see PLAN.md milestones).\n`);
  process.exitCode = 1;
}

main(process.argv.slice(2));
