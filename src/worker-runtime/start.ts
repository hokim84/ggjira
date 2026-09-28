import { existsSync, statSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { type CliIo, type ParsedArgs, stringOption, UsageError } from "../cli-io.js";
import type { WorkerProfile } from "../contracts/api.js";
import { isGitRepository } from "../worker/worktree.js";
import { RouterApiError, RouterClient } from "./client.js";
import { loadWorkerConfig, routerUrlProblem, type WorkerConfig } from "./config.js";
import {
  chooseProvider,
  commandRuns,
  detectInstalledProviders,
  pairWorker,
  prepareRepositories,
  type ProviderType,
  workerConfigFromProfile,
  workerRepositoryPath,
  writeWorkerConfig,
} from "./ops.js";

/**
 * `ggjira worker start` (ADR 0025): on first use a short text setup — Router address, LLM CLI,
 * pairing code, and a local folder for any repository Router gives no clone URL for — then the
 * config is written and the worker runs. Flags answer the same questions for non-terminal use.
 */

export type Ask = (question: string) => Promise<string>;

export interface WorkerStartDeps {
  commandRuns?: (command: string) => boolean;
  /** Asks the operator one question; absent when stdin is not a terminal. */
  ask?: Ask;
  clone?: Parameters<typeof prepareRepositories>[1];
  /** Checks a local folder is a git repository (tests stub it). */
  isGitRepository?: (dir: string) => Promise<boolean>;
}

const DEFAULT_ROUTER_URL = "http://127.0.0.1:8787";
const DEFAULT_CREDENTIAL = "data/worker-credential.json";

function expandHome(input: string): string {
  if (input === "~") return process.env.HOME ?? input;
  if (input.startsWith("~/")) return path.join(process.env.HOME ?? "~", input.slice(2));
  return input;
}

async function askUntil<T>(
  ask: Ask,
  question: string,
  accept: (answer: string) => Promise<T | string>,
  io: CliIo,
): Promise<T> {
  for (;;) {
    const answer = (await ask(question)).trim();
    const result = await accept(answer);
    if (typeof result !== "string") return result;
    io.err(`  ${result}`);
  }
}

async function routerReachable(url: string): Promise<string | undefined> {
  try {
    return (await new RouterClient({ routerUrl: url }).health())
      ? undefined
      : `${url}/health 가 오류를 돌려줬습니다`;
  } catch (error) {
    return `${url} 에 연결할 수 없습니다 (${error instanceof Error ? error.message : String(error)})`;
  }
}

async function obtainRouterUrl(parsed: ParsedArgs, io: CliIo, ask?: Ask): Promise<string> {
  const given = stringOption(parsed, "router");
  if (given) {
    const problem = routerUrlProblem(given) ?? (await routerReachable(given));
    if (problem) throw new UsageError(problem);
    return given.replace(/\/+$/, "");
  }
  if (!ask) throw notInteractive();
  return askUntil(
    ask,
    `Router 주소 [${DEFAULT_ROUTER_URL}]: `,
    async (answer) => {
      const url = (answer || DEFAULT_ROUTER_URL).replace(/\/+$/, "");
      const problem = routerUrlProblem(url) ?? (await routerReachable(url));
      return problem ?? { url };
    },
    io,
  ).then(({ url }) => url);
}

async function obtainProvider(
  parsed: ParsedArgs,
  io: CliIo,
  deps: WorkerStartDeps,
): Promise<ProviderType> {
  const provider = await chooseProvider({
    requested: stringOption(parsed, "provider"),
    installed: detectInstalledProviders(deps.commandRuns ?? commandRuns),
    ...(deps.ask ? { ask: deps.ask } : {}),
  });
  io.out(`LLM: ${provider}`);
  return provider;
}

/** Redeems a pairing code, asking again (the code is not used up) when Router rejects it. */
async function pairInteractively(input: {
  parsed: ParsedArgs;
  io: CliIo;
  ask?: Ask | undefined;
  routerUrl: string;
  credentialPath: string;
  force?: boolean;
}): Promise<{ workerId: string; profile?: WorkerProfile }> {
  const { parsed, io, ask } = input;
  let code = stringOption(parsed, "pairing-code");
  for (;;) {
    if (!code) {
      if (!ask) throw notInteractive();
      code = (
        await ask("페어링 코드 (Router 웹 UI > 워커 > 워커 추가 / 페어링 코드 발급): ")
      ).trim();
      if (!code) continue;
    }
    try {
      const paired = await pairWorker({
        client: new RouterClient({ routerUrl: input.routerUrl }),
        pairingCode: code,
        workerName: stringOption(parsed, "name") ?? hostname(),
        credentialPath: input.credentialPath,
        force: Boolean(input.force),
      });
      io.out(`워커 "${paired.workerId}"로 페어링했습니다.`);
      return paired;
    } catch (error) {
      const rejected = error instanceof RouterApiError && error.status === 401;
      if (!rejected || !ask) {
        throw rejected
          ? new UsageError("페어링 코드가 맞지 않거나 만료됐습니다. 웹 UI에서 새 코드를 받으세요.")
          : error;
      }
      io.err(
        "  페어링 코드가 맞지 않거나 만료됐습니다(10분, 1회용). 웹 UI에서 새 코드를 받아 입력하세요.",
      );
      code = undefined;
    }
  }
}

/**
 * For repositories without a clone URL, asks for the folder of an existing local clone. For ones
 * with a clone URL, offers the default clone location (Enter) or an existing clone.
 */
async function chooseRepositoryPaths(input: {
  profile: WorkerProfile;
  dataDir: string;
  io: CliIo;
  ask?: Ask | undefined;
  isGit: (dir: string) => Promise<boolean>;
}): Promise<Record<string, string>> {
  const { profile, dataDir, io, ask, isGit } = input;
  const paths: Record<string, string> = {};
  for (const repo of profile.repositories) {
    const fallback = workerRepositoryPath(dataDir, repo.id);
    if (!ask) continue;
    const question = repo.cloneUrl
      ? `저장소 "${repo.id}" (${repo.cloneUrl})\n  이미 clone해 둔 폴더 경로, 또는 Enter로 자동 clone [${fallback}]: `
      : `저장소 "${repo.id}" — 이 컴퓨터에 clone해 둔 폴더의 전체 경로: `;
    paths[repo.id] = await askUntil(
      ask,
      question,
      async (answer) => {
        if (!answer) return repo.cloneUrl ? { dir: fallback } : "경로를 입력하세요";
        const dir = path.resolve(expandHome(answer));
        if (!existsSync(dir) || !statSync(dir).isDirectory()) return `${dir} 폴더가 없습니다`;
        if (!(await isGit(dir)))
          io.err(
            `  참고: ${dir} 는 git 저장소가 아닙니다. 작업이 한 번에 하나씩 폴더를 직접 수정합니다.`,
          );
        return { dir };
      },
      io,
    ).then(({ dir }) => dir);
  }
  return paths;
}

function notInteractive(): UsageError {
  return new UsageError(
    "터미널에서 실행하면 설정을 차례로 묻습니다. 터미널이 아니면 --router, --pairing-code (필요하면 --provider)를 주세요.",
  );
}

async function firstRunSetup(
  target: string,
  parsed: ParsedArgs,
  io: CliIo,
  deps: WorkerStartDeps,
): Promise<boolean> {
  const { ask } = deps;
  io.out("GGJIRA 워커 첫 설정입니다. 필요한 것만 차례로 묻습니다.\n");
  const routerUrl = await obtainRouterUrl(parsed, io, ask);
  // The LLM is chosen before the one-time code is redeemed, so a missing CLI never burns it.
  const providerType = await obtainProvider(parsed, io, deps);
  const baseDir = path.dirname(target);
  const credentialPath =
    stringOption(parsed, "credential") ?? path.join(baseDir, DEFAULT_CREDENTIAL);
  const paired = await pairInteractively({
    parsed,
    io,
    ask,
    routerUrl,
    credentialPath,
    force: Boolean(parsed.values.force),
  });
  if (!paired.profile) {
    io.err(
      "Router가 워커 프로필을 보내지 않았습니다. Router를 최신 버전으로 올린 뒤 다시 실행하세요.",
    );
    return false;
  }
  const dataDir = path.join(baseDir, "data/worker");
  const repoPaths = await chooseRepositoryPaths({
    profile: paired.profile,
    dataDir,
    io,
    ask,
    isGit: deps.isGitRepository ?? isGitRepository,
  });
  const config = workerConfigFromProfile({
    routerUrl,
    credentialPath,
    profile: paired.profile,
    providerType,
    dataDir,
    logPath: path.join(baseDir, "data/worker-logs"),
  }) as { repositories: Array<{ id: string; path: string }> };
  for (const repo of config.repositories) {
    const chosen = repoPaths[repo.id];
    if (chosen) repo.path = chosen;
  }
  writeWorkerConfig(target, config);
  io.out(`\n설정을 ${target} 에 저장했습니다.`);
  return true;
}

/** Asks for a folder for each configured repository that has neither a local copy nor a clone
 *  URL (e.g. a config written before), and saves the answers into the config file. */
async function fillMissingRepositoryPaths(
  target: string,
  config: WorkerConfig,
  io: CliIo,
  deps: WorkerStartDeps,
): Promise<WorkerConfig> {
  const missing = config.repositories.filter((repo) => !existsSync(repo.path) && !repo.cloneUrl);
  if (!missing.length || !deps.ask) return config;
  const paths = await chooseRepositoryPaths({
    profile: {
      capabilities: [],
      providerId: "default",
      repositories: missing.map((repo) => ({ id: repo.id })),
    },
    dataDir: config.dataDir,
    io,
    ask: deps.ask,
    isGit: deps.isGitRepository ?? isGitRepository,
  });
  const raw = JSON.parse(JSON.stringify(config)) as {
    repositories: Array<{ id: string; path: string }>;
  };
  for (const repo of raw.repositories) {
    const chosen = paths[repo.id];
    if (chosen) repo.path = chosen;
  }
  writeWorkerConfig(target, raw);
  return loadWorkerConfig(target);
}

/**
 * Everything `worker start` does before running. Returns undefined when the worker cannot run yet.
 */
export async function prepareWorkerStart(
  target: string,
  parsed: ParsedArgs,
  io: CliIo,
  deps: WorkerStartDeps = {},
): Promise<WorkerConfig | undefined> {
  if (!existsSync(target)) {
    if (!(await firstRunSetup(target, parsed, io, deps))) return undefined;
  }

  let config = loadWorkerConfig(target);
  if (!existsSync(config.credentialPath)) {
    io.out(`인증 파일(${config.credentialPath})이 없어 다시 페어링합니다.`);
    await pairInteractively({
      parsed,
      io,
      ask: deps.ask,
      routerUrl: config.routerUrl,
      credentialPath: config.credentialPath,
    });
  }
  config = await fillMissingRepositoryPaths(target, config, io, deps);

  const repos = await prepareRepositories(config, deps.clone);
  for (const id of repos.cloned) io.out(`저장소 "${id}"를 clone했습니다.`);
  for (const { id, error } of repos.failed) {
    io.err(
      `저장소 "${id}" clone 실패: ${error}\n  git 접근 권한(SSH 키 등)을 확인하고 다시 실행하세요.`,
    );
  }
  for (const { id, path: dir } of repos.missing) {
    io.err(
      `저장소 "${id}"의 로컬 폴더(${dir})가 없습니다. 터미널에서 다시 실행해 경로를 입력하거나, ${target}의 repositories[].path를 고치세요.`,
    );
  }
  if (repos.failed.length || repos.missing.length) return undefined;
  return config;
}
