import { readFileSync } from "node:fs";
import { z } from "zod";
import { CloneUrlSchema } from "../contracts/api.js";

/** See src/config.ts's `nfc` for why status/transition names get normalized. */
function nfc(value: string): string {
  return value.normalize("NFC");
}

const nfcString = z.string().min(1).transform(nfc);

/**
 * The request -> in-progress -> review loop for one workspace
 * (docs/router-service-implementation-plan.md §2 "Jira 업무 흐름"):
 *
 *   human -> requestStatus -> [Router leases] inProgressStatus
 *         -> [execution done] reviewStatus -> human
 *
 * `planningStatus` is a second, distinct request status: only issues whose
 * *current* status equals it get planning jobs instead of implementation
 * jobs. Leaving it unset disables planning for the workspace entirely.
 */
const WorkflowStatusSchema = z
  .object({
    requestStatus: nfcString,
    inProgressStatus: nfcString,
    reviewStatus: nfcString,
    planningStatus: nfcString.optional(),
    needsDecisionStatus: nfcString.optional(),
    /** Where Router moves an issue from `reviewStatus` once the worker's GitHub pull request is
     *  merged (ADR 0027). Unset: a merge is only commented on. */
    doneStatus: nfcString.optional(),
  })
  .superRefine((workflow, ctx) => {
    if (workflow.doneStatus && workflow.doneStatus === workflow.reviewStatus) {
      ctx.addIssue({
        code: "custom",
        path: ["doneStatus"],
        message: "workflow.doneStatus must differ from workflow.reviewStatus",
      });
    }
    if (workflow.planningStatus === workflow.requestStatus) {
      ctx.addIssue({
        code: "custom",
        path: ["planningStatus"],
        message: "workflow.planningStatus must differ from workflow.requestStatus",
      });
    }
  });
export type WorkflowStatus = z.infer<typeof WorkflowStatusSchema>;

const RepositorySchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1).optional(),
  /** Git remote a worker clones on `worker start` when it has no local copy yet (ADR 0025). */
  cloneUrl: CloneUrlSchema.optional(),
  /** Branch job worktrees start from; workers default to "main". */
  baseBranch: z.string().min(1).optional(),
});
export type RepositoryConfig = z.infer<typeof RepositorySchema>;

/**
 * A workspace groups one or more Jira projects that share a repository and a
 * status mapping (§3 "첫 버전은 Jira 사이트 하나를 지원하고 여러 프로젝트를 workspace에
 * 연결할 수 있게 한다"). A project belongs to exactly one workspace.
 */
const WorkspaceSchema = z.object({
  id: z.string().min(1),
  repositoryId: z.string().min(1),
  projectKeys: z.array(z.string().min(1)).min(1),
  workflow: WorkflowStatusSchema,
});
export type WorkspaceConfig = z.infer<typeof WorkspaceSchema>;

/**
 * Admin-declared allowlist for one worker. Actual dispatch also needs the
 * worker's own reported availability to agree — config alone never expands
 * what a worker may do (§2 "워커 등록 요청만으로 권한을 확대하지 않는다").
 */
const WorkerPolicySchema = z.object({
  workerId: z.string().min(1),
  allowedCapabilities: z.array(z.string().min(1)).default([]),
  allowedRepositoryIds: z.array(z.string().min(1)).min(1),
  enabled: z.boolean().default(true),
  /** The worker-local provider (`WorkerConfig.providers[].id`) Router names in this worker's
   *  job envelopes. Router only picks the id; the worker resolves it to a CLI invocation and
   *  refuses ids it doesn't have (§2 "Router는 repositoryId와 providerId를 지정하고..."). */
  providerId: z.string().min(1).default("default"),
});
export type WorkerPolicyConfig = z.infer<typeof WorkerPolicySchema>;

/** Legacy "실행-Agent" custom field: an optionId pins a request straight to a workerId,
 *  bypassing auto-assignment (§2 "실행-Agent 필드가 있으면... 대상을 제한한다"). */
const ExecutionAgentFieldSchema = z.object({
  fieldId: z
    .string()
    .trim()
    .min(1)
    .transform((value) => (/^\d+$/.test(value) ? `customfield_${value}` : value))
    .refine((value) => /^customfield_\d+$/.test(value), {
      message: 'Enter the Jira custom field ID as "customfield_12345" or just its numeric ID',
    }),
  optionWorkerMap: z.record(z.string().min(1), z.string().min(1)).default({}),
});
export type ExecutionAgentFieldConfig = z.infer<typeof ExecutionAgentFieldSchema>;

const DatabaseConfigSchema = z.object({
  path: z.string().min(1).default("data/router.sqlite3"),
});

const HttpConfigSchema = z.object({
  host: z.string().min(1).default("127.0.0.1"),
  port: z.number().int().positive().default(8787),
});

const ReconciliationConfigSchema = z.object({
  /** Full candidate re-scan on Router boot (§2 "Router 시작 시 전체 실행 후보를 재조회"). */
  startupFullSyncOnBoot: z.boolean().default(true),
  /** Background top-up scan for candidates/waiting jobs. */
  backgroundIntervalMs: z.number().int().positive().default(60_000),
  /** Re-check approval for jobs currently leased/running. */
  activeJobPollIntervalMs: z.number().int().positive().default(5_000),
});

const ExecutionConfigSchema = z.object({
  /** `timeoutMs` stamped on every job envelope; the worker enforces it as a hard provider
   *  timeout. */
  timeoutMs: z
    .number()
    .int()
    .positive()
    .default(30 * 60 * 1000),
});

