import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CloneUrlSchema } from "../contracts/api.js";
import { WorkerProviderConfigSchema } from "../contracts/provider.js";
import { workerPaths } from "./paths.js";

/**
 * `repositoryId -> local absolute path` mapping. Router only ever sends a
 * `repositoryId`; it never sees (or chooses) the local path or the shell
 * command that validates a change (docs/router-service-implementation-plan.md "Worker
 * Runtime": "작업 데이터에 담긴 경로나 명령을 그대로 실행하지 않는다").
 */
const WorkerRepositorySchema = z.object({
  /** Also a folder name under the worker home (`repositories/<id>`). */
  id: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "repository ids are letters, digits, '.', '_' or '-'"),
  /** An existing local copy. Unset: `<home>/repositories/<id>/repo`, cloned from `cloneUrl`.
   *  A relative path is read from the worker home. */
  path: z.string().min(1).optional(),
  baseBranch: z.string().min(1).default("main"),
  validateCommand: z.string().min(1).nullable().default(null),
  /** Where `worker start` clones `path` from when it does not exist yet (from Router's profile). */
  cloneUrl: CloneUrlSchema.optional(),
  /** Git remote a finished job branch is pushed to, so people review it there (ADR 0026).
   *  Unset: the branch stays in this worker's local clone only. */
  pushRemote: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "pushRemote must be a git remote name like origin")
    .optional(),
  /** After pushing to a GitHub remote, open a pull request with the worker's `gh` login
   *  (ADR 0027). Parent PRs are created after children finish; merge starts integration checks. */
  createPullRequest: z.boolean().default(false),
});
export type WorkerRepositoryConfig = z.infer<typeof WorkerRepositorySchema> & { path: string };

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

/** The worker config file, `<home>/worker.config.json` (ADR 0060). Paths are not configured: every
 *  local file lives under the home (src/worker-runtime/paths.ts). */
export const WorkerConfigFileSchema = z
  .object({
    configVersion: z.literal(6),
    routerUrl: z.string().url(),
    repositories: z.array(WorkerRepositorySchema).min(1),
    providers: z.array(WorkerProviderConfigSchema).min(1),
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

/** A loaded config: the file plus its home, with every repository path resolved. */
export type WorkerConfig = Omit<z.infer<typeof WorkerConfigFileSchema>, "repositories"> & {
  home: string;
  repositories: WorkerRepositoryConfig[];
};

/** Parses a config file's content for the worker home `home`. Throws the schema's error. */
export function resolveWorkerConfig(raw: unknown, home: string): WorkerConfig {
  const file = WorkerConfigFileSchema.parse(raw);
  const paths = workerPaths(home);
  return {
    ...file,
    home: paths.home,
    repositories: file.repositories.map((repo) => ({
      ...repo,
      path: repo.path ? path.resolve(paths.home, repo.path) : paths.repositoryClone(repo.id),
    })),
  };
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

/** Loads `<home>/worker.config.json`. */
export function loadWorkerConfig(home: string): WorkerConfig {
  const configPath = workerPaths(home).config;
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

  if ((parsed as { configVersion?: unknown } | null)?.configVersion === 5) {
    throw new WorkerConfigError(
      `Worker config file at ${configPath} is configVersion 5, which kept its files in the GGJIRA folder. Set up a new worker home instead (docs/runbook.md §47).`,
    );
  }
  try {
    return resolveWorkerConfig(parsed, home);
  } catch (error) {
    throw new WorkerConfigError(
      `Worker config file at ${configPath} failed validation: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
}
