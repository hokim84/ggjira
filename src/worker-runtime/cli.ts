import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { createInterface } from "node:readline/promises";
import {
  type CliIo,
  type ParsedArgs,
  parseCommandArgs,
  printCheckItems,
  requirePositional,
  stringOption,
  UsageError,
} from "../cli-io.js";
import { rootLogger } from "../logger.js";
import { createProviderFromConfig } from "../worker/factory.js";
import { RouterClient } from "./client.js";
import { assertRouterUrlAllowed, loadWorkerConfig, type WorkerConfig } from "./config.js";
import { loadWorkerCredential } from "./credential.js";
import { pairWorker, pruneWorktrees, runWorkerCheck, writeWorkerConfigTemplate } from "./ops.js";
import { defaultWorkerHome, workerPaths } from "./paths.js";
import { WorkerRunner } from "./runner.js";
import { prepareWorkerStart } from "./start.js";
import { ResultSpool } from "./spool.js";
import { formatWorkerProgress } from "./progress.js";

export const WORKER_USAGE = `ggjira worker <command>

  Every command works on one worker home: --home <dir>, else GGJIRA_WORKER_HOME, else
  data/worker in the GGJIRA checkout it runs from, else (installed package)
  %LOCALAPPDATA%\\ggjira\\worker (Windows) or ~/.ggjira/worker. It holds worker.config.json, the
  credential, clones, job worktrees, logs and spools. Agents read only the instruction files of
  the repository they work in, not CLAUDE.md or AGENTS.md from folders above it.

  start [--home <dir>]             run the worker; the first time it asks (in the terminal) for
                                   the Router address, LLM CLI, pairing code and repository
                                   folders, then writes the config. Non-terminal: pass
                                   --router, --pairing-code [--provider claude-code|codex]
  setup --pairing-code <code> [--router <url>] [--name <name>] [--home <dir>] [--force]
                                   pair with Router; writes the credential (and a starter
                                   config when the home has none yet)
  run [--home <dir>]               poll Router for jobs and execute them
  check [--home <dir>]             verify home, config, credential, repositories, providers, Router
  results retry [--home <dir>]     resend spooled results (stop "worker run" first)
  worktrees prune [--home <dir>] [--older-than-days <n>] [--dry-run]`;

function workerHome(parsed: ParsedArgs, io: CliIo): string {
  return stringOption(parsed, "home") ?? io.env.GGJIRA_WORKER_HOME ?? defaultWorkerHome(io.env);
}

function workerRunner(config: WorkerConfig, io?: CliIo): WorkerRunner {
  const paths = workerPaths(config.home);
  const credential = loadWorkerCredential(paths.credential);
  const logger = rootLogger.child({ layer: "worker-runtime", workerId: credential.workerId });
  return new WorkerRunner({
    config,
    client: new RouterClient({ routerUrl: config.routerUrl, workerToken: credential.workerToken }),
    workerId: credential.workerId,
    spool: new ResultSpool(paths.spool, logger),
    createProvider: (provider) => createProviderFromConfig(provider, logger),
    logger,
    ...(io ? { onProgress: (event) => io.out(formatWorkerProgress(event)) } : {}),
  });
}

async function setup(parsed: ParsedArgs, io: CliIo): Promise<number> {
  const pairingCode = stringOption(parsed, "pairing-code");
  if (!pairingCode) throw new UsageError("--pairing-code is required (from `router workers pair`)");
  const home = workerHome(parsed, io);
  const paths = workerPaths(home);
  const existing = existsSync(paths.config) ? loadWorkerConfig(home) : undefined;
  const routerUrl = stringOption(parsed, "router") ?? existing?.routerUrl;
  if (!routerUrl)
    throw new UsageError("--router <url> is required when the worker config does not exist yet");
  assertRouterUrlAllowed(routerUrl);

  const credential = await pairWorker({
    client: new RouterClient({ routerUrl }),
    pairingCode,
    workerName: stringOption(parsed, "name") ?? hostname(),
    credentialPath: paths.credential,
    force: Boolean(parsed.values.force),
  });
  io.out(`Paired as worker "${credential.workerId}"; credential saved to ${paths.credential}`);
  if (!existing) {
    writeWorkerConfigTemplate(paths.config, { routerUrl });
    io.out(`Wrote a starter ${paths.config}: set repositories, providers.`);
  }
  io.out(`Next: ggjira worker check --home ${home}, then ggjira worker run --home ${home}`);
  return 0;
}

function terminalAsk(): ((question: string) => Promise<string>) | undefined {
  if (!process.stdin.isTTY) return undefined;
  return async (question) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  };
}