/** How Router applies a PM plan to Jira (the v5 counterpart of v4's `pm.*` settings). */
const PlanningConfigSchema = z.object({
  subtaskIssueType: nfcString.default("Sub-task"),
  maxTasksPerPlan: z.number().int().positive().default(10),
});

const GithubConfigSchema = z.object({
  /** How often open GGJIRA pull requests are re-checked on GitHub, in case a webhook was missed
   *  or none is configured (ADR 0027). */
  pollIntervalMs: z
    .number()
    .int()
    .positive()
    .default(5 * 60 * 1000),
});

const ReportingConfigSchema = z.object({
  /** Added to an issue whose execution failed or timed out; the issue itself stays in
   *  `inProgressStatus` until a human re-approves it (ADR 0021). */
  failureLabel: z.string().min(1).default("ggjira-failed"),
});

/** How reported LLM plan usage affects assignment (ADR 0029). */
const SchedulingConfigSchema = z.object({
  usage: z
    .object({
      /** A worker whose provider has a window at or above this percent (not yet reset) is offered
       *  a job only when no other matching idle worker is below it. */
      deprioritizeAtPercent: z.number().min(1).max(100).default(90),
      /** Skip a worker whose provider has a window at 100% until that window resets. */
      skipExhausted: z.boolean().default(true),
    })
    .default({}),
});

/** Jev (TypeSafe System One) shadow assessment (ADR 0030). Active only when `TYPESAFE_API_KEY`
 *  is set; `enabled: false` turns it off with the key in place. */
const JevConfigSchema = z.object({
  enabled: z.boolean().default(true),
  model: z.string().min(1).default("jev-latest"),
  timeoutMs: z.number().int().positive().default(5_000),
});

export const RouterConfigSchema = z
  .object({
    configVersion: z.literal(5),
    jira: z.object({ baseUrl: z.string().url() }),
    repositories: z.array(RepositorySchema).min(1),
    workspaces: z.array(WorkspaceSchema).min(1),
    workers: z.array(WorkerPolicySchema).default([]),
    executionAgent: ExecutionAgentFieldSchema.optional(),
    db: DatabaseConfigSchema.default({}),
    http: HttpConfigSchema.default({}),
    reconciliation: ReconciliationConfigSchema.default({}),
    execution: ExecutionConfigSchema.default({}),
    planning: PlanningConfigSchema.default({}),
    reporting: ReportingConfigSchema.default({}),
    github: GithubConfigSchema.default({}),
    scheduling: SchedulingConfigSchema.default({}),
    jev: JevConfigSchema.default({}),
  })
  .superRefine((config, ctx) => {
    const repositoryIds = new Set(config.repositories.map((repo) => repo.id));
    const workerIds = new Set(config.workers.map((worker) => worker.workerId));
    const seenProjectKeys = new Map<string, string>();

    config.workspaces.forEach((workspace, index) => {
      if (!repositoryIds.has(workspace.repositoryId)) {
        ctx.addIssue({
          code: "custom",
          path: ["workspaces", index, "repositoryId"],
          message: `workspaces[${index}].repositoryId "${workspace.repositoryId}" is not listed in repositories`,
        });
      }
      for (const projectKey of workspace.projectKeys) {
        const owner = seenProjectKeys.get(projectKey);
        if (owner && owner !== workspace.id) {
          ctx.addIssue({
            code: "custom",
            path: ["workspaces", index, "projectKeys"],
            message: `projectKey "${projectKey}" is already claimed by workspace "${owner}"`,
          });
        }
        seenProjectKeys.set(projectKey, workspace.id);
      }
      // A project's default-generation status can't already be the status Router leases from,
      // or every new issue would be picked up before a human ever reviewed it.
      if (workspace.workflow.requestStatus === workspace.workflow.inProgressStatus) {
        ctx.addIssue({
          code: "custom",
          path: ["workspaces", index, "workflow", "inProgressStatus"],
          message: "workflow.inProgressStatus must differ from workflow.requestStatus",
        });
      }
    });

    config.workers.forEach((worker, index) => {
      for (const repositoryId of worker.allowedRepositoryIds) {
        if (repositoryIds.has(repositoryId)) continue;
        ctx.addIssue({
          code: "custom",
          path: ["workers", index, "allowedRepositoryIds"],
          message: `workers[${index}].allowedRepositoryIds references unknown repository "${repositoryId}"`,
        });
      }
    });

    if (config.executionAgent) {
      for (const [optionId, workerId] of Object.entries(config.executionAgent.optionWorkerMap)) {
        if (workerIds.has(workerId)) continue;
        ctx.addIssue({
          code: "custom",
          path: ["executionAgent", "optionWorkerMap", optionId],
          message: `executionAgent.optionWorkerMap["${optionId}"] references unknown worker "${workerId}"`,
        });
      }
    }
  });

export type RouterConfig = z.infer<typeof RouterConfigSchema>;

export class RouterConfigError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "RouterConfigError";
  }
}

export function loadRouterConfig(configPath: string): RouterConfig {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch (error) {
    throw new RouterConfigError(`Failed to read router config file at ${configPath}`, error);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new RouterConfigError(`Router config file at ${configPath} is not valid JSON`, error);
  }

  const result = RouterConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new RouterConfigError(
      `Router config file at ${configPath} failed validation: ${result.error.message}`,
      result.error,
    );
  }
  return result.data;
}
