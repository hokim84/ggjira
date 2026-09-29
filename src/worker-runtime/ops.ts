import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import type { WorkerProfile } from "../contracts/api.js";
import { PROTOCOL_VERSION } from "../contracts/protocol.js";
import {
  cloneRepository,
  isGitRepository,
  listRepositoryWorktreePaths,
  removeWorktree,
} from "../worker/worktree.js";
import type { RouterClient } from "./client.js";
import { type WorkerConfig, workerSpoolDir, workerWorktreesRoot } from "./config.js";
import { loadWorkerCredential, type WorkerCredential } from "./credential.js";
import { ResultSpool } from "./spool.js";

/**
 * Worker-side maintenance behind `ggjira worker setup | check | worktrees prune`
 * (docs/router-service-implementation-plan.md §4 "관리 CLI"). None of it talks to Jira; the only
 * network peer is Router.
 */

export type CheckLevel = "ok" | "warn" | "fail";
export interface CheckItem {
  level: CheckLevel;
  message: string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Writes `content` via temp file → fsync → rename, owner-readable only where the OS allows. */
function writeFileAtomic(target: string, content: string, mode: number): void {
  mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  const fd = openSync(temp, "w", mode);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, target);
}

/** A starting worker config; the operator fills in repositories and providers. */
export function workerConfigTemplate(input: {
  routerUrl: string;
  credentialPath: string;
}): Record<string, unknown> {
  return {
    configVersion: 5,
    routerUrl: input.routerUrl,
    credentialPath: input.credentialPath,
    repositories: [
      {
        id: "main-repo",
        path: "/absolute/path/to/local/clone",
        baseBranch: "main",
        validateCommand: "npm test",
      },
    ],
    capabilities: ["programming", "testing"],
    backends: ["filesystem", "git", "coding-runtime"],
    providers: [{ id: "default", type: "claude-code" }],
    dataDir: "data/worker",
    logPath: "data/worker-logs",
  };
}

export function writeWorkerConfigTemplate(
  configPath: string,
  input: { routerUrl: string; credentialPath: string },
): void {
  writeFileAtomic(configPath, `${JSON.stringify(workerConfigTemplate(input), null, 2)}\n`, 0o644);
}

export const PROVIDER_TYPES = ["claude-code", "codex"] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

const PROVIDER_LABELS: Record<ProviderType, string> = {
  "claude-code": "Claude Code (claude)",
  codex: "OpenAI Codex (codex)",
};

/** The LLM CLIs that start on this machine (`<command> --version`). */
export function detectInstalledProviders(
  runs: (command: string) => boolean = commandRuns,
): ProviderType[] {
  return PROVIDER_TYPES.filter((type) => runs(DEFAULT_PROVIDER_COMMANDS[type] ?? type));
}

/**
 * The one question `worker start` asks: which LLM CLI runs jobs. `--provider` wins; otherwise the
 * only installed CLI is taken as is, and a choice between several is asked (ADR 0025).
 */
export async function chooseProvider(input: {
  requested?: string | undefined;
  installed: ProviderType[];
  ask?: (question: string) => Promise<string>;
}): Promise<ProviderType> {
  const { requested, installed, ask } = input;
  if (requested) {
    if (!(PROVIDER_TYPES as readonly string[]).includes(requested)) {
      throw new Error(`--provider는 ${PROVIDER_TYPES.join(", ")} 중 하나여야 합니다`);
    }
    return requested as ProviderType;
  }
  if (installed.length === 0) {
    throw new Error(
      `LLM CLI를 찾지 못했습니다. ${PROVIDER_TYPES.map((t) => PROVIDER_LABELS[t]).join(" 또는 ")}를 설치하고 로그인한 뒤 다시 실행하세요`,
    );
  }
  const [only] = installed;
  if (installed.length === 1 && only) return only;
  if (!ask) {
    throw new Error(
      `LLM CLI가 여러 개 설치돼 있습니다(${installed.join(", ")}). --provider로 고르세요`,
    );
  }
  const menu = installed.map((type, i) => `  ${i + 1}) ${PROVIDER_LABELS[type]}`).join("\n");
  for (;;) {
    const answer = (await ask(`작업에 쓸 LLM을 고르세요:\n${menu}\n번호 [1]: `)).trim();
    const index = answer === "" ? 0 : Number(answer) - 1;
    const picked = installed[index] ?? installed.find((type) => type === answer);
    if (picked) return picked;
  }
}

