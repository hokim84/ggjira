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
