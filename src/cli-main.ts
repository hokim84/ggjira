import { type CliIo, processIo, UsageError } from "./cli-io.js";
import { ROUTER_USAGE, runRouterCli } from "./router/cli.js";
import { GGJIRA_VERSION } from "./version.js";
import { runWorkerCli, WORKER_USAGE } from "./worker-runtime/cli.js";

const USAGE = `ggjira ${GGJIRA_VERSION} — Jira-driven Router and Workers (configVersion 5)

${ROUTER_USAGE}

${WORKER_USAGE}`;

/** v4 commands and where their job went in v5 (ADR 0022). They fail loudly rather than running
 *  a removed code path or silently reading an old config. */
const REMOVED_COMMANDS: Record<string, string> = {
  run: "ggjira router serve (Router) and ggjira worker run (each worker)",
  once: "ggjira router reconcile",
  setup: "ggjira router setup / ggjira worker setup",
  status: "ggjira router status / ggjira router jobs list",
  "jira:smoke": "ggjira router check",
  "worker:run": "ggjira worker run",
  "pm:plan": "move the issue to the planning status; Router dispatches a planning job",
  "report:retry": "ggjira router reports retry <batchId>",
  "worktrees:prune": "ggjira worker worktrees prune",
  "agent:list": "ggjira router workers list",
  "agent:create": "declare the worker in router config workers[], then ggjira router workers pair",
  "agent:disable": "ggjira router workers disable <workerId>",
};

export async function main(argv: string[], io: CliIo = processIo): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === "router") return await runRouterCli(rest, io);
    if (command === "worker") return await runWorkerCli(rest, io);
    if (command === "--version" || command === "-v") {
      io.out(GGJIRA_VERSION);
      return 0;
    }
    if (command === undefined || command === "--help" || command === "-h" || command === "help") {
      io.out(USAGE);
      return command === undefined ? 2 : 0;
    }
    const replacement = REMOVED_COMMANDS[command];
    if (replacement) {
      io.err(`"ggjira ${command}" was removed with the v4 polling agent. Use: ${replacement}`);
      return 2;
    }
    io.err(`unknown command "${command}"\n\n${USAGE}`);
    return 2;
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(error.message);
      return 2;
    }
    io.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
