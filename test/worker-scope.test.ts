import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JobEnvelope } from "../src/contracts/envelope.js";
import type { ExecutionContract } from "../src/contracts/implementation.js";
import { PROTOCOL_VERSION } from "../src/contracts/protocol.js";
import { WorkerConfigSchema } from "../src/worker-runtime/config.js";
import { type ExecutionOutcome, executeEnvelope } from "../src/worker-runtime/executor.js";
import { fakeImplementationReport, fakeSuccessResult } from "../src/worker/fake.js";
import type { WorkerProvider, WorkerRequest, WorkerResult } from "../src/worker/provider.js";

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

/** Edits the job's working directory, then answers with `result`. Records what it was asked. */
class ScriptedProvider implements WorkerProvider {
  requests: WorkerRequest[] = [];
  constructor(
    private readonly edit: (cwd: string) => void,
    private readonly result: WorkerResult,
  ) {}

  async run(request: WorkerRequest): Promise<WorkerResult> {
    this.requests.push(request);
    this.edit(request.cwd);
    return this.result;
  }
}

function contract(overrides: Partial<ExecutionContract> = {}): ExecutionContract {
  return {
    acceptance: ["The change works"],
    verification: ["npm run test"],
    inScope: ["The change"],
    outOfScope: ["Data model changes"],
    affectedAreas: ["src"],
    allowedPaths: ["src/**"],
    constraints: [],
    ...overrides,
  };
}

function envelope(executionContract: ExecutionContract | undefined = contract()): JobEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    jobId: "job-1",
    attemptId: "attempt-12345678",
    leaseToken: "lease",
    workspaceId: "default",
    repositoryId: "repo1",
    kind: "implementation",
    providerId: "default",
    approvalId: "approval-1",
    inputHash: "v2:hash",
    issueSnapshot: {
      key: "KAN-1",
      id: "1",
      summary: "Change the code",
      description: "Do it",
      statusName: "작업 중",
      labels: [],
      assigneeAccountId: "user-1",
      issueTypeName: "Task",
      parentKey: null,
      projectKey: "KAN",
    },
    ...(executionContract ? { executionContract } : {}),
    systemPrompt: "system",
    timeoutMs: 60_000,
  };
}

const decision = {
  question: "Change the users table?",
  options: [
    { id: "a", title: "Add a column" },
    { id: "b", title: "Keep the schema" },
  ],
  recommendation: "b",
  impact: "Needs a migration",
};

