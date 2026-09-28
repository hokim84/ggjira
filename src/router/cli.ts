import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
import {
  type CliIo,
  formatTable,
  type ParsedArgs,
  parseCommandArgs,
  printCheckItems,
  requirePositional,
  stringOption,
  UsageError,
} from "../cli-io.js";
import { JiraClient } from "../jira/client.js";
import { rootLogger } from "../logger.js";
import type { AdminBlockedBatch, AdminWorkerView, RouterStatus } from "./admin-service.js";
import { AdminClient } from "./admin-client.js";
import { type CheckItem, runRouterCheck } from "./check.js";
import { loadRouterConfig, type RouterConfig } from "./config.js";
import { defaultSecretsPath, randomSecret, routerConfigTemplate } from "./config-store.js";
import { RouterDaemon } from "./daemon.js";
import { openRouterDb } from "./db/connection.js";
import type { JobPage, JobRow } from "./db/jobs.js";
import {
  loadRouterGithubSecrets,
  loadRouterSecrets,
  parseEnvFile,
  type RouterEnvSecrets,
  RouterSecretsError,
} from "./secrets.js";
import { buildSetupServer } from "./setup-server.js";

export const ROUTER_USAGE = `ggjira router <command>

  setup [--config <path>] [--force]      write a starter config and print fresh secrets
  serve [--config <path>] [--secrets <path>] [--host <h>] [--port <n>]
                                         run the Router (webhooks, worker API, admin API, web UI
                                         at /ui/); without a config or secrets it starts the web
                                         setup wizard instead
  check [--config <path>] [--issue KEY]  verify config against Jira (read-only)

  Admin commands talk to a running Router (--url, or GGJIRA_ROUTER_URL, or the config's http
  address) with GGJIRA_ADMIN_TOKEN. Add --json for raw output.
  status
  workers list | pair <workerId> | disable <workerId> | enable <workerId> | revoke <workerId>
  jobs list [--state <s>] [--limit <n>] [--cursor <c>] | show <jobId>
       cancel <jobId> | retry <jobId> | resolve <jobId>
  reports list | retry <batchId>
  reconcile
  backup`;

const DEFAULT_CONFIG = "router.config.json";

const COMMON_OPTIONS = {
  config: { type: "string" },
  secrets: { type: "string" },
  url: { type: "string" },
  json: { type: "boolean" },
} as const;

function configPath(parsed: ParsedArgs, io: CliIo): string {
  return stringOption(parsed, "config") ?? io.env.GGJIRA_ROUTER_CONFIG ?? DEFAULT_CONFIG;
}

function secretsPath(parsed: ParsedArgs, io: CliIo): string {
  return (
    stringOption(parsed, "secrets") ??
    io.env.GGJIRA_ROUTER_SECRETS ??
    defaultSecretsPath(configPath(parsed, io))
  );
}

export type ServeMode =
  | { mode: "router"; config: RouterConfig; secrets: RouterEnvSecrets }
  | { mode: "setup"; reason: string };

/**
 * A missing config file or incomplete secrets start the setup wizard; a config file that exists
 * but is broken stays a hard error so the wizard never silently replaces it.
 */
export function decideServeMode(
  configFile: string,
  secretsFile: string,
  env: NodeJS.ProcessEnv,
): ServeMode {
  if (!existsSync(configFile)) {
    return { mode: "setup", reason: `no Router config at ${configFile}` };
  }
  const config = loadRouterConfig(configFile);
  try {
    return { mode: "router", config, secrets: loadRouterSecrets(env, secretsFile) };
  } catch (error) {
    if (error instanceof RouterSecretsError) return { mode: "setup", reason: error.message };
    throw error;
  }
}

