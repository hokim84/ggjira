import { readFileSync } from "node:fs";
import { z } from "zod";

const WorkerConfigSchema = z.object({
  command: z.string().min(1).default("claude"),
  model: z.string().min(1).default("sonnet"),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .default(30 * 60 * 1000),
  permissionMode: z
    .enum(["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"])
    .default("acceptEdits"),
  allowedTools: z.array(z.string()).default(["Edit", "Write", "Read", "Glob", "Grep"]),
});

const JiraWorkflowConfigSchema = z.object({
  jql: z.string().min(1),
  inProgressTransitionName: z.string().min(1),
  successTransitionName: z.string().min(1),
  failureLabel: z.string().min(1).default("ggjira-failed"),
});

const PollingConfigSchema = z.object({
  intervalMs: z.number().int().positive().default(60000),
});

const TargetRepoConfigSchema = z.object({
  path: z.string().min(1),
  baseBranch: z.string().min(1).default("main"),
});

const ConcurrencyConfigSchema = z.object({
  maxConcurrentJobs: z.number().int().positive().default(1),
});

export const AppConfigSchema = z.object({
  jira: JiraWorkflowConfigSchema,
  polling: PollingConfigSchema.default({ intervalMs: 60000 }),
  targetRepo: TargetRepoConfigSchema,
  worker: WorkerConfigSchema.default({}),
  concurrency: ConcurrencyConfigSchema.default({ maxConcurrentJobs: 1 }),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

const JiraSecretsSchema = z.object({
  baseUrl: z.string().url(),
  email: z.string().email(),
  apiToken: z.string().min(1),
});

export type JiraSecrets = z.infer<typeof JiraSecretsSchema>;

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

export function loadAppConfig(configPath: string): AppConfig {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch (error) {
    throw new ConfigError(`Failed to read config file at ${configPath}`, error);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`Config file at ${configPath} is not valid JSON`, error);
  }

  const result = AppConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(
      `Config file at ${configPath} failed validation: ${result.error.message}`,
      result.error,
    );
  }
  return result.data;
}

export function loadJiraSecretsFromEnv(env: NodeJS.ProcessEnv = process.env): JiraSecrets {
  const result = JiraSecretsSchema.safeParse({
    baseUrl: env.JIRA_BASE_URL,
    email: env.JIRA_EMAIL,
    apiToken: env.JIRA_API_TOKEN,
  });
  if (!result.success) {
    throw new ConfigError(
      `Missing or invalid Jira credentials in environment: ${result.error.message}`,
      result.error,
    );
  }
  return result.data;
}
