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
import {
  assertRouterUrlAllowed,
  loadWorkerConfig,
  type WorkerConfig,
  workerSpoolDir,
  workerWorktreesRoot,
} from "./config.js";
import { loadWorkerCredential } from "./credential.js";
import { pairWorker, pruneWorktrees, runWorkerCheck, writeWorkerConfigTemplate } from "./ops.js";
import { WorkerRunner } from "./runner.js";
import { prepareWorkerStart } from "./start.js";
import { ResultSpool } from "./spool.js";

export const WORKER_USAGE = `ggjira worker <command>

  start [--config <path>]          run the worker; the first time it asks (in the terminal) for
                                   the Router address, LLM CLI, pairing code and repository
                                   folders, then writes the config. Non-terminal: pass
                                   --router, --pairing-code [--provider claude-code|codex]
  setup --pairing-code <code> [--router <url>] [--name <name>] [--config <path>]
        [--credential <path>] [--force]
                                   pair with Router; writes the credential file (and a starter
                                   config when --config does not exist yet)
  run [--config <path>]            poll Router for jobs and execute them
  check [--config <path>]          verify config, credential, repositories, providers, Router
  results retry [--config <path>]  resend spooled results (stop "worker run" first)
  worktrees prune [--config <path>] [--older-than-days <n>] [--dry-run]`;

const DEFAULT_CONFIG = "worker.config.json";
const DEFAULT_CREDENTIAL = "data/worker-credential.json";

function configPath(parsed: ParsedArgs, io: CliIo): string {
  return stringOption(parsed, "config") ?? io.env.GGJIRA_WORKER_CONFIG ?? DEFAULT_CONFIG;
}

function workerRunner(config: WorkerConfig): WorkerRunner {
  const credential = loadWorkerCredential(config.credentialPath);
  const logger = rootLogger.child({ layer: "worker-runtime", workerId: credential.workerId });
  return new WorkerRunner({
    config,
    client: new RouterClient({ routerUrl: config.routerUrl, workerToken: credential.workerToken }),
    workerId: credential.workerId,
    spool: new ResultSpool(workerSpoolDir(config)),
    createProvider: (provider) => createProviderFromConfig(provider, logger),
    worktreesRoot: workerWorktreesRoot(config),
    logger,
  });
}

async function setup(parsed: ParsedArgs, io: CliIo): Promise<number> {
  const pairingCode = stringOption(parsed, "pairing-code");
  if (!pairingCode) throw new UsageError("--pairing-code is required (from `router workers pair`)");
  const target = configPath(parsed, io);
  const existing = existsSync(target) ? loadWorkerConfig(target) : undefined;
  const routerUrl = stringOption(parsed, "router") ?? existing?.routerUrl;
  if (!routerUrl)
    throw new UsageError("--router <url> is required when the worker config does not exist yet");
  assertRouterUrlAllowed(routerUrl);
  const credentialPath =
    stringOption(parsed, "credential") ?? existing?.credentialPath ?? DEFAULT_CREDENTIAL;

  const credential = await pairWorker({
    client: new RouterClient({ routerUrl }),
    pairingCode,
    workerName: stringOption(parsed, "name") ?? hostname(),
    credentialPath,
    force: Boolean(parsed.values.force),
  });
  io.out(`Paired as worker "${credential.workerId}"; credential saved to ${credentialPath}`);
  if (!existing) {
    writeWorkerConfigTemplate(target, { routerUrl, credentialPath });
    io.out(`Wrote a starter ${target}: set repositories[].path, providers and capabilities.`);
  }
  io.out(`Next: ggjira worker check --config ${target}, then ggjira worker run --config ${target}`);
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
  const config = await prepareWorkerStart(configPath(parsed, io), parsed, io, ask ? { ask } : {});
  if (!config) return 1;
  io.out(
    `워커가 ${config.routerUrl} 에서 작업을 기다립니다. (Ctrl+C 1회: 현재 작업 후 종료, 2회: 즉시 종료)`,
  );
  return runWithConfig(config, io);
}

async function run(parsed: ParsedArgs, io: CliIo): Promise<number> {
  return runWithConfig(loadWorkerConfig(configPath(parsed, io)), io);
}

async function runWithConfig(config: WorkerConfig, io: CliIo): Promise<number> {
  const runner = workerRunner(config);
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
  const config = loadWorkerConfig(configPath(parsed, io));
  const items = await runWorkerCheck(config, {
    client: new RouterClient({ routerUrl: config.routerUrl }),
  });
  return printCheckItems(io, [
    { level: "ok", message: `config ${configPath(parsed, io)} is valid (configVersion 5)` },
    ...items,
  ]);
}

async function results(parsed: ParsedArgs, io: CliIo): Promise<number> {
  const sub = requirePositional(parsed, 1, "results subcommand (retry)");
  if (sub !== "retry") throw new UsageError(`unknown results subcommand "${sub}"`);
  const config = loadWorkerConfig(configPath(parsed, io));
  const spool = new ResultSpool(workerSpoolDir(config));
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
  const config = loadWorkerConfig(configPath(parsed, io));
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
  const config = { config: { type: "string" } } as const;
  switch (command) {
    case "start":
      return start(
        parseCommandArgs(rest, {
          ...config,
          "pairing-code": { type: "string" },
          router: { type: "string" },
          provider: { type: "string" },
          name: { type: "string" },
          credential: { type: "string" },
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
          credential: { type: "string" },
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
