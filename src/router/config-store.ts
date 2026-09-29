import { randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { type RouterConfig, RouterConfigError, RouterConfigSchema } from "./config.js";
import { type RouterEnvSecrets, SECRET_ENV_KEYS } from "./secrets.js";

/**
 * Reading and writing the Router's config and secrets files for `router setup` and the web UI
 * (ADR 0023). A running Router applies a saved config in place, except for the connection
 * settings in `RESTART_ONLY_SETTINGS` (ADR 0024).
 */

export interface ConfigIssue {
  path: string;
  message: string;
}

export type ConfigValidation =
  | { ok: true; config: RouterConfig }
  | { ok: false; issues: ConfigIssue[] };

export function validateRouterConfig(raw: unknown): ConfigValidation {
  const result = RouterConfigSchema.safeParse(raw);
  if (result.success) return { ok: true, config: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  };
}

/** Settings bound to the open HTTP listener, SQLite file or Jira client; they need a restart. */
export const RESTART_ONLY_SETTINGS: ReadonlyArray<{
  label: string;
  pick: (config: RouterConfig) => unknown;
}> = [
  { label: "http", pick: (config) => config.http },
  { label: "db.path", pick: (config) => config.db.path },
  { label: "jira.baseUrl", pick: (config) => config.jira.baseUrl },
  { label: "executionAgent.fieldId", pick: (config) => config.executionAgent?.fieldId },
];

/** Which restart-only settings differ between the config the process started with and `next`. */
export function restartOnlyChanges(started: RouterConfig, next: RouterConfig): string[] {
  return RESTART_ONLY_SETTINGS.filter(
    ({ pick }) => canonicalJson(pick(started)) !== canonicalJson(pick(next)),
  ).map(({ label }) => label);
}

/** JSON with object keys sorted, so key order never reads as a config change. */
export function canonicalJson(value: unknown): string {
  return (
    JSON.stringify(value, (_key, node: unknown) =>
      node && typeof node === "object" && !Array.isArray(node)
        ? Object.fromEntries(Object.entries(node).sort(([a], [b]) => a.localeCompare(b)))
        : node,
    ) ?? "undefined"
  );
}

/** The file's JSON as written (defaults not filled in), for editing. */
export function readRawRouterConfig(configPath: string): unknown {
  let text: string;
  try {
    text = readFileSync(configPath, "utf-8");
  } catch (error) {
    throw new RouterConfigError(`Failed to read router config file at ${configPath}`, error);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new RouterConfigError(`Router config file at ${configPath} is not valid JSON`, error);
  }
}

function writeAtomic(target: string, content: string, mode?: number): void {
  mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { encoding: "utf-8", ...(mode !== undefined ? { mode } : {}) });
  renameSync(tmp, target);
}

/** Writes the config the caller already validated, keeping the previous file as `<path>.bak`. */
export function writeRouterConfig(configPath: string, raw: unknown): void {
  if (existsSync(configPath)) copyFileSync(configPath, `${configPath}.bak`);
  writeAtomic(configPath, `${JSON.stringify(raw, null, 2)}\n`);
}

/** Owner-only `KEY=VALUE` file in the same format as docker's `env_file`. */
export function writeRouterSecretsFile(secretsPath: string, secrets: RouterEnvSecrets): void {
  const lines = [
    "# GGJIRA Router secrets — keep this file private (mode 0600). Environment variables win.",
    ...(Object.keys(SECRET_ENV_KEYS) as Array<keyof RouterEnvSecrets>).map(
      (key) => `${SECRET_ENV_KEYS[key]}=${secrets[key]}`,
    ),
  ];
  writeAtomic(secretsPath, `${lines.join("\n")}\n`, 0o600);
}

/**
 * Sets (or with `null` removes) one `KEY=VALUE` line in the secrets file, keeping every other line
 * and comment, and leaves the file owner-only (ADR 0031). The caller validates `value`.
 */
export function setSecretsFileValue(secretsPath: string, key: string, value: string | null): void {
  const lines = existsSync(secretsPath)
    ? readFileSync(secretsPath, "utf-8").replace(/\n$/, "").split(/\r?\n/)
    : ["# GGJIRA Router secrets — keep this file private (mode 0600). Environment variables win."];
  const isKeyLine = (line: string) => line.trim().startsWith(`${key}=`);
  const kept = lines.filter((line) => !isKeyLine(line));
  const index = lines.findIndex(isKeyLine);
  if (value !== null) {
    const entry = `${key}=${value}`;
    if (index === -1) kept.push(entry);
    else kept.splice(index, 0, entry);
  }
  writeAtomic(secretsPath, `${kept.join("\n")}\n`, 0o600);
  chmodSync(secretsPath, 0o600);
}

/** Default secrets file: `router.env` next to the config file. */
export function defaultSecretsPath(configPath: string): string {
  return path.join(path.dirname(configPath), "router.env");
}

export function randomSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function routerConfigTemplate(): Record<string, unknown> {
  return {
    configVersion: 5,
    jira: { baseUrl: "https://your-site.atlassian.net" },
    repositories: [{ id: "main-repo", displayName: "Main repository" }],
    workspaces: [
      {
        id: "default",
        repositoryId: "main-repo",
        projectKeys: ["PROJ"],
        workflow: {
          requestStatus: "AI 작업 요청",
          inProgressStatus: "작업 중",
          reviewStatus: "AI 작업 완료",
        },
      },
    ],
    workers: [
      {
        workerId: "worker-1",
        allowedCapabilities: ["programming", "testing"],
        allowedRepositoryIds: ["main-repo"],
        providerId: "default",
      },
    ],
    db: { path: "data/router.sqlite3" },
    http: { host: "127.0.0.1", port: 8787 },
  };
}