function setup(parsed: ParsedArgs, io: CliIo): number {
  const target = configPath(parsed, io);
  if (existsSync(target) && !parsed.values.force) {
    throw new UsageError(`${target} already exists; pass --force to overwrite it`);
  }
  mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  writeFileSync(target, `${JSON.stringify(routerConfigTemplate(), null, 2)}\n`, "utf-8");
  io.out(
    `Wrote ${target}. Edit Jira URL, workspaces, statuses and workers, then run "router check".`,
  );
  io.out("");
  io.out("Set these in the Router's environment (never in the config file):");
  io.out("  JIRA_EMAIL=<Jira account email>");
  io.out("  JIRA_API_TOKEN=<Jira API token>");
  io.out(`  GGJIRA_WEBHOOK_SECRET=${randomSecret()}`);
  io.out(`  GGJIRA_ADMIN_TOKEN=${randomSecret()}`);
  io.out("Use the same webhook secret when creating the Jira admin webhook.");
  return 0;
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function portOption(parsed: ParsedArgs): number | undefined {
  const raw = stringOption(parsed, "port");
  if (raw === undefined) return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new UsageError(`--port must be a port number, got "${raw}"`);
  }
  return port;
}

function waitForShutdown(logger: typeof rootLogger, stop: () => Promise<void>): Promise<void> {
  return new Promise<void>((resolve) => {
    const shutdown = (signal: string) => {
      logger.info({ signal }, "router stopping");
      stop()
        .catch((error: unknown) => logger.error({ err: error }, "router stop failed"))
        .finally(resolve);
    };
    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
  });
}

async function serveSetup(parsed: ParsedArgs, io: CliIo, reason: string): Promise<number> {
  const logger = rootLogger.child({ layer: "router" });
  const host = stringOption(parsed, "host") ?? "127.0.0.1";
  const port = portOption(parsed) ?? 8787;
  const setupToken = randomSecret();
  const app = buildSetupServer({
    configPath: configPath(parsed, io),
    secretsPath: secretsPath(parsed, io),
    setupToken,
    jiraFactory: (credentials) => new JiraClient(credentials, { logger }),
  });
  const address = await app.listen({ host, port });
  logger.warn({ reason }, "router is not configured; serving the setup wizard only");
  io.out("");
  io.out(`GGJIRA Router setup: open ${address}/ui/ and enter this one-time setup token:`);
  io.out(`  ${setupToken}`);
  io.out("Restart the Router after the wizard finishes.");
  io.out("");
  if (!isLoopbackHost(host)) {
    logger.warn({ host }, "setup wizard is reachable off this host; use it only over HTTPS");
  }
  await waitForShutdown(logger, () => app.close());
  return 0;
}

async function serve(parsed: ParsedArgs, io: CliIo): Promise<number> {
  const configFile = configPath(parsed, io);
  const decided = decideServeMode(configFile, secretsPath(parsed, io), io.env);
  if (decided.mode === "setup") return serveSetup(parsed, io, decided.reason);
  const { config, secrets } = decided;
  const logger = rootLogger.child({ layer: "router" });
  mkdirSync(path.dirname(path.resolve(config.db.path)), { recursive: true });
  const db = openRouterDb(config.db.path);
  const jira = new JiraClient(
    { baseUrl: config.jira.baseUrl, email: secrets.jiraEmail, apiToken: secrets.jiraApiToken },
    {
      logger,
      ...(config.executionAgent ? { executionAgentFieldId: config.executionAgent.fieldId } : {}),
    },
  );
  const github = loadRouterGithubSecrets(io.env, secretsPath(parsed, io));
  const daemon = new RouterDaemon({
    db,
    jira,
    config,
    webhookSecret: secrets.webhookSecret,
    adminToken: secrets.adminToken,
    siteId: new URL(config.jira.baseUrl).host,
    configPath: configFile,
    logger,
    github: { webhookSecret: github.webhookSecret, token: github.token },
  });

  const host = stringOption(parsed, "host") ?? config.http.host;
  const port = portOption(parsed) ?? config.http.port;
  if (!isLoopbackHost(host)) {
    logger.warn(
      { host },
      "Router serves plain HTTP; expose it only through the HTTPS proxy (docker-compose Caddy)",
    );
  }
  const address = await daemon.listen(host, port);
  daemon.start();
  logger.info({ address, ui: `${address}/ui/` }, "router serving");

  await waitForShutdown(logger, async () => {
    try {
      await daemon.stop();
    } finally {
      db.close();
    }
  });
  return 0;
}

