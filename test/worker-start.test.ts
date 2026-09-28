import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CliIo, parseCommandArgs } from "../src/cli-io.js";
import { CloneUrlSchema } from "../src/contracts/api.js";
import { prepareWorkerStart } from "../src/worker-runtime/start.js";
import { loadWorkerConfig, WorkerConfigSchema } from "../src/worker-runtime/config.js";
import { loadWorkerCredential } from "../src/worker-runtime/credential.js";
import { chooseProvider, workerConfigFromProfile } from "../src/worker-runtime/ops.js";
import { workerPolicy } from "./helpers/router-fixtures.js";
import { RouterHarness } from "./helpers/router-harness.js";

function captureIo(): CliIo & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, env: {}, out: (l) => stdout.push(l), err: (l) => stderr.push(l) };
}

const START_OPTIONS = {
  config: { type: "string" },
  "pairing-code": { type: "string" },
  router: { type: "string" },
  provider: { type: "string" },
  name: { type: "string" },
  credential: { type: "string" },
  force: { type: "boolean" },
} as const;

function git(args: string[], cwd: string): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=t",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    { cwd, encoding: "utf-8" },
  );
}

describe("CloneUrlSchema", () => {
  it("accepts https, ssh, file and scp-like git URLs", () => {
    for (const url of [
      "https://github.com/org/repo.git",
      "ssh://git@github.com/org/repo.git",
      "file:///srv/git/repo.git",
      "git@github.com:org/repo.git",
    ]) {
      expect(CloneUrlSchema.safeParse(url).success, url).toBe(true);
    }
  });

  it("refuses options, transport helpers and whitespace", () => {
    for (const url of [
      "--upload-pack=touch /tmp/x",
      "ext::sh -c touch% /tmp/x",
      "fd::3",
      "https://github.com/org/repo.git --depth=1",
      "/local/path",
      "http://github.com/org/repo.git",
    ]) {
      expect(CloneUrlSchema.safeParse(url).success, url).toBe(false);
    }
  });
});

describe("chooseProvider", () => {
  it("takes --provider, else the only installed CLI, else asks", async () => {
    expect(await chooseProvider({ requested: "codex", installed: [] })).toBe("codex");
    expect(await chooseProvider({ installed: ["claude-code"] })).toBe("claude-code");
    const asked: string[] = [];
    const picked = await chooseProvider({
      installed: ["claude-code", "codex"],
      ask: async (question) => {
        asked.push(question);
        return asked.length === 1 ? "9" : "2";
      },
    });
    expect(picked).toBe("codex");
    expect(asked[0]).toContain("1) Claude Code");
    expect(await chooseProvider({ installed: ["claude-code", "codex"], ask: async () => "" })).toBe(
      "claude-code",
    );
  });

  it("fails clearly when nothing is installed or a choice cannot be asked", async () => {
    await expect(chooseProvider({ installed: [] })).rejects.toThrow(/LLM CLI를 찾지 못했습니다/);
    await expect(chooseProvider({ installed: ["claude-code", "codex"] })).rejects.toThrow(
      /--provider로 고르세요/,
    );
    await expect(chooseProvider({ requested: "gpt", installed: [] })).rejects.toThrow(
      /--provider는/,
    );
  });
});

describe("workerConfigFromProfile", () => {
  it("builds a valid worker config from Router's profile", () => {
    const config = WorkerConfigSchema.parse(
      workerConfigFromProfile({
        routerUrl: "https://router.example.com",
        credentialPath: "data/worker-credential.json",
        providerType: "codex",
        profile: {
          capabilities: ["programming"],
          providerId: "default",
          repositories: [
            { id: "repo1", cloneUrl: "git@github.com:org/repo.git", baseBranch: "dev" },
          ],
        },
      }),
    );
    expect(config.providers).toEqual([expect.objectContaining({ id: "default", type: "codex" })]);
    expect(config.repositories[0]).toMatchObject({
      id: "repo1",
      path: path.join("data/worker", "repos", "repo1"),
      baseBranch: "dev",
      cloneUrl: "git@github.com:org/repo.git",
    });
    expect(config.capabilities).toEqual(["programming"]);
  });
});