/** Where `worker start` keeps clones of repositories Router gave a clone URL for. */
export function workerRepositoryPath(dataDir: string, repositoryId: string): string {
  return path.join(dataDir, "repos", repositoryId);
}

/** A complete worker config from Router's profile plus the one local choice, the provider. */
export function workerConfigFromProfile(input: {
  routerUrl: string;
  credentialPath: string;
  profile: WorkerProfile;
  providerType: ProviderType;
  dataDir?: string;
  logPath?: string;
}): Record<string, unknown> {
  const dataDir = input.dataDir ?? "data/worker";
  return {
    configVersion: 5,
    routerUrl: input.routerUrl,
    credentialPath: input.credentialPath,
    repositories: input.profile.repositories.map((repo) => ({
      id: repo.id,
      path: workerRepositoryPath(dataDir, repo.id),
      baseBranch: repo.baseBranch ?? "main",
      validateCommand: null,
      ...(repo.cloneUrl ? { cloneUrl: repo.cloneUrl } : {}),
      // Results reach people through the remote: the worker's clone is its own (ADR 0026).
      pushRemote: "origin",
      createPullRequest: true,
    })),
    capabilities: input.profile.capabilities,
    backends: ["filesystem", "git", "coding-runtime"],
    providers: [{ id: input.profile.providerId, type: input.providerType }],
    dataDir,
    logPath: input.logPath ?? "data/worker-logs",
  };
}

