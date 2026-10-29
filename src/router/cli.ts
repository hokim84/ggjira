import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
import {
  type CliIo,
  type ParsedArgs,
  UsageError,
  formatTable,
  parseCommandArgs,
  printCheckItems,
  requirePositional,
  stringOption,
} from "../cli-io.js";
import { JiraClient } from "../jira/client.js";
import { rootLogger } from "../logger.js";
import { AdminClient } from "./admin-client.js";
import type { AdminBlockedBatch, AdminWorkerView, RouterStatus } from "./admin-service.js";
import { type CheckItem, githubRepositoriesToCheck, runRouterCheck } from "./check.js";
import { defaultSecretsPath, randomSecret, routerConfigTemplate } from "./config-store.js";
import { type RouterConfig, loadRouterConfig } from "./config.js";
import { RouterDaemon } from "./daemon.js";
import type { AttentionItemRow } from "./db/attention.js";
import { openRouterDb, openRouterDbReadOnly } from "./db/connection.js";
import { listPullRequestRepos } from "./db/pull-requests.js";
import type { ExecutionRecordRow, ExecutionTotals } from "./db/execution-records.js";
import type { JobPage, JobRow } from "./db/jobs.js";
import type { ReviewQueueItem, ReviewRecordRow, ReviewTargetRow } from "./db/review-targets.js";
import type { IssueView } from "./issue-view.js";
import {
  GITHUB_TOKEN_ENV,
  JEV_API_KEY_ENV,
  type RouterEnvSecrets,
  RouterSecretsError,
  loadRouterGithubSecrets,
  loadRouterJevApiKey,
  loadRouterSecrets,
  parseEnvFile,
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
  issue show <KEY>                      read-only issue status, delegation stage and blockers
  issue reviews <KEY>                    results pinned for review, and merges seen against them
  attention [--all|--resolved] [--issue KEY]  what a human must look at (open by default)
  reviews [--immediate|--standard] [--held|--all] [--assignee <accountId>] [--parent KEY]
                                         results waiting for a human judgment (pending and held)
  reviews judge <targetId> confirm|hold|rework [--note <text>]
                                         record a judgment; hold and rework need --note and leave
                                         one Jira comment. It approves, moves or merges nothing
  usage [--issue KEY [--children]] [--json]   provider calls and token usage per result
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
  const jevApiKey = loadRouterJevApiKey(io.env, secretsPath(parsed, io));
  const daemon = new RouterDaemon({
    db,
    jira,
    config,
    webhookSecret: secrets.webhookSecret,
    adminToken: secrets.adminToken,
    siteId: new URL(config.jira.baseUrl).host,
    configPath: configFile,
    logger,
    github: {
      webhookSecret: github.webhookSecret,
      token: github.token,
      tokenFromEnvironment: Boolean(io.env[GITHUB_TOKEN_ENV]),
    },
    jev: { apiKey: jevApiKey, fromEnvironment: Boolean(io.env[JEV_API_KEY_ENV]) },
    secretsPath: secretsPath(parsed, io),
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
    message: `config ${configPath(parsed, io)} is valid (configVersion ${config.configVersion})`,
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
  const github = {
    repos: githubRepositoriesToCheck(config, pullRequestReposOf(config.db.path)),
    token: loadRouterGithubSecrets(io.env, secretsPath(parsed, io)).token,
  };
  items.push(
    ...(await runRouterCheck(jira, config, { github, ...(issueKey ? { issueKey } : {}) })),
  );
  return printCheckItems(io, items);
}

/** Repositories of the pull requests Router already follows; none before the first `serve`. */
function pullRequestReposOf(dbPath: string): string[] {
  try {
    const db = openRouterDbReadOnly(dbPath);
    try {
      return listPullRequestRepos(db);
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
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
    w.revokedAt
      ? "revoked"
      : !w.paired
        ? "unpaired"
        : w.busy
          ? "busy"
          : w.online
            ? "online"
            : "offline",
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
    `workers:           ${status.workers.connected} connected (${status.workers.busy} busy) / ${status.workers.paired} paired / ${status.workers.declared} declared`,
  );
  io.out(`recovery required: ${status.recoveryRequired}`);
  io.out(
    `webhook delay:     ${status.webhooks.delayMs === null ? "-" : `${Math.round(status.webhooks.delayMs / 1000)}s`}`,
  );
  io.out(`blocked reports:   ${status.reports.blocked}`);
  io.out(`needs attention:   ${status.attention.open}`);
  io.out(`reviews waiting:   ${status.reviews.waiting}`);
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

function printIssueView(io: CliIo, view: IssueView): void {
  const { delegation } = view;
  io.out(`${view.issueKey}  ${view.summary}`);
  io.out(`  status:   ${view.statusName}`);
  io.out(`  labels:   ${view.labels.length ? view.labels.join(", ") : "(none)"}`);
  io.out(`  stage:    ${delegation.stage}`);
  if (delegation.plan) {
    io.out(
      `  plan:     ${delegation.plan.version} ${delegation.plan.outcome}${delegation.plan.taskIds.length ? ` tasks [${delegation.plan.taskIds.join(", ")}]` : ""}${delegation.plan.closed ? " (closed)" : ""}`,
    );
  }
  if (delegation.deployment) {
    io.out(
      `  approval: ${delegation.deployment.approvalId} ${delegation.deployment.state}${delegation.deployment.reason ? ` — ${delegation.deployment.reason}` : ""}`,
    );
  }
  if (delegation.parentKey) io.out(`  task of:  ${delegation.parentKey}`);
  if (delegation.heldBy) io.out(`  held by:  ${delegation.heldBy}`);
  if (view.openJob) {
    io.out(`  job:      ${view.openJob.jobId} (${view.openJob.kind}, ${view.openJob.state})`);
  }
}

function printReviews(
  io: CliIo,
  view: { targets: ReviewTargetRow[]; records: ReviewRecordRow[] },
): void {
  if (view.targets.length === 0) io.out("no results pinned for review yet");
  for (const target of view.targets) {
    const { assessment } = target;
    const head = target.headSha ? target.headSha.slice(0, 12) : target.commitState;
    io.out(
      `${target.supersededBy ? "  (superseded) " : "* "}${target.id}  ${target.kind} ${target.resultStatus}  ${target.reviewClass}  head ${head}`,
    );
    io.out(`    job ${target.jobId}  attempt ${target.attemptId}  approval ${target.approvalId}`);
    for (const reason of assessment.reasons) io.out(`    needs review: ${reason.detail}`);
    io.out(
      `    high-risk: ${assessment.risk.status}${assessment.risk.policyVersion ? ` (rules ${assessment.risk.policyVersion})` : ""} — ${assessment.risk.basis}`,
    );
    for (const match of assessment.risk.matches) {
      io.out(
        `      ${match.rule}: ${match.from ? `${match.from} -> ` : ""}${match.path} (${match.change})`,
      );
    }
  }
  for (const record of view.records) {
    io.out(
      `  ${record.at}  ${record.action} by ${record.actor ?? "?"} (${record.authentication})  ${record.outcome}${record.targetId ? `  -> ${record.targetId}` : ""}`,
    );
  }
}

/** Read-only issue status and review records. */
async function issue(parsed: ParsedArgs, io: CliIo): Promise<number> {
  const client = adminClient(parsed, io);
  const sub = requirePositional(parsed, 1, "issue subcommand (show|reviews)");
  const key = requirePositional(parsed, 2, "issue key").toUpperCase();
  if (sub === "reviews") {
    const view = await client.get<{ targets: ReviewTargetRow[]; records: ReviewRecordRow[] }>(
      `/issues/${encodeURIComponent(key)}/reviews`,
    );
    if (parsed.values.json) printJson(io, view);
    else printReviews(io, view);
    return 0;
  }
  const endpoint = `/issues/${encodeURIComponent(key)}`;
  if (sub === "show") {
    const view = await client.get<IssueView>(endpoint);
    if (parsed.values.json) printJson(io, view);
    else printIssueView(io, view);
    return 0;
  }
  throw new UsageError(`unknown issue subcommand "${sub}"`);
}

const tokens = (value: number | null): string => (value === null ? "?" : String(value));

/** `usage` (M4-12): read-only execution evidence; `--json` is the export. */
async function usage(parsed: ParsedArgs, io: CliIo): Promise<number> {
  const client = adminClient(parsed, io);
  const query = new URLSearchParams();
  const issueKey = stringOption(parsed, "issue");
  if (issueKey) query.set("issue", issueKey);
  if (parsed.values.children) query.set("children", "true");
  const view = await client.get<{ records: ExecutionRecordRow[]; totals: ExecutionTotals }>(
    `/executions?${query}`,
  );
  if (parsed.values.json) {
    printJson(io, view);
    return 0;
  }
  for (const record of view.records) {
    const usageText = record.usageReported
      ? `in ${tokens(record.inputTokens)} out ${tokens(record.outputTokens)} cache-read ${tokens(record.cacheReadTokens)}${record.cacheReadIncluded ? " (inside in)" : ""}`
      : "usage not reported";
    io.out(
      `${record.recordedAt}  ${record.issueKey}${record.parentIssueKey ? ` (of ${record.parentIssueKey})` : ""}  ${record.kind} ${record.runType}  ${record.resultStatus}${record.applied ? "" : " (not applied)"}`,
    );
    io.out(
      `    ${record.providerId ?? "?"} ${record.model ?? "?"}${record.modelSource === "configured" ? " (configured)" : ""}  ${record.exitReason ?? "?"}  ${usageText}  cause ${record.causeCategory}`,
    );
  }
  const t = view.totals;
  io.out(
    `total: ${t.records} result(s), usage not reported for ${t.usageUnreported}; in ${t.inputTokens} (of which cache ${t.cacheReadTokensInsideInput}), out ${t.outputTokens}, cache-read on top ${t.cacheReadTokensOnTop}, cache-write ${t.cacheCreationTokens}, cost $${t.costUsd}`,
  );
  return 0;
}

/** `attention` (M4-09): read-only list of attention items. */
async function attention(parsed: ParsedArgs, io: CliIo): Promise<number> {
  const client = adminClient(parsed, io);
  const query = new URLSearchParams();
  query.set("status", parsed.values.all ? "all" : parsed.values.resolved ? "resolved" : "open");
  const issueKey = stringOption(parsed, "issue");
  if (issueKey) query.set("issue", issueKey);
  const { items } = await client.get<{ items: AttentionItemRow[] }>(`/attention?${query}`);
  if (parsed.values.json) {
    printJson(io, items);
    return 0;
  }
  if (items.length === 0) io.out("nothing needs attention");
  for (const item of items) {
    const times = item.occurrences > 1 ? ` x${item.occurrences} since ${item.firstSeenAt}` : "";
    io.out(
      `${item.status === "open" ? "!" : "-"} ${item.issueKey}  ${item.kind}  ${item.lastSeenAt}${times}`,
    );
    io.out(`    ${item.reason}`);
    if (item.previousId) io.out(`    recurred after ${item.previousId}`);
    if (item.resolution) io.out(`    resolved ${item.resolvedAt}: ${item.resolution}`);
  }
  return 0;
}

function printReviewQueue(io: CliIo, items: ReviewQueueItem[]): void {
  if (items.length === 0) io.out("nothing waits for review");
  for (const item of items) {
    const { target } = item;
    const head = target.headSha ? target.headSha.slice(0, 12) : target.commitState;
    io.out(
      `${target.reviewClass === "immediate" ? "!" : "-"} ${target.issueKey}  ${item.state}  ${target.kind} ${target.resultStatus}  head ${head}  ${target.id}`,
    );
    if (item.issue.summary) io.out(`    ${item.issue.summary}`);
    if (item.result.summary) io.out(`    result: ${item.result.summary}`);
    const v = target.assessment.verification;
    if (v.reported) {
      const methods =
        v.executed !== undefined ? `; ${v.executed} executed, ${v.inspected ?? 0} inspected` : "";
      io.out(
        `    acceptance: ${v.pass} pass, ${v.fail} fail, ${v.notVerified} not verified${methods}`,
      );
    }
    for (const reason of target.assessment.reasons) io.out(`    needs review: ${reason.detail}`);
    if (item.result.pullRequest) io.out(`    pull request: ${item.result.pullRequest.url}`);
    if (item.judgment) {
      io.out(
        `    ${item.judgment.action} by ${item.judgment.actor ?? "?"} (${item.judgment.authentication}) ${item.judgment.at}`,
      );
    }
  }
}

/** `reviews [judge]` (F01, ADR 0043): the review queue and per-item judgments. */
async function reviews(parsed: ParsedArgs, io: CliIo): Promise<number> {
  const client = adminClient(parsed, io);
  const sub = parsed.positionals[1];
  if (sub === "judge") {
    const targetId = requirePositional(parsed, 2, "review target id");
    const action = requirePositional(parsed, 3, "confirm|hold|rework");
    const note = stringOption(parsed, "note");
    const record = await client.post<ReviewRecordRow>(
      `/reviews/${encodeURIComponent(targetId)}/judgments`,
      { action, ...(note ? { note } : {}) },
    );
    if (parsed.values.json) printJson(io, record);
    else {
      io.out(
        `${record.issueKey}: ${record.action} recorded as ${record.actor ?? "?"} (${record.authentication})`,
      );
      io.out(
        action === "confirm"
          ? "  Recorded in Router only. Nothing was approved, moved or merged."
          : "  A Jira comment is queued. Nothing was approved, moved or merged.",
      );
    }
    return 0;
  }
  if (sub !== undefined) throw new UsageError(`unknown reviews subcommand "${sub}"`);
  const query = new URLSearchParams();
  if (parsed.values.immediate) query.set("class", "immediate");
  else if (parsed.values.standard) query.set("class", "standard");
  if (parsed.values.held) query.set("state", "held");
  else if (parsed.values.all)
    query.set("state", "pending,held,confirmed,rework_requested,merged,closed,outdated");
  const assignee = stringOption(parsed, "assignee");
  if (assignee) query.set("assignee", assignee);
  const parent = stringOption(parsed, "parent");
  if (parent) query.set("parent", parent);
  const { items } = await client.get<{ items: ReviewQueueItem[] }>(`/reviews?${query}`);
  if (parsed.values.json) printJson(io, items);
  else printReviewQueue(io, items);
  return 0;
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
    case "issue":
      return issue(parseCommandArgs(args, COMMON_OPTIONS), io);
    case "usage":
      return usage(
        parseCommandArgs(args, {
          ...COMMON_OPTIONS,
          issue: { type: "string" },
          children: { type: "boolean" },
        }),
        io,
      );
    case "attention":
      return attention(
        parseCommandArgs(args, {
          ...COMMON_OPTIONS,
          all: { type: "boolean" },
          resolved: { type: "boolean" },
          issue: { type: "string" },
        }),
        io,
      );
    case "reviews":
      return reviews(
        parseCommandArgs(args, {
          ...COMMON_OPTIONS,
          immediate: { type: "boolean" },
          standard: { type: "boolean" },
          held: { type: "boolean" },
          all: { type: "boolean" },
          assignee: { type: "string" },
          parent: { type: "string" },
          note: { type: "string" },
        }),
        io,
      );
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