async function check(parsed: ParsedArgs, io: CliIo): Promise<number> {
  const items: CheckItem[] = [];
  const config = loadRouterConfig(configPath(parsed, io));
  items.push({
    level: "ok",
    message: `config ${configPath(parsed, io)} is valid (configVersion 5)`,
  });
  let secrets: RouterEnvSecrets | undefined;
  try {
    secrets = loadRouterSecrets(io.env, secretsPath(parsed, io));
    items.push({ level: "ok", message: "Router secrets are set (environment or secrets file)" });
  } catch (error) {
    items.push({ level: "fail", message: (error as Error).message });
  }
  const email = secrets?.jiraEmail ?? io.env.JIRA_EMAIL;
  const apiToken = secrets?.jiraApiToken ?? io.env.JIRA_API_TOKEN;
  if (!email || !apiToken) {
    items.push({
      level: "fail",
      message: "JIRA_EMAIL/JIRA_API_TOKEN not set; skipping Jira checks",
    });
    return printCheckItems(io, items);
  }
  const jira = new JiraClient(
    { baseUrl: config.jira.baseUrl, email, apiToken },
    config.executionAgent ? { executionAgentFieldId: config.executionAgent.fieldId } : {},
  );
  const issueKey = stringOption(parsed, "issue");
  items.push(...(await runRouterCheck(jira, config, issueKey ? { issueKey } : {})));
  return printCheckItems(io, items);
}

function adminTokenFromSecretsFile(file: string): string | undefined {
  try {
    return parseEnvFile(readFileSync(file, "utf-8")).GGJIRA_ADMIN_TOKEN || undefined;
  } catch {
    return undefined;
  }
}

function adminClient(parsed: ParsedArgs, io: CliIo): AdminClient {
  const token = io.env.GGJIRA_ADMIN_TOKEN ?? adminTokenFromSecretsFile(secretsPath(parsed, io));
  if (!token) {
    throw new UsageError(
      "GGJIRA_ADMIN_TOKEN must be set (environment or Router secrets file) for admin commands",
    );
  }
  let routerUrl = stringOption(parsed, "url") ?? io.env.GGJIRA_ROUTER_URL;
  if (!routerUrl) {
    let config: RouterConfig;
    try {
      config = loadRouterConfig(configPath(parsed, io));
    } catch {
      throw new UsageError("pass --url or set GGJIRA_ROUTER_URL (no readable Router config found)");
    }
    const host =
      config.http.host === "0.0.0.0" || config.http.host === "::" ? "127.0.0.1" : config.http.host;
    routerUrl = `http://${host.includes(":") ? `[${host}]` : host}:${config.http.port}`;
  }
  let actor: string | undefined;
  try {
    actor = userInfo().username;
  } catch {
    actor = undefined;
  }
  return new AdminClient({ routerUrl, adminToken: token, ...(actor ? { actor } : {}) });
}

function printJson(io: CliIo, value: unknown): void {
  io.out(JSON.stringify(value, null, 2));
}

function printWorkers(io: CliIo, workers: AdminWorkerView[]): void {
  const rows = workers.map((w) => [
    w.workerId,
    w.revokedAt ? "revoked" : !w.paired ? "unpaired" : w.online ? "online" : "offline",
    w.declared ? (w.policyEnabled ? "yes" : "no (config)") : "no (undeclared)",
    w.enabled ? "yes" : "no",
    w.lastHeartbeatAt ?? "-",
    w.activeAttempt ? `${w.activeAttempt.jobId} (${w.activeAttempt.state})` : "-",
  ]);
  for (const line of formatTable(
    ["WORKER", "STATE", "DECLARED", "ENABLED", "LAST HEARTBEAT", "ACTIVE JOB"],
    rows,
  )) {
    io.out(line);
  }
}