describe("implementation scope checks (ADR 0036)", () => {
  let dir: string;
  let remote: string;
  let clone: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ggjira-scope-"));
    const seed = path.join(dir, "seed");
    mkdirSync(path.join(seed, "src"), { recursive: true });
    mkdirSync(path.join(seed, "docs"), { recursive: true });
    git(["init"], seed);
    writeFileSync(path.join(seed, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(path.join(seed, "docs", "b.md"), "# b\n");
    git(["add", "."], seed);
    git(["commit", "-m", "init"], seed);
    remote = path.join(dir, "remote.git");
    git(["clone", "--bare", seed, remote], dir);
    clone = path.join(dir, "clone");
    git(["clone", remote, clone], dir);
    // The worker commits in this clone; CI runners have no global git identity.
    git(["config", "user.email", "t@example.com"], clone);
    git(["config", "user.name", "t"], clone);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function run(
    provider: WorkerProvider,
    job: JobEnvelope = envelope(),
  ): Promise<{ outcome: ExecutionOutcome; stages: string[] }> {
    const stages: string[] = [];
    const config = WorkerConfigSchema.parse({
      configVersion: 5,
      routerUrl: "http://127.0.0.1:8787",
      credentialPath: path.join(dir, "credential.json"),
      repositories: [{ id: "repo1", path: clone, pushRemote: "origin", createPullRequest: false }],
      providers: [{ id: "default", type: "claude-code" }],
      dataDir: path.join(dir, "data"),
      logPath: path.join(dir, "logs"),
    });
    const outcome = await executeEnvelope(job, {
      config,
      createProvider: () => provider,
      worktreesRoot: path.join(dir, "data", "worktrees"),
      signal: new AbortController().signal,
      authorize: async (stage) => {
        stages.push(stage);
        return true;
      },
    });
    return { outcome, stages };
  }

  function remoteBranches(): string {
    return git(["branch", "--list"], remote);
  }

  function expectStoppedBeforeCommit(outcome: ExecutionOutcome, stages: string[]): void {
    expect(stages).toEqual([]);
    expect(remoteBranches()).not.toContain("ggjira/");
    const worktree = outcome.localEvidence?.worktreePath as string;
    expect(git(["log", "--oneline"], worktree).trim().split("\n")).toHaveLength(1);
  }

  it("passes the contract and the report schema to the provider", async () => {
    const provider = new ScriptedProvider(
      (cwd) => writeFileSync(path.join(cwd, "src", "a.ts"), "export const a = 2;\n"),
      fakeSuccessResult(),
    );
    await run(provider);
    const [request] = provider.requests;
    expect(request?.prompt).toContain("Allowed paths");
    expect(request?.prompt).toContain("src/**");
    expect(request?.outputSchema).toMatchObject({ required: expect.arrayContaining(["outcome"]) });
  });

  it("commits and pushes a change inside the allowed paths, with a checked scope", async () => {
    const provider = new ScriptedProvider(
      (cwd) => writeFileSync(path.join(cwd, "src", "a.ts"), "export const a = 2;\n"),
      fakeSuccessResult(),
    );
    const { outcome, stages } = await run(provider);

    expect(outcome.status).toBe("succeeded");
    expect(stages).toEqual(["commit", "push"]);
    expect(outcome.scopeCheck).toEqual({
      checked: true,
      changedPaths: [{ path: "src/a.ts", change: "modified" }],
      outsideAllowed: [],
    });
    expect(outcome.implementation?.verification).toHaveLength(1);
    expect(outcome.localEvidence).toBeUndefined();
  });

  it("stops before commit/push on a path outside the contract, keeping a patch", async () => {
    const provider = new ScriptedProvider((cwd) => {
      writeFileSync(path.join(cwd, "src", "a.ts"), "export const a = 2;\n");
      writeFileSync(path.join(cwd, "schema.sql"), "ALTER TABLE users ADD x int;\n");
    }, fakeSuccessResult());
    const { outcome, stages } = await run(provider);

    expect(outcome.status).toBe("needs_decision");
    expect(outcome.scopeCheck?.outsideAllowed).toEqual([{ path: "schema.sql", change: "added" }]);
    expectStoppedBeforeCommit(outcome, stages);
    const patchFile = outcome.localEvidence?.patchFile as string;
    expect(patchFile).toBe(path.join(dir, "logs", "job-1-attempt-12345678.patch"));
    const patch = readFileSync(patchFile, "utf-8");
    expect(patch).toContain("schema.sql");
    expect(patch).toContain("src/a.ts");
    expect(outcome.localEvidence?.cleanup).toContain("git worktree remove");
  });

  it("stops on a deviation the agent reports even when no path check applies", async () => {
    const provider = new ScriptedProvider(
      (cwd) => writeFileSync(path.join(cwd, "docs", "b.md"), "# changed\n"),
      fakeSuccessResult({
        structuredOutput: fakeImplementationReport({
          scopeDeviations: [{ description: "Changed the public API", reason: "needed for X" }],
        }),
      }),
    );
    const { outcome, stages } = await run(provider, envelope(contract({ allowedPaths: [] })));

    expect(outcome.status).toBe("needs_decision");
    expect(outcome.scopeCheck).toMatchObject({
      checked: false,
      reason: expect.stringContaining("no allowedPaths"),
    });
    expect(outcome.implementation?.scopeDeviations).toHaveLength(1);
    expectStoppedBeforeCommit(outcome, stages);
  });

  it("stops when the agent asks for a decision, carrying the decision through", async () => {
    const provider = new ScriptedProvider(
      () => {},
      fakeSuccessResult({
        structuredOutput: fakeImplementationReport({
          outcome: "needs_decision",
          summary: "A migration is needed",
          verification: [],
          decision,
        }),
      }),
    );
    const { outcome, stages } = await run(provider);

    expect(outcome.status).toBe("needs_decision");
    expect(outcome.summary).toBe("A migration is needed");
    expect(outcome.implementation?.decision?.question).toBe(decision.question);
    expect(stages).toEqual([]);
  });

  it("sees renames, deletions and new files, checking both ends of a rename", async () => {
    const provider = new ScriptedProvider((cwd) => {
      git(["mv", "src/a.ts", "src/renamed.ts"], cwd);
      mkdirSync(path.join(cwd, "src", "new"), { recursive: true });
      writeFileSync(path.join(cwd, "src", "new", "c.ts"), "export const c = 3;\n");
      unlinkSync(path.join(cwd, "docs", "b.md"));
    }, fakeSuccessResult());
    const { outcome } = await run(provider);

    const changed = outcome.scopeCheck?.changedPaths ?? [];
    expect(changed).toEqual(
      expect.arrayContaining([
        { path: "src/renamed.ts", change: "renamed", from: "src/a.ts" },
        { path: "src/new/c.ts", change: "added" },
        { path: "docs/b.md", change: "deleted" },
      ]),
    );
    expect(outcome.scopeCheck?.outsideAllowed).toEqual([{ path: "docs/b.md", change: "deleted" }]);
    expect(outcome.status).toBe("needs_decision");
  });

  it("flags a rename whose old path is outside the allowed paths", async () => {
    const provider = new ScriptedProvider((cwd) => {
      mkdirSync(path.join(cwd, "src", "docs"), { recursive: true });
      git(["mv", "docs/b.md", "src/docs/b.md"], cwd);
    }, fakeSuccessResult());
    const { outcome } = await run(provider);

    expect(outcome.scopeCheck?.outsideAllowed).toEqual([
      { path: "src/docs/b.md", change: "renamed", from: "docs/b.md" },
    ]);
  });

  it("also sees changes an agent committed itself", async () => {
    const provider = new ScriptedProvider((cwd) => {
      writeFileSync(path.join(cwd, "outside.txt"), "x\n");
      git(["add", "."], cwd);
      git(["commit", "-m", "agent commit"], cwd);
    }, fakeSuccessResult());
    const { outcome, stages } = await run(provider);

    expect(outcome.status).toBe("needs_decision");
    expect(outcome.scopeCheck?.outsideAllowed).toEqual([{ path: "outside.txt", change: "added" }]);
    expect(stages).toEqual([]);
    expect(readFileSync(outcome.localEvidence?.patchFile as string, "utf-8")).toContain(
      "outside.txt",
    );
  });

  it.each([
    ["no JSON at all", fakeSuccessResult({ structuredOutput: undefined, summary: "All done!" })],
    [
      "a report of the wrong shape",
      fakeSuccessResult({ structuredOutput: { outcome: "finished", summary: "x" } }),
    ],
    [
      "completion without verification evidence",
      fakeSuccessResult({ structuredOutput: fakeImplementationReport({ verification: [] }) }),
    ],
    [
      "a failed acceptance check",
      fakeSuccessResult({
        structuredOutput: fakeImplementationReport({
          verification: [{ acceptance: "The change works", status: "fail", evidence: "1 failed" }],
        }),
      }),
    ],
  ])("fails, without committing, on %s", async (_label, result) => {
    const provider = new ScriptedProvider(
      (cwd) => writeFileSync(path.join(cwd, "src", "a.ts"), "export const a = 2;\n"),
      result,
    );
    const { outcome, stages } = await run(provider);

    expect(outcome.status).toBe("failed");
    expect(outcome.failureReason).toBeTruthy();
    expectStoppedBeforeCommit(outcome, stages);
    expect(existsSync(outcome.localEvidence?.patchFile as string)).toBe(true);
  });

  it("reports the path check as not done in a non-git workspace", async () => {
    const plain = path.join(dir, "plain");
    mkdirSync(plain);
    const provider = new ScriptedProvider(
      (cwd) => writeFileSync(path.join(cwd, "x.txt"), "x\n"),
      fakeSuccessResult(),
    );
    const config = WorkerConfigSchema.parse({
      configVersion: 5,
      routerUrl: "http://127.0.0.1:8787",
      credentialPath: path.join(dir, "credential.json"),
      repositories: [{ id: "repo1", path: plain }],
      providers: [{ id: "default", type: "claude-code" }],
      dataDir: path.join(dir, "data"),
      logPath: path.join(dir, "logs"),
    });
    const outcome = await executeEnvelope(envelope(), {
      config,
      createProvider: () => provider,
      worktreesRoot: path.join(dir, "data", "worktrees"),
      signal: new AbortController().signal,
      authorize: async () => true,
    });

    expect(outcome.status).toBe("succeeded");
    expect(outcome.scopeCheck).toMatchObject({ checked: false, reason: "not a git workspace" });
  });
});
