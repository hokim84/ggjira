import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import type { FciTask } from "../contracts/fci.js";
import { FciOutcomeSchema } from "../contracts/fci.js";
import type { WorkerProviderConfig } from "../contracts/provider.js";
import type { WorkerProvider } from "../worker/provider.js";
import { RouterApiError, type RouterClient } from "./client.js";
import type { WorkerConfig } from "./config.js";
import { executeFci } from "./fci.js";

function save(dir: string, id: string, payload: unknown) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.json`);
  const fd = openSync(`${file}.tmp`, "w");
  try {
    writeSync(fd, JSON.stringify(payload));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(`${file}.tmp`, file);
  return file;
}
export async function flushFciSpool(config: WorkerConfig, client: RouterClient) {
  const dir = path.resolve(config.dataDir, "fci-spool");
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
    const file = path.join(dir, name);
    try {
      const message = JSON.parse(readFileSync(file, "utf8"));
      if (message.kind === "source") await client.source(message.id, message.body);
      else {
        message.body.outcome = FciOutcomeSchema.parse(message.body.outcome);
        await client.fciResult(message.id, message.body);
      }
      unlinkSync(file);
    } catch (error) {
      if (error instanceof RouterApiError && error.status === 409) unlinkSync(file);
    }
  }
}
export async function recordFciSource(
  config: WorkerConfig,
  client: RouterClient,
  id: string,
  body: {
    sessionId: string;
    attemptId: string;
    leaseToken: string;
    sha: string;
    observedAt: string;
  },
) {
  const file = save(path.resolve(config.dataDir, "fci-spool"), `source-${randomUUID()}`, {
    kind: "source",
    id,
    body,
  });
  try {
    await client.source(id, body);
    unlinkSync(file);
  } catch {
    /* Implementation remains independent of FCI source reporting. */
  }
}
export async function runFciTask(
  task: FciTask,
  deps: {
    config: WorkerConfig;
    client: RouterClient;
    sessionId: string;
    createProvider: (config: WorkerProviderConfig) => WorkerProvider;
    worktreesRoot: string;
  },
) {
  const providerConfig = deps.config.providers.find((p) => p.id === task.providerId);
  const repository = deps.config.repositories.find((r) => r.id === task.repositoryId);
  const abort = new AbortController();
  let lastSuccess = Date.now();
  let done = false;
  const beat = async () => {
    try {
      const r = await deps.client.fciBeat(task.id, {
        sessionId: deps.sessionId,
        leaseToken: task.leaseToken,
      });
      lastSuccess = Date.now();
      if (r.cancel) abort.abort();
    } catch {
      if (Date.now() - lastSuccess >= 20000) abort.abort();
    }
  };
  const timer = setInterval(() => {
    if (!done) void beat();
  }, 5000);
  const timeout = setTimeout(() => abort.abort(), task.timeoutMs);
  try {
    const outcome =
      repository &&
      ((task.staticAnalysis && task.purpose !== "explain") ||
        (providerConfig &&
          (task.staticAnalysis ||
            (providerConfig.model === task.model && providerConfig.type === task.providerType))))
        ? await executeFci(task, {
            repository,
            ...(providerConfig && (!task.staticAnalysis || task.purpose === "explain")
              ? { provider: deps.createProvider(providerConfig) }
              : {}),
            worktreesRoot: deps.worktreesRoot,
            signal: abort.signal,
            lookup: async (sha) => {
              while (!abort.signal.aborted) {
                try {
                  if (task.purpose === "explain") return null;
                  return (
                    await deps.client.fciLookup(task.id, {
                      sessionId: deps.sessionId,
                      leaseToken: task.leaseToken,
                      sha,
                    })
                  ).snapshot;
                } catch (error) {
                  if (!(error instanceof RouterApiError) || error.status !== 425) throw error;
                  await new Promise((resolve) => setTimeout(resolve, 500));
                }
              }
              throw new Error("FCI analysis cancelled while waiting for identical snapshot");
            },
            publish: (snapshot) =>
              deps.client.fciPublish(task.id, {
                sessionId: deps.sessionId,
                leaseToken: task.leaseToken,
                snapshot,
              }),
          })
        : {
            status: "failed" as const,
            reason: "FCI requires a repository and provider with an explicit matching model ID",
            snapshots: [],
          };
    const body = {
      sessionId: deps.sessionId,
      leaseToken: task.leaseToken,
      resultId: randomUUID(),
      outcome,
    };
    const file = save(path.resolve(deps.config.dataDir, "fci-spool"), `result-${body.resultId}`, {
      kind: "analysis",
      id: task.id,
      body,
    });
    try {
      await deps.client.fciResult(task.id, body);
      unlinkSync(file);
    } catch {
      /* Spooled, retry independently on the next poll. */
    }
  } finally {
    done = true;
    clearInterval(timer);
    clearTimeout(timeout);
  }
}
