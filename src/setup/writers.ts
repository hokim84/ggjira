import { chmodSync, existsSync, renameSync, writeFileSync } from "node:fs";

export interface EnvSecretsToWrite {
  email: string;
  apiToken: string;
}

/** Writes .env with restrictive permissions, backing up any existing file rather than clobbering it. */
export function writeEnvFile(envPath: string, secrets: EnvSecretsToWrite): void {
  if (existsSync(envPath)) renameSync(envPath, `${envPath}.bak`);
  const content = [`JIRA_EMAIL=${secrets.email}`, `JIRA_API_TOKEN=${secrets.apiToken}`, ""].join(
    "\n",
  );
  writeFileSync(envPath, content, { mode: 0o600 });
  try {
    chmodSync(envPath, 0o600);
  } catch {
    // best-effort: some platforms/filesystems don't support POSIX permissions
  }
}

/** Writes the config as the minimal object the wizard built (not the zod-resolved AppConfig with all defaults filled in). */
export function writeConfigFile(configPath: string, config: unknown): void {
  if (existsSync(configPath)) renameSync(configPath, `${configPath}.bak`);
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}
