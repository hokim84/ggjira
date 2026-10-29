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
import { resolveWorkerConfig } from "../src/worker-runtime/config.js";
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

// Every case clones and commits real git repositories; under a full parallel run on Windows that
// can pass vitest's default 5s (runbook §13).
describe("implementation scope checks (ADR 0036)", { timeout: 30_000 }, () => {
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
    options: {
      validateCommand?: string;
      validateTimeoutMs?: number;
      abortDuringValidation?: boolean;
    } = {},
  ): Promise<{ outcome: ExecutionOutcome; stages: string[] }> {
    const stages: string[] = [];
    const abort = new AbortController();
    const config = resolveWorkerConfig(
      {
        configVersion: 6,
        routerUrl: "http://127.0.0.1:8787",
        repositories: [
          {
            id: "repo1",
            path: clone,
            pushRemote: "origin",
            createPullRequest: false,
            ...(options.validateCommand ? { validateCommand: options.validateCommand } : {}),
            ...(options.validateTimeoutMs ? { validateTimeoutMs: options.validateTimeoutMs } : {}),
          },
        ],
        providers: [{ id: "default", type: "claude-code" }],
      },
      path.join(dir, "data"),
    );
    const outcome = await executeEnvelope(job, {
      config,
      createProvider: () => provider,
      signal: abort.signal,
      authorize: async (stage) => {
        stages.push(stage);
        if (stage === "validate" && options.abortDuringValidation) {
          setTimeout(() => abort.abort(), 300);
        }
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
    // M4-11: the exact commits a review attaches to.
    const worktree = git(["worktree", "list", "--porcelain"], clone)
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length))
      .find((entry) => entry.includes("ggjira-KAN-1")) as string;
    expect(outcome.git).toEqual({
      repository: "git",
      baseBranch: "main",
      baseSha: git(["rev-parse", "HEAD~1"], worktree).trim(),
      headSha: git(["rev-parse", "HEAD"], worktree).trim(),
      committed: true,
    });
  });

  describe("a child's checks (ADR 0061)", () => {
    const child = (): JobEnvelope => ({ ...envelope(), deferPullRequest: true });
    const reporting = (status: "not_verified" | "fail") =>
      new ScriptedProvider(
        (cwd) => writeFileSync(path.join(cwd, "src", "a.ts"), "export const a = 2;\n"),
        fakeSuccessResult({
          structuredOutput: fakeImplementationReport({
            verification: [
              { acceptance: "The change works", status: "pass", method: "executed", evidence: "t" },
              { acceptance: "The window scrolls", status, method: "inspected", evidence: "no UI" },
            ],
          }),
        }),
      );

    it("pushes a child whose only gap is an unverified check, for a human to confirm", async () => {
      const { outcome, stages } = await run(reporting("not_verified"), child());
      expect(outcome.status).toBe("succeeded");
      expect(stages).toEqual(["commit", "push"]);
      expect(outcome.artifacts?.some((a) => a.startsWith("pushed: origin/ggjira/KAN-1"))).toBe(
        true,
      );
      expect(remoteBranches()).toContain("ggjira/KAN-1");
    });

    it("fails a child with a failed check under the ordinary verification code", async () => {
      const { outcome, stages } = await run(reporting("fail"), child());
      expect(outcome.status).toBe("failed");
      // GGJ-302, not the unclassified GGJ-999 KAN-47 got.
      expect(outcome.failureReason).toBe("Verification failed: The window scrolls");
      expectStoppedBeforeCommit(outcome, stages);
    });
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
    expect(outcome.git).toMatchObject({ repository: "git", committed: false });
    expect(outcome.git?.headSha).toBeUndefined();
    // M4-12: a stopped run still says what it called; the fake reported no usage, so none.
    expect(outcome.execution).toMatchObject({
      providerId: "default",
      exitReason: "completed",
      modelSource: "configured",
    });
    expect(outcome.execution?.usage).toBeUndefined();
    const patchFile = outcome.localEvidence?.patchFile as string;
    expect(patchFile).toBe(path.join(dir, "data", "logs", "job-1-attempt-12345678.patch"));
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

  describe("trusted validation command", () => {
    const editing = () =>
      new ScriptedProvider(
        (cwd) => writeFileSync(path.join(cwd, "src", "a.ts"), "export const a = 2;\n"),
        fakeSuccessResult(),
      );
    const hang = 'node -e "setInterval(Date.now, 1000)"';

    it("runs after the commit and reports its summary", async () => {
      const command = 'node -e "process.exit(0)"';
      const { outcome, stages } = await run(editing(), envelope(), { validateCommand: command });

      expect(outcome.status).toBe("succeeded");
      expect(stages).toEqual(["commit", "validate", "push"]);
      expect(outcome.validation).toEqual([`"${command}" passed`]);
    });

    it("fails without pushing when the command fails, keeping the commit", async () => {
      const { outcome, stages } = await run(editing(), envelope(), {
        validateCommand: 'node -e "process.exit(3)"',
      });

      expect(outcome.status).toBe("failed");
      expect(outcome.failureReason).toMatch(/^Validation command failed: .*exited 3/);
      expect(outcome.timedOut).toBeUndefined();
      expect(outcome.git?.committed).toBe(true);
      expect(stages).toEqual(["commit", "validate"]);
      expect(remoteBranches()).not.toContain("ggjira/");
    });

    it("stops a running command when Router cancels or the lease is lost", async () => {
      const { outcome, stages } = await run(editing(), envelope(), {
        validateCommand: hang,
        abortDuringValidation: true,
      });

      expect(outcome.status).toBe("cancelled");
      expect(outcome.summary).toContain("Stopped during validation");
      expect(outcome.validation).toEqual(["validation cancelled"]);
      expect(stages).toEqual(["commit", "validate"]);
      expect(remoteBranches()).not.toContain("ggjira/");
    });

    it("times out a hung command with the job's timeout", async () => {
      const { outcome } = await run(
        editing(),
        { ...envelope(), timeoutMs: 500 },
        { validateCommand: hang },
      );

      expect(outcome.status).toBe("failed");
      expect(outcome.timedOut).toBe(true);
      expect(outcome.failureReason).toMatch(
        /^Validation command failed: ".*" did not finish within 500 ms and was stopped/,
      );
      expect(remoteBranches()).not.toContain("ggjira/");
    });

    it("stops a hung command at the repository's shorter validation timeout (ADR 0068)", async () => {
      const { outcome } = await run(editing(), envelope(), {
        validateCommand: hang,
        validateTimeoutMs: 500,
      });

      expect(outcome.status).toBe("failed");
      expect(outcome.timedOut).toBe(true);
      expect(outcome.failureReason).toMatch(/did not finish within 500 ms and was stopped/);
    });

    it("keeps the last output line of a passed command, so skipped tests show (ADR 0068)", async () => {
      const command = `node -e "console.log('Ran 3 tests'); console.error('OK (skipped=1)')"`;
      const { outcome } = await run(editing(), envelope(), { validateCommand: command });

      expect(outcome.validation).toEqual([`"${command}" passed — OK (skipped=1)`]);
    });
  });

  it("reports the path check as not done in a non-git workspace", async () => {
    const plain = path.join(dir, "plain");
    mkdirSync(plain);
    const provider = new ScriptedProvider(
      (cwd) => writeFileSync(path.join(cwd, "x.txt"), "x\n"),
      fakeSuccessResult(),
    );
    const config = resolveWorkerConfig(
      {
        configVersion: 6,
        routerUrl: "http://127.0.0.1:8787",
        repositories: [{ id: "repo1", path: plain }],
        providers: [{ id: "default", type: "claude-code" }],
      },
      path.join(dir, "data"),
    );
    const outcome = await executeEnvelope(envelope(), {
      config,
      createProvider: () => provider,
      signal: new AbortController().signal,
      authorize: async () => true,
    });

    expect(outcome.status).toBe("succeeded");
    expect(outcome.scopeCheck).toMatchObject({ checked: false, reason: "not a git workspace" });
    expect(outcome.git).toEqual({ repository: "none", committed: false });
  });
});