function printJobs(io: CliIo, page: JobPage): void {
  const rows = page.jobs.map((job: JobRow) => [
    job.id,
    job.issueKey,
    job.kind,
    job.state,
    String(job.attemptCount),
    job.updatedAt,
  ]);
  for (const line of formatTable(["JOB", "ISSUE", "KIND", "STATE", "ATTEMPTS", "UPDATED"], rows)) {
    io.out(line);
  }
  if (page.nextCursor) io.out(`next page: --cursor ${page.nextCursor}`);
}

function printBlockedReports(io: CliIo, batches: AdminBlockedBatch[]): void {
  if (batches.length === 0) {
    io.out("no blocked report steps");
    return;
  }
  for (const batch of batches) {
    io.out(`${batch.batchId}  (${batch.issueKey}, job ${batch.jobId})`);
    for (const step of batch.steps) {
      io.out(
        `  #${step.seq} ${step.kind} ${step.status} tries=${step.tries} ${step.lastError ?? ""}`,
      );
    }
  }
}

function printStatus(io: CliIo, status: RouterStatus): void {
  const jobs = Object.entries(status.jobs)
    .map(([state, n]) => `${state}=${n}`)
    .join(" ");
  io.out(`jobs:              ${jobs || "(none)"}`);
  io.out(
    `queue wait:        ${status.queue.waitMs === null ? "-" : `${Math.round(status.queue.waitMs / 1000)}s`}`,
  );
  io.out(
    `workers:           ${status.workers.online} online / ${status.workers.paired} paired / ${status.workers.declared} declared`,
  );
  io.out(`recovery required: ${status.recoveryRequired}`);
  io.out(
    `webhook delay:     ${status.webhooks.delayMs === null ? "-" : `${Math.round(status.webhooks.delayMs / 1000)}s`}`,
  );
  io.out(`blocked reports:   ${status.reports.blocked}`);
}

async function workers(parsed: ParsedArgs, io: CliIo): Promise<number> {
  const client = adminClient(parsed, io);
  const sub = requirePositional(parsed, 1, "workers subcommand (list|pair|disable|enable|revoke)");
  if (sub === "list") {
    const { workers: list } = await client.get<{ workers: AdminWorkerView[] }>("/workers");
    if (parsed.values.json) printJson(io, list);
    else printWorkers(io, list);
    return 0;
  }
  const workerId = requirePositional(parsed, 2, "workerId");
  if (sub === "pair") {
    const code = await client.post<{ pairingCode: string; expiresAt: string }>("/pairing-codes", {
      workerId,
    });
    if (parsed.values.json) {
      printJson(io, code);
      return 0;
    }
    io.out(
      `Pairing code for ${workerId}: ${code.pairingCode} (single use, expires ${code.expiresAt})`,
    );
    io.out(
      `On the worker machine: ggjira worker setup --router <https-url> --pairing-code ${code.pairingCode}`,
    );
    return 0;
  }
  if (sub === "disable" || sub === "enable" || sub === "revoke") {
    const view = await client.post<AdminWorkerView>(
      `/workers/${encodeURIComponent(workerId)}/${sub}`,
    );
    if (parsed.values.json) printJson(io, view);
    else printWorkers(io, [view]);
    return 0;
  }
  throw new UsageError(`unknown workers subcommand "${sub}"`);
}