/** Answers questions in order, recording what was asked. */
function scripted(answers: string[]) {
  const asked: string[] = [];
  const ask = async (question: string) => {
    asked.push(question);
    const answer = answers.shift();
    if (answer === undefined) throw new Error(`unexpected question: ${question}`);
    return answer;
  };
  return { ask, asked, answers };
}

describe("worker start against a running Router", () => {
  let dir: string;
  let source: string;
  let router: RouterHarness;
  let url: string;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ggjira-worker-start-"));
    source = path.join(dir, "source");
    mkdirSync(source);
    git(["init"], source);
    writeFileSync(path.join(source, "README.md"), "hello\n");
    git(["add", "."], source);
    git(["commit", "-m", "init"], source);

    const configPath = path.join(dir, "router.config.json");
    router = new RouterHarness({
      configPath,
      config: {
        repositories: [{ id: "repo1", cloneUrl: `file://${source}`, baseBranch: "main" }],
        workers: [workerPolicy({ workerId: "worker-1" })],
      },
    });
    writeFileSync(configPath, JSON.stringify(router.config, null, 2));
    url = await router.app.listen({ host: "127.0.0.1", port: 0 });
  });

  afterEach(async () => {
    await router.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function addWorker(workerId: string): Promise<string> {
    const added = await router.adminCall("POST", "/workers", {
      workerId,
      allowedCapabilities: ["programming"],
      allowedRepositoryIds: ["repo1"],
    });
    expect(added.statusCode).toBe(201);
    return (added.json() as { pairingCode: string }).pairingCode;
  }

  const noFlags = parseCommandArgs([], START_OPTIONS);

  it("text setup: asks Router address, LLM, pairing code and repository folder, then runs", async () => {
    const pairingCode = await addWorker("laptop-1");
    const workerDir = path.join(dir, "worker");
    const configPath = path.join(workerDir, "worker.config.json");
    const script = scripted([
      "ftp://nope", // not an allowed Router URL → asked again
      url,
      "2", // codex
      "wrong-code", // rejected, code not used up → asked again
      pairingCode,
      "", // Enter: clone to the default folder
    ]);
    const io = captureIo();
    const config = await prepareWorkerStart(configPath, noFlags, io, {
      ask: script.ask,
      commandRuns: () => true,
    });

    expect(config).toBeDefined();
    expect(script.answers).toEqual([]);
    expect(script.asked.filter((q) => q.startsWith("Router 주소"))).toHaveLength(2);
    expect(
      script.asked.some((q) => q.includes("1) Claude Code") && q.includes("2) OpenAI Codex")),
    ).toBe(true);
    expect(script.asked.filter((q) => q.startsWith("페어링 코드"))).toHaveLength(2);
    expect(io.stderr.join("\n")).toContain("페어링 코드가 맞지 않거나 만료됐습니다");

    const written = loadWorkerConfig(configPath);
    expect(written.providers[0]).toMatchObject({ id: "default", type: "codex" });
    const repo = written.repositories[0];
    expect(repo?.path).toBe(path.join(workerDir, "data/worker", "repos", "repo1"));
    expect(existsSync(path.join(repo?.path ?? "", "README.md"))).toBe(true);
    const credential = loadWorkerCredential(written.credentialPath);
    expect(credential.workerId).toBe("laptop-1");
    expect(readFileSync(configPath, "utf-8")).not.toContain(credential.workerToken);

    // Second run: nothing asked, nothing re-cloned.
    const again = scripted([]);
    expect(
      await prepareWorkerStart(configPath, noFlags, captureIo(), { ask: again.ask }),
    ).toBeDefined();
    expect(again.asked).toEqual([]);
  });

  it("uses an existing local clone when Router has no clone URL for the repository", async () => {
    await router.adminCall("PUT", "/config", { ...router.config, repositories: [{ id: "repo1" }] });
    const pairingCode = await addWorker("laptop-2");
    const configPath = path.join(dir, "w2", "worker.config.json");
    const script = scripted([url, pairingCode, path.join(dir, "no-such-folder"), source]);
    const config = await prepareWorkerStart(configPath, noFlags, captureIo(), {
      ask: script.ask,
      commandRuns: (command) => command === "claude",
    });
    expect(config?.repositories[0]?.path).toBe(source);
    expect(script.asked.at(-1)).toContain("clone해 둔 폴더의 전체 경로");
  });

  it("flags still work without a terminal", async () => {
    const pairingCode = await addWorker("server-1");
    const configPath = path.join(dir, "w3", "worker.config.json");
    const config = await prepareWorkerStart(
      configPath,
      parseCommandArgs(
        ["--router", url, "--pairing-code", pairingCode, "--provider", "claude-code"],
        START_OPTIONS,
      ),
      captureIo(),
    );
    expect(config?.providers[0]?.type).toBe("claude-code");
    expect(existsSync(path.join(dir, "w3", "data/worker/repos/repo1/README.md"))).toBe(true);
  });

  it("without a terminal or flags, explains how to answer the setup", async () => {
    await expect(
      prepareWorkerStart(path.join(dir, "w4", "worker.config.json"), noFlags, captureIo()),
    ).rejects.toThrow(/터미널에서 실행하면/);
  });

  it("keeps the pairing code when no LLM CLI is installed", async () => {
    const pairingCode = await addWorker("laptop-3");
    const configPath = path.join(dir, "w5", "worker.config.json");
    const args = parseCommandArgs(["--router", url, "--pairing-code", pairingCode], START_OPTIONS);
    await expect(
      prepareWorkerStart(configPath, args, captureIo(), { commandRuns: () => false }),
    ).rejects.toThrow(/LLM CLI를 찾지 못했습니다/);
    expect(existsSync(configPath)).toBe(false);

    const config = await prepareWorkerStart(configPath, args, captureIo(), {
      commandRuns: (command) => command === "codex",
    });
    expect(config?.providers[0]?.type).toBe("codex");
  });

  it("asks for a folder later when a saved config points at a missing repository", async () => {
    const pairingCode = await addWorker("laptop-4");
    const configPath = path.join(dir, "w6", "worker.config.json");
    await prepareWorkerStart(
      configPath,
      parseCommandArgs(
        ["--router", url, "--pairing-code", pairingCode, "--provider", "codex"],
        START_OPTIONS,
      ),
      captureIo(),
    );
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    raw.repositories[0].path = path.join(dir, "gone");
    raw.repositories[0].cloneUrl = undefined;
    writeFileSync(configPath, JSON.stringify(raw));

    const io = captureIo();
    expect(await prepareWorkerStart(configPath, noFlags, io)).toBeUndefined();
    expect(io.stderr.join("\n")).toContain("로컬 폴더");

    const script = scripted([source]);
    const config = await prepareWorkerStart(configPath, noFlags, captureIo(), { ask: script.ask });
    expect(config?.repositories[0]?.path).toBe(source);
    expect(loadWorkerConfig(configPath).repositories[0]?.path).toBe(source);
  });

  it("refuses a duplicate or invalid worker policy", async () => {
    const duplicate = await router.adminCall("POST", "/workers", {
      workerId: "worker-1",
      allowedRepositoryIds: ["repo1"],
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ error: "worker_exists" });
    const badRepo = await router.adminCall("POST", "/workers", {
      workerId: "w2",
      allowedRepositoryIds: ["nope"],
    });
    expect(badRepo.statusCode).toBe(400);
    const badId = await router.adminCall("POST", "/workers", {
      workerId: "has space",
      allowedRepositoryIds: ["repo1"],
    });
    expect(badId.statusCode).toBe(400);
  });
});
