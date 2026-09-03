import { readFileSync } from "node:fs";
import { z } from "zod";

const AgentRoleSchema = z.enum(["pm", "implement"]);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

const JiraConfigSchema = z.object({
  baseUrl: z.string().url(),
  /** Overrides the JQL the runtime would otherwise derive from agent identity + workflow.readyStatus. */
  jql: z.string().min(1).optional(),
});

const AgentConfigSchema = z.object({
  identity: z.string().min(1),
  role: AgentRoleSchema,
  machine: z.string().min(1),
});

const WorkflowConfigSchema = z.object({
  readyStatus: z.string().min(1).default("To Do"),
  claimTransitionName: z.string().min(1).default("In Progress"),
  doneTransitionName: z.string().min(1).default("In Review"),
  failureLabel: z.string().min(1).default("ggjira-failed"),
  /** Required when agent.role is "pm". */
  needsDecisionTransitionName: z.string().min(1).optional(),
  /** Optional transition applied to a parent issue once its plan has been applied. */
  plannedTransitionName: z.string().min(1).nullable().default(null),
});

const WorkspaceConfigSchema = z.object({
  path: z.string().min(1),
  baseBranch: z.string().min(1).default("main"),
  /** Shell command run inside the worktree after the worker finishes; failure fails the job. */
  validateCommand: z.string().min(1).nullable().default(null),
});

const ClaudeCodeProviderOptionsSchema = z.object({
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),
  permissionMode: z
    .enum(["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"])
    .default("acceptEdits"),
  allowedTools: z.array(z.string()).default(["Edit", "Write", "Read", "Glob", "Grep"]),
});

const CodexProviderOptionsSchema = z.object({
  sandbox: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .default("workspace-write"),
});

const ProviderConfigSchema = z
  .object({
    type: z.enum(["claude-code", "codex"]).default("claude-code"),
    command: z.string().min(1).optional(),
    model: z.string().min(1).default("sonnet"),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .default(30 * 60 * 1000),
    claudeCode: ClaudeCodeProviderOptionsSchema.default({}),
    codex: CodexProviderOptionsSchema.default({}),
  })
  .transform((provider) => ({
    ...provider,
    command: provider.command ?? (provider.type === "codex" ? "codex" : "claude"),
  }));

const PmConfigSchema = z.object({
  /** Jira account email or accountId assigned to executable subtasks the PM creates. */
  implementAssignee: z.string().min(1).optional(),
  subtaskIssueType: z.string().min(1).default("Subtask"),
  taskReadyTransitionName: z.string().min(1).nullable().default(null),
  maxTasksPerPlan: z.number().int().positive().default(20),
});

const PollingConfigSchema = z.object({
  intervalMs: z.number().int().positive().default(60000),
});

export const AppConfigSchema = z
  .object({
    jira: JiraConfigSchema,
    agent: AgentConfigSchema,
    workflow: WorkflowConfigSchema.default({}),
    workspace: WorkspaceConfigSchema,
    provider: ProviderConfigSchema.default({}),
    pm: PmConfigSchema.default({}),
    polling: PollingConfigSchema.default({ intervalMs: 60000 }),
  })
  .superRefine((config, ctx) => {
    if (config.agent.role !== "pm") return;
    if (!config.pm.implementAssignee) {
      ctx.addIssue({
        code: "custom",
        path: ["pm", "implementAssignee"],
        message: 'pm.implementAssignee is required when agent.role is "pm"',
      });
    }
    if (!config.workflow.needsDecisionTransitionName) {
      ctx.addIssue({
        code: "custom",
        path: ["workflow", "needsDecisionTransitionName"],
        message: 'workflow.needsDecisionTransitionName is required when agent.role is "pm"',
      });
    }
  });

export type AppConfig = z.infer<typeof AppConfigSchema>;

const JiraEnvSecretsSchema = z.object({
  email: z.string().email(),
  apiToken: z.string().min(1),
  baseUrlOverride: z.string().url().optional(),
});

export type JiraEnvSecrets = z.infer<typeof JiraEnvSecretsSchema>;

export interface JiraSecrets {
  baseUrl: string;
  email: string;
  apiToken: string;
}

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * A v1 config (pre-2차) has no "agent" key at all — it predates roles/identity.
 * Loading one should point at `ggjira setup` rather than fail with an opaque
 * zod error about a missing required field.
 */
function isLikelyV1Config(parsed: unknown): boolean {
  return typeof parsed === "object" && parsed !== null && !("agent" in parsed);
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

  if (isLikelyV1Config(parsed)) {
    throw new ConfigError(
      `Config file at ${configPath} looks like a GGJIRA v1 config (no "agent" section). Run "ggjira setup" to migrate it to the current schema.`,
    );
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

export function loadJiraSecretsFromEnv(env: NodeJS.ProcessEnv = process.env): JiraEnvSecrets {
  const result = JiraEnvSecretsSchema.safeParse({
    email: env.JIRA_EMAIL,
    apiToken: env.JIRA_API_TOKEN,
    baseUrlOverride: env.JIRA_BASE_URL || undefined,
  });
  if (!result.success) {
    throw new ConfigError(
      `Missing or invalid Jira credentials in environment: ${result.error.message}`,
      result.error,
    );
  }
  return result.data;
}

/** Merges config.jira.baseUrl with an optional env override into the shape JiraClient needs. */
export function resolveJiraSecrets(config: AppConfig, env: JiraEnvSecrets): JiraSecrets {
  return {
    baseUrl: env.baseUrlOverride ?? config.jira.baseUrl,
    email: env.email,
    apiToken: env.apiToken,
  };
}