async function jobs(parsed: ParsedArgs, io: CliIo): Promise<number> {
  const client = adminClient(parsed, io);
  const sub = requirePositional(parsed, 1, "jobs subcommand (list|show|cancel|retry|resolve)");
  if (sub === "list") {
    const page = await client.get<JobPage>("/jobs", {
      state: stringOption(parsed, "state"),
      limit: stringOption(parsed, "limit"),
      cursor: stringOption(parsed, "cursor"),
    });
    if (parsed.values.json) printJson(io, page);
    else printJobs(io, page);
    return 0;
  }
  const jobId = requirePositional(parsed, 2, "jobId");
  if (sub === "show") {
    printJson(io, await client.get(`/jobs/${encodeURIComponent(jobId)}`));
    return 0;
  }
  if (sub === "cancel" || sub === "retry" || sub === "resolve") {
    const job = await client.post<JobRow>(`/jobs/${encodeURIComponent(jobId)}/${sub}`);
    if (parsed.values.json) printJson(io, job);
    else io.out(`${job.id} (${job.issueKey}) is now ${job.state}`);
    return 0;
  }
  throw new UsageError(`unknown jobs subcommand "${sub}"`);
}

async function reports(parsed: ParsedArgs, io: CliIo): Promise<number> {
  const client = adminClient(parsed, io);
  const sub = requirePositional(parsed, 1, "reports subcommand (list|retry)");
  if (sub === "list") {
    const { batches } = await client.get<{ batches: AdminBlockedBatch[] }>("/reports");
    if (parsed.values.json) printJson(io, batches);
    else printBlockedReports(io, batches);
    return 0;
  }
  if (sub === "retry") {
    const batchId = requirePositional(parsed, 2, "batchId");
    const result = await client.post<{ requeued: number }>(
      `/reports/${encodeURIComponent(batchId)}/retry`,
    );
    io.out(`${result.requeued} step(s) of ${batchId} queued again; the worker is not re-run`);
    return 0;
  }
  throw new UsageError(`unknown reports subcommand "${sub}"`);
}

export async function runRouterCli(args: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = args;
  switch (command) {
    case "setup":
      return setup(
        parseCommandArgs(rest, { config: { type: "string" }, force: { type: "boolean" } }),
        io,
      );
    case "serve":
      return serve(
        parseCommandArgs(rest, {
          config: { type: "string" },
          secrets: { type: "string" },
          host: { type: "string" },
          port: { type: "string" },
        }),
        io,
      );
    case "check":
      return check(
        parseCommandArgs(rest, {
          config: { type: "string" },
          secrets: { type: "string" },
          issue: { type: "string" },
        }),
        io,
      );
    case "workers":
      return workers(parseCommandArgs(args, COMMON_OPTIONS), io);
    case "jobs":
      return jobs(
        parseCommandArgs(args, {
          ...COMMON_OPTIONS,
          state: { type: "string" },
          limit: { type: "string" },
          cursor: { type: "string" },
        }),
        io,
      );
    case "reports":
      return reports(parseCommandArgs(args, COMMON_OPTIONS), io);
    case "reconcile": {
      const parsed = parseCommandArgs(args, COMMON_OPTIONS);
      printJson(io, await adminClient(parsed, io).post("/reconcile"));
      return 0;
    }
    case "backup": {
      const parsed = parseCommandArgs(args, COMMON_OPTIONS);
      const result = await adminClient(parsed, io).post<{ path: string; bytes: number }>("/backup");
      io.out(`Backup written on the Router host: ${result.path} (${result.bytes} bytes)`);
      return 0;
    }
    case "status": {
      const parsed = parseCommandArgs(args, COMMON_OPTIONS);
      const status = await adminClient(parsed, io).get<RouterStatus>("/status");
      if (parsed.values.json) printJson(io, status);
      else printStatus(io, status);
      return 0;
    }
    case undefined:
    case "help":
    case "--help":
      io.out(ROUTER_USAGE);
      return command === undefined ? 2 : 0;
    default:
      throw new UsageError(`unknown router command "${command}"\n\n${ROUTER_USAGE}`);
  }
}