async function start(parsed: ParsedArgs, io: CliIo): Promise<number> {
  const ask = terminalAsk();
  const config = await prepareWorkerStart(workerHome(parsed, io), parsed, io, ask ? { ask } : {});
  if (!config) return 1;
  io.out(
    `워커가 ${config.routerUrl} 에서 작업을 기다립니다. (Ctrl+C 1회: 현재 작업 후 종료, 2회: 즉시 종료)`,
  );
  return runWithConfig(config, io);
}

async function run(parsed: ParsedArgs, io: CliIo): Promise<number> {
  return runWithConfig(loadWorkerConfig(workerHome(parsed, io)), io);
}

async function runWithConfig(config: WorkerConfig, io: CliIo): Promise<number> {
  const runner = workerRunner(config, io);
  const controller = new AbortController();
  const stop = (signal: string) => {
    if (controller.signal.aborted) {
      io.err(`${signal} again: exiting without waiting for the current job`);
      process.exit(130);
    }
    io.err(`${signal}: finishing the current poll/job, then stopping (press again to force)`);
    controller.abort();
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  await runner.run(controller.signal);
  return 0;
}

async function check(parsed: ParsedArgs, io: CliIo): Promise<number> {
  const config = loadWorkerConfig(workerHome(parsed, io));
  const items = await runWorkerCheck(config, {
    client: new RouterClient({ routerUrl: config.routerUrl }),
  });
  return printCheckItems(io, [
    {
      level: "ok",
      message: `config ${workerPaths(config.home).config} is valid (configVersion 6)`,
    },
    ...items,
  ]);
}

async function results(parsed: ParsedArgs, io: CliIo): Promise<number> {
  const sub = requirePositional(parsed, 1, "results subcommand (retry)");
  if (sub !== "retry") throw new UsageError(`unknown results subcommand "${sub}"`);
  const config = loadWorkerConfig(workerHome(parsed, io));
  const spool = new ResultSpool(workerPaths(config.home).spool);
  const before = spool.listPending().length;
  // Opening a session is exactly what a restarted `worker run` does first: resend the spool and
  // report attempts that were running when the previous process died.
  await workerRunner(config).connect();
  const after = spool.listPending().length;
  io.out(`${before - after} spooled result(s) delivered, ${after} still waiting`);
  return after === 0 ? 0 : 1;
}

async function worktrees(parsed: ParsedArgs, io: CliIo): Promise<number> {
  const sub = requirePositional(parsed, 1, "worktrees subcommand (prune)");
  if (sub !== "prune") throw new UsageError(`unknown worktrees subcommand "${sub}"`);
  const config = loadWorkerConfig(workerHome(parsed, io));
  const days = Number(stringOption(parsed, "older-than-days") ?? "7");
  if (!Number.isFinite(days) || days < 0) throw new UsageError("--older-than-days must be >= 0");
  const dryRun = Boolean(parsed.values["dry-run"]);
  const outcome = await pruneWorktrees(config, { olderThanMs: days * 86_400_000, dryRun });
  for (const removed of outcome.removed)
    io.out(`${dryRun ? "would remove" : "removed"} ${removed}`);
  for (const failed of outcome.failed) io.err(`failed ${failed.path}: ${failed.error}`);
  io.out(
    `${outcome.removed.length} ${dryRun ? "to remove" : "removed"}, ${outcome.kept.length} kept (newer than ${days} days); branches are left in place`,
  );
  return outcome.failed.length ? 1 : 0;
}

export async function runWorkerCli(args: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = args;
  const config = { home: { type: "string" } } as const;
  switch (command) {
    case "start":
      return start(
        parseCommandArgs(rest, {
          ...config,
          "pairing-code": { type: "string" },
          router: { type: "string" },
          provider: { type: "string" },
          name: { type: "string" },
          force: { type: "boolean" },
        }),
        io,
      );
    case "setup":
      return setup(
        parseCommandArgs(rest, {
          ...config,
          "pairing-code": { type: "string" },
          router: { type: "string" },
          name: { type: "string" },
          force: { type: "boolean" },
        }),
        io,
      );
    case "run":
      return run(parseCommandArgs(rest, config), io);
    case "check":
      return check(parseCommandArgs(rest, config), io);
    case "results":
      return results(parseCommandArgs(args, config), io);
    case "worktrees":
      return worktrees(
        parseCommandArgs(args, {
          ...config,
          "older-than-days": { type: "string" },
          "dry-run": { type: "boolean" },
        }),
        io,
      );
    case undefined:
    case "help":
    case "--help":
      io.out(WORKER_USAGE);
      return command === undefined ? 2 : 0;
    default:
      throw new UsageError(`unknown worker command "${command}"\n\n${WORKER_USAGE}`);
  }
}
