import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CloneUrlSchema } from "../contracts/api.js";
import { WorkerProviderConfigSchema } from "../contracts/provider.js";

/**
 * `repositoryId -> local absolute path` mapping. Router only ever sends a
 * `repositoryId`; it never sees (or chooses) the local path or the shell
 * command that validates a change (docs/router-service-implementation-plan.md "Worker
 * Runtime": "작업 데이터에 담긴 경로나 명령을 그대로 실행하지 않는다").
 */
const WorkerRepositorySchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  baseBranch: z.string().min(1).default("main"),
  validateCommand: z.string().min(1).nullable().default(null),
  /** Where `worker start` clones `path` from when it does not exist yet (from Router's profile). */
  cloneUrl: CloneUrlSchema.optional(),
});
export type WorkerRepositoryConfig = z.infer<typeof WorkerRepositorySchema>;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Why `url` may not be used as a Router URL, or `undefined` when it may: plain HTTP is only for
 *  a loopback development Router (§5 "HTTP는 loopback 개발 환경만 허용한다"). */
export function routerUrlProblem(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `"${url}" is not a URL`;
  }
  if (parsed.protocol === "https:") return undefined;
  if (parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname)) return undefined;
  return `Router URL must use https:// (plain http:// is allowed only for localhost), got "${url}"`;
}

export function assertRouterUrlAllowed(url: string): void {
  const problem = routerUrlProblem(url);
  if (problem) throw new WorkerConfigError(problem);
}

export const WorkerConfigSchema = z
  .object({
    configVersion: z.literal(5),
    routerUrl: z.string().url(),
    /** Local JSON file holding `{ workerId, workerToken }` (docs/router-service-implementation-plan.md
     *  §3 "발급된 워커 token은 hash만 Router에 저장하고... 워커 token은 별도 로컬 파일"). */
    credentialPath: z.string().min(1),
    repositories: z.array(WorkerRepositorySchema).min(1),
    /** Human-facing capabilities this worker offers; intersected against Router's
     *  admin-declared allowlist for this workerId, never trusted alone. */
    capabilities: z.array(z.string().min(1)).default([]),
    /** Local execution environments available (filesystem, git, coding-runtime, ...). */
    backends: z.array(z.string().min(1)).default([]),
    providers: z.array(WorkerProviderConfigSchema).min(1),
    logPath: z.string().min(1).default("data/worker-logs"),
    /** Worker-local state: `<dataDir>/spool` (results awaiting Router's ack) and
     *  `<dataDir>/worktrees` (one git worktree per job, kept until `worker worktrees prune`). */
    dataDir: z.string().min(1).default("data/worker"),
  })
  .superRefine((config, ctx) => {
    const urlProblem = routerUrlProblem(config.routerUrl);
    if (urlProblem) ctx.addIssue({ code: "custom", path: ["routerUrl"], message: urlProblem });

    const repositoryIds = new Set<string>();
    config.repositories.forEach((repo, index) => {
      if (repositoryIds.has(repo.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["repositories", index, "id"],
          message: `repositories[${index}].id "${repo.id}" is declared more than once`,
        });
      }
      repositoryIds.add(repo.id);
    });

    const providerIds = new Set<string>();
    config.providers.forEach((provider, index) => {
      if (providerIds.has(provider.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["providers", index, "id"],
          message: `providers[${index}].id "${provider.id}" is declared more than once`,
        });
      }
      providerIds.add(provider.id);
    });
  });

export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

export function workerSpoolDir(config: WorkerConfig): string {
  return path.join(config.dataDir, "spool");
}

export function workerWorktreesRoot(config: WorkerConfig): string {
  return path.resolve(config.dataDir, "worktrees");
}

export class WorkerConfigError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "WorkerConfigError";
  }
}

export function loadWorkerConfig(configPath: string): WorkerConfig {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch (error) {
    throw new WorkerConfigError(`Failed to read worker config file at ${configPath}`, error);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new WorkerConfigError(`Worker config file at ${configPath} is not valid JSON`, error);
  }

  const result = WorkerConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new WorkerConfigError(
      `Worker config file at ${configPath} failed validation: ${result.error.message}`,
      result.error,
    );
  }
  return result.data;
}