export function writeWorkerConfig(configPath: string, config: Record<string, unknown>): void {
  writeFileAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`, 0o644);
}

export interface RepositoryPreparation {
  ready: string[];
  cloned: string[];
  /** Repositories whose path does not exist and that have no clone URL to fetch it from. */
  missing: Array<{ id: string; path: string }>;
  failed: Array<{ id: string; error: string }>;
}

/** Clones every configured repository that has a clone URL but no local copy yet. */
export async function prepareRepositories(
  config: WorkerConfig,
  clone: typeof cloneRepository = cloneRepository,
): Promise<RepositoryPreparation> {
  const outcome: RepositoryPreparation = { ready: [], cloned: [], missing: [], failed: [] };
  for (const repo of config.repositories) {
    if (existsSync(repo.path)) {
      outcome.ready.push(repo.id);
      continue;
    }
    if (!repo.cloneUrl) {
      outcome.missing.push({ id: repo.id, path: repo.path });
      continue;
    }
    try {
      await clone(repo.cloneUrl, repo.path, repo.baseBranch);
      outcome.cloned.push(repo.id);
    } catch (error) {
      outcome.failed.push({ id: repo.id, error: errorText(error) });
    }
  }
  return outcome;
}

/**
 * `worker setup`: redeems an admin-issued pairing code (`router workers pair`) for this worker's
 * token and stores it in the credential file — never in the config file, never logged (§3 "워커
 * token은 별도 로컬 파일"). Refuses to overwrite an existing credential unless `force`.
 */
export async function pairWorker(input: {
  client: RouterClient;
  pairingCode: string;
  workerName: string;
  credentialPath: string;
  force?: boolean;
}): Promise<WorkerCredential & { profile?: WorkerProfile }> {
  if (existsSync(input.credentialPath) && !input.force) {
    throw new Error(
      `${input.credentialPath} already exists; pass --force to replace it with a new pairing`,
    );
  }
  const response = await input.client.register({
    protocolVersion: PROTOCOL_VERSION,
    pairingCode: input.pairingCode,
    workerName: input.workerName,
  });
  const credential: WorkerCredential = {
    workerId: response.workerId,
    workerToken: response.workerToken,
  };
  writeFileAtomic(input.credentialPath, `${JSON.stringify(credential, null, 2)}\n`, 0o600);
  return { ...credential, ...(response.profile ? { profile: response.profile } : {}) };
}

/** Whether `command` can be started at all (`<command> --version`). On Windows the CLIs are
 *  `.cmd` shims that only a shell can resolve, so the command line goes through one (the command
 *  comes from the local worker config, not from Router). */
export function commandRuns(command: string): boolean {
  const options = { stdio: "ignore" as const, timeout: 15_000 };
  const result =
    process.platform === "win32"
      ? spawnSync(`"${command}" --version`, { ...options, shell: true })
      : spawnSync(command, ["--version"], options);
  return !result.error && result.status === 0;
}

const DEFAULT_PROVIDER_COMMANDS: Record<string, string> = {
  "claude-code": "claude",
  codex: "codex",
};

/**
 * `worker check`: config, credential, local repositories, provider CLIs, and that Router is
 * reachable. It deliberately opens no session — that would take over from a running `worker run`.
 */
export async function runWorkerCheck(
  config: WorkerConfig,
  deps: { client: RouterClient; commandRuns?: (command: string) => boolean },
): Promise<CheckItem[]> {
  const items: CheckItem[] = [];
  const runs = deps.commandRuns ?? commandRuns;

  try {
    const credential = loadWorkerCredential(config.credentialPath);
    items.push({ level: "ok", message: `credential for worker "${credential.workerId}" found` });
  } catch (error) {
    items.push({ level: "fail", message: errorText(error) });
  }

  for (const repo of config.repositories) {
    if (!existsSync(repo.path) || !statSync(repo.path).isDirectory()) {
      items.push({
        level: "fail",
        message: `repository "${repo.id}": ${repo.path} is not a directory`,
      });
      continue;
    }
    items.push(
      (await isGitRepository(repo.path))
        ? { level: "ok", message: `repository "${repo.id}": git repository at ${repo.path}` }
        : {
            level: "warn",
            message: `repository "${repo.id}": ${repo.path} is not a git repository; jobs edit it in place, one at a time`,
          },
    );
  }

  for (const provider of config.providers) {
    const command = provider.command ?? DEFAULT_PROVIDER_COMMANDS[provider.type] ?? provider.type;
    items.push(
      runs(command)
        ? { level: "ok", message: `provider "${provider.id}": "${command} --version" runs` }
        : {
            level: "fail",
            message: `provider "${provider.id}": cannot run "${command}" (installed and on PATH? logged in?)`,
          },
    );
  }

  try {
    items.push(
      (await deps.client.health())
        ? { level: "ok", message: `Router at ${config.routerUrl} is reachable` }
        : {
            level: "fail",
            message: `Router at ${config.routerUrl} answered /health with an error`,
          },
    );
  } catch (error) {
    items.push({ level: "fail", message: `Router at ${config.routerUrl}: ${errorText(error)}` });
  }

  const pending = new ResultSpool(workerSpoolDir(config)).listPending().length;
  if (pending > 0) {
    items.push({
      level: "warn",
      message: `${pending} result(s) are waiting in the spool for Router; "worker run" or "worker results retry" resends them`,
    });
  }
  return items;
}

export interface PruneOutcome {
  removed: string[];
  kept: string[];
  failed: Array<{ path: string; error: string }>;
}

/**
 * `worker worktrees prune`: removes job worktrees under `<dataDir>/worktrees` that have not been
 * touched for `olderThanMs`, each through the repository that registered it. Branches (and the
 * commits on them) stay — only the working directory goes (§1 "작업 디렉터리와 Git 브랜치는 삭제하지
 * 않는다" applies to automatic cleanup; this is an explicit operator command).
 */
function realPathOrSelf(p: string): string {
  try {
    return realpathSync(path.resolve(p));
  } catch {
    return path.resolve(p);
  }
}

export async function pruneWorktrees(
  config: WorkerConfig,
  opts: { olderThanMs: number; dryRun?: boolean; nowMs?: number },
): Promise<PruneOutcome> {
  const root = workerWorktreesRoot(config);
  const outcome: PruneOutcome = { removed: [], kept: [], failed: [] };
  const nowMs = opts.nowMs ?? Date.now();
  // git lists worktrees by their real path, so compare real paths: otherwise a data directory
  // under a symlink (macOS /tmp and /var point into /private) never matches and nothing is pruned.
  const realRoot = realPathOrSelf(root);
  const underRoot = (p: string) =>
    realPathOrSelf(p).startsWith(`${realRoot}${path.sep}`) || p.startsWith(`${root}${path.sep}`);
  for (const repo of config.repositories) {
    if (!(await isGitRepository(repo.path))) continue;
    const paths = (await listRepositoryWorktreePaths(repo.path)).filter(underRoot);
    for (const worktreePath of paths) {
      const ageMs = existsSync(worktreePath)
        ? nowMs - statSync(worktreePath).mtimeMs
        : Number.POSITIVE_INFINITY;
      if (ageMs < opts.olderThanMs) {
        outcome.kept.push(worktreePath);
        continue;
      }
      if (opts.dryRun) {
        outcome.removed.push(worktreePath);
        continue;
      }
      try {
        await removeWorktree(repo.path, worktreePath);
        outcome.removed.push(worktreePath);
      } catch (error) {
        outcome.failed.push({ path: worktreePath, error: errorText(error) });
      }
    }
  }
  return outcome;
}
