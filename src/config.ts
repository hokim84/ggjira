import { readFileSync } from "node:fs";
import { z } from "zod";

const AgentRoleSchema = z.enum(["pm", "implement"]);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

const JiraConfigSchema = z.object({
  baseUrl: z.string().url(),
  /** Overrides the JQL the runtime would otherwise derive from agent identity + workflow.readyStatus. */
  jql: z.string().min(1).optional(),
  /** Scopes Agent Profile / Workspace Configuration issue lookups (profile mode only). */
  projectKey: z.string().min(1).optional(),
  /** Cached key of the `[GGJIRA] Workspace Configuration` issue found/created at setup. */
  workspaceIssueKey: z.string().min(1).optional(),
});

const AgentConfigSchema = z.object({
  identity: z.string().min(1),
  role: AgentRoleSchema,
  machine: z.string().min(1),
  /** Key of this agent's `[AGENT] <id>` profile issue; presence enables profile mode. */
  profileKey: z.string().min(1).optional(),
  /** UUID generated once at setup and kept across re-runs; identifies this installation for claiming a profile. */
  machineId: z.string().uuid().optional(),
  /** Local execution environments. Human-facing capabilities remain in the Jira profile. */
  backends: z.array(z.string().min(1)).optional(),
});

/**
 * Normalizes to NFC (Unicode's precomposed form). These fields are compared
 * for exact equality against status/transition names Jira's REST API
 * returns (agent/claim.ts, poller/poller.ts's JQL) -- Jira's own values are
 * NFC, but text typed or pasted through some editors/IMEs (this bites
 * non-Latin scripts especially, e.g. Korean Hangul) can end up NFD instead.
 * NFC and NFD render identically but are different byte sequences, so an
 * un-normalized value silently never matches even when it looks correct on
 * screen.
 */
function nfc(value: string): string {
  return value.normalize("NFC");
}

const WorkflowConfigSchema = z.object({
  readyStatus: z.string().min(1).default("To Do").transform(nfc),
  claimTransitionName: z.string().min(1).default("In Progress").transform(nfc),
  doneTransitionName: z.string().min(1).default("In Review").transform(nfc),
  failureLabel: z.string().min(1).default("ggjira-failed"),
  planningStatus: z
    .string()
    .min(1)
    .optional()
    .transform((s) => (s ? nfc(s) : s)),
  planningInProgressStatus: z
    .string()
    .min(1)
    .optional()
    .transform((s) => (s ? nfc(s) : s)),
  planReviewStatus: z
    .string()
    .min(1)
    .optional()
    .transform((s) => (s ? nfc(s) : s)),
  executionApprovedStatus: z
    .string()
    .min(1)
    .optional()
    .transform((s) => (s ? nfc(s) : s)),
  taskWaitingStatus: z
    .string()
    .min(1)
    .optional()
    .transform((s) => (s ? nfc(s) : s)),
  implementationStatus: z
    .string()
    .min(1)
    .optional()
    .transform((s) => (s ? nfc(s) : s)),
  /**
   * v4 status-based workflow (ADR 0015). Setup asks for these three board
   * statuses and nothing else; the transition that reaches each one is
   * resolved at run time (`transitionIssueToStatus`), so a project's own
   * transition labels -- in any language -- never enter the config.
   *
   *   human -> implementationStatus -> [agent claims] inProgressStatus
   *         -> [implementation done] reviewStatus -> human
   */
  inProgressStatus: z
    .string()
    .min(1)
    .optional()
    .transform((s) => (s ? nfc(s) : s)),
  reviewStatus: z
    .string()
    .min(1)
    .optional()
    .transform((s) => (s ? nfc(s) : s)),
  /** Optional, PM only: where an issue goes when the agent needs a human decision. */
  needsDecisionStatus: z
    .string()
    .min(1)
    .optional()
    .transform((s) => (s ? nfc(s) : s)),
  completionStatus: z
    .string()
    .min(1)
    .optional()
    .transform((s) => (s ? nfc(s) : s)),
  /** Required when agent.role is "pm". */
  needsDecisionTransitionName: z
    .string()
    .min(1)
    .optional()
    .transform((s) => (s === undefined ? s : nfc(s))),
  /** Optional transition applied to a parent issue once its plan has been applied. */
  plannedTransitionName: z
    .string()
    .min(1)
    .nullable()
    .default(null)
    .transform((s) => (s === null ? s : nfc(s))),
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
  subtaskIssueType: z.string().min(1).default("Subtask").transform(nfc),
  taskReadyTransitionName: z
    .string()
    .min(1)
    .nullable()
    .default(null)
    .transform((s) => (s === null ? s : nfc(s))),
  maxTasksPerPlan: z.number().int().positive().default(20),
});

const PollingConfigSchema = z.object({
  intervalMs: z.number().int().positive().default(60000),
});

const DistributionConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    executionAgentFieldId: z
      .string()
      .trim()
      .min(1)
      .transform((value) => (/^\d+$/.test(value) ? `customfield_${value}` : value))
      .optional(),
    executionAgentOptionId: z.string().min(1).optional(),
    workspaceId: z.string().min(1).optional(),
  })
  .default({ enabled: false });

export const AppConfigSchema = z
  .object({
    /** Absent or 2 = the pre-Agent-Profile config shape ("legacy mode"). 3 = profile-capable. */
    configVersion: z.number().int().optional(),
    jira: JiraConfigSchema,
    agent: AgentConfigSchema,
    workflow: WorkflowConfigSchema.default({}),
    workspace: WorkspaceConfigSchema,
    provider: ProviderConfigSchema.default({}),
    pm: PmConfigSchema.default({}),
    polling: PollingConfigSchema.default({ intervalMs: 60000 }),
    distribution: DistributionConfigSchema,
  })
  .superRefine((config, ctx) => {
    // v4 drives every Jira move from a board status, so the three statuses of
    // the AI request -> in progress -> review loop must all be present. A v4
    // config written before ADR 0015 only has transition names; failing here
    // (instead of silently falling back) is what turns that into a fixable
    // "rerun setup" message rather than a transition error mid-run.
    if (config.configVersion === 4) {
      for (const field of ["implementationStatus", "inProgressStatus", "reviewStatus"] as const) {
        if (config.workflow[field]) continue;
        ctx.addIssue({
          code: "custom",
          path: ["workflow", field],
          message: `workflow.${field} is required — run "ggjira setup" to pick your project's Jira statuses`,
        });
      }
      if (config.distribution.enabled) {
        const distributionStatusFields = [
          "implementationStatus",
          "inProgressStatus",
          "reviewStatus",
          "planningStatus",
          "planningInProgressStatus",
          "planReviewStatus",
          "executionApprovedStatus",
          "taskWaitingStatus",
        ] as const;
        for (const field of distributionStatusFields) {
          if (config.workflow[field]) continue;
          ctx.addIssue({
            code: "custom",
            path: ["workflow", field],
            message: `workflow.${field} is required when human distribution is enabled`,
          });
        }
        const configuredStatuses = distributionStatusFields
          .map((field) => config.workflow[field])
          .filter((status): status is string => Boolean(status));
        if (new Set(configuredStatuses).size !== configuredStatuses.length) {
          ctx.addIssue({
            code: "custom",
            path: ["workflow"],
            message: "human distribution workflow statuses must all be different",
          });
        }
        for (const field of ["executionAgentFieldId", "workspaceId"] as const) {
          if (config.distribution[field]) continue;
          ctx.addIssue({
            code: "custom",
            path: ["distribution", field],
            message: `distribution.${field} is required when human distribution is enabled`,
          });
        }
        if (
          config.distribution.executionAgentFieldId &&
          !/^customfield_\d+$/.test(config.distribution.executionAgentFieldId)
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["distribution", "executionAgentFieldId"],
            message:
              'Enter the Jira custom field ID as "customfield_12345" or just its numeric ID "12345"; the field display name is not accepted',
          });
        }
        if (config.agent.role === "implement" && !config.distribution.executionAgentOptionId) {
          ctx.addIssue({
            code: "custom",
            path: ["distribution", "executionAgentOptionId"],
            message: "distribution.executionAgentOptionId is required for implement agents",
          });
        }
      }
    }
    if (config.agent.role !== "pm") return;
    // In profile mode the implement assignee is resolved from the registered
    // agent roster instead (pm/apply.ts), so implementAssignee becomes optional.
    if (!config.agent.profileKey && !config.pm.implementAssignee) {
      ctx.addIssue({
        code: "custom",
        path: ["pm", "implementAssignee"],
        message:
          'pm.implementAssignee is required when agent.role is "pm" (unless agent.profileKey is set)',
      });
    }
    // v4 PM moves are status-based and optional (needsDecisionStatus); only
    // the legacy shape still requires a transition name here.
    if (config.configVersion !== 4 && !config.workflow.needsDecisionTransitionName) {
      ctx.addIssue({
        code: "custom",
        path: ["workflow", "needsDecisionTransitionName"],
        message: 'workflow.needsDecisionTransitionName is required when agent.role is "pm"',
      });
    }
  });

export type AppConfig = z.infer<typeof AppConfigSchema>;

/**
 * True when this config was set up through the Create/Join Agent Profile flow
 * (`ggjira setup`'s "Create GGJira Workspace" / "Join as Agent" modes) rather
 * than the legacy manual flow. Profile mode drives Jira-backed agent
 * identity, prompt composition, and PM roster dispatch.
 */
export function isProfileMode(config: AppConfig): config is AppConfig & {
  agent: { profileKey: string; machineId: string };
  jira: { projectKey: string };
} {
  return Boolean(config.agent.profileKey && config.agent.machineId && config.jira.projectKey);
}

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
