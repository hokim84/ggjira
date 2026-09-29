import { readFileSync } from "node:fs";
import { z } from "zod";

/**
 * Jira token, webhook secret, and admin API token live in the Router process's environment or in
 * a separate `KEY=VALUE` secrets file — never in the config file
 * (docs/router-service-implementation-plan.md §3, ADR 0023).
 */
const RouterEnvSecretsSchema = z.object({
  jiraEmail: z.string().email(),
  jiraApiToken: z.string().min(1),
  /** Signs/verifies `X-Hub-Signature` on incoming Jira webhooks (SHA-256 only). */
  webhookSecret: z.string().min(16),
  /** Bearer token the `ggjira router *` admin CLI and web UI authenticate with. */
  adminToken: z.string().min(16),
});
export type RouterEnvSecrets = z.infer<typeof RouterEnvSecretsSchema>;

export const SECRET_ENV_KEYS = {
  jiraEmail: "JIRA_EMAIL",
  jiraApiToken: "JIRA_API_TOKEN",
  webhookSecret: "GGJIRA_WEBHOOK_SECRET",
  adminToken: "GGJIRA_ADMIN_TOKEN",
} as const satisfies Record<keyof RouterEnvSecrets, string>;

export class RouterSecretsError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "RouterSecretsError";
  }
}

export function loadRouterSecretsFromEnv(env: NodeJS.ProcessEnv = process.env): RouterEnvSecrets {
  const result = RouterEnvSecretsSchema.safeParse({
    jiraEmail: env[SECRET_ENV_KEYS.jiraEmail],
    jiraApiToken: env[SECRET_ENV_KEYS.jiraApiToken],
    webhookSecret: env[SECRET_ENV_KEYS.webhookSecret],
    adminToken: env[SECRET_ENV_KEYS.adminToken],
  });
  if (!result.success) {
    throw new RouterSecretsError(
      `Missing or invalid Router credentials in environment: ${result.error.message}`,
      result.error,
    );
  }
  return result.data;
}

/** Parses the docker `env_file` subset: `KEY=VALUE` lines, `#` comments, optional quotes. */
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

/**
 * Environment first, then the secrets file for whatever the environment leaves unset. A missing
 * secrets file is not an error by itself — only the combined result has to be complete.
 */
export function loadRouterSecrets(
  env: NodeJS.ProcessEnv,
  secretsPath: string | undefined,
): RouterEnvSecrets {
  let fileValues: Record<string, string> = {};
  if (secretsPath) {
    let text: string | undefined;
    try {
      text = readFileSync(secretsPath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new RouterSecretsError(`Failed to read secrets file at ${secretsPath}`, error);
      }
    }
    if (text !== undefined) fileValues = parseEnvFile(text);
  }
  const merged: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.values(SECRET_ENV_KEYS)) {
    if (!merged[key] && fileValues[key]) merged[key] = fileValues[key];
  }
  return loadRouterSecretsFromEnv(merged);
}

/** Optional GitHub integration secrets (ADR 0027), from the environment or the secrets file. */
export interface RouterGithubSecrets {
  /** Verifies `X-Hub-Signature-256` on `/webhooks/github`; the route is off without it. */
  webhookSecret?: string;
  /** Read-only token for polling pull requests; public repositories work without one. */
  token?: string;
}

export function loadRouterGithubSecrets(
  env: NodeJS.ProcessEnv,
  secretsPath: string | undefined,
): RouterGithubSecrets {
  let file: Record<string, string> = {};
  if (secretsPath) {
    try {
      file = parseEnvFile(readFileSync(secretsPath, "utf-8"));
    } catch {
      file = {};
    }
  }
  const pick = (key: string) => env[key] || file[key] || undefined;
  const webhookSecret = pick("GGJIRA_GITHUB_WEBHOOK_SECRET");
  if (webhookSecret !== undefined && webhookSecret.length < 16) {
    throw new RouterSecretsError("GGJIRA_GITHUB_WEBHOOK_SECRET must be at least 16 characters");
  }
  const token = pick("GITHUB_TOKEN");
  return {
    ...(webhookSecret ? { webhookSecret } : {}),
    ...(token ? { token } : {}),
  };
}

export const JEV_API_KEY_ENV = "TYPESAFE_API_KEY";
export const GITHUB_TOKEN_ENV = "GITHUB_TOKEN";

/** What the web UI accepts as a secret (Jev key, GitHub token): one token of URL-safe characters.
 *  Anything that could break the `KEY=VALUE` line (whitespace, newlines, quotes, `#`) is refused
 *  (ADR 0031). */
export const SecretValueSchema = z
  .string()
  .regex(/^[A-Za-z0-9._~+/=:-]{8,512}$/, "8-512 characters: letters, digits and ._~+/=:-");

/** `TYPESAFE_API_KEY` for Jev (ADR 0030), environment first, then the secrets file. Optional:
 *  without it the Jev assessment is off. */
export function loadRouterJevApiKey(
  env: NodeJS.ProcessEnv,
  secretsPath: string | undefined,
): string | undefined {
  if (env.TYPESAFE_API_KEY) return env.TYPESAFE_API_KEY;
  if (!secretsPath) return undefined;
  try {
    return parseEnvFile(readFileSync(secretsPath, "utf-8")).TYPESAFE_API_KEY || undefined;
  } catch {
    return undefined;
  }
}
