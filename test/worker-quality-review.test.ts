import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JobEnvelope } from "../src/contracts/envelope.js";
import { PROTOCOL_VERSION } from "../src/contracts/protocol.js";
import { resolveWorkerConfig, type WorkerRepositoryConfig } from "../src/worker-runtime/config.js";
import { executeEnvelope } from "../src/worker-runtime/executor.js";
import { executePlanningEnvelope } from "../src/worker-runtime/planning.js";
import { executeQualityEnvelope } from "../src/worker-runtime/quality.js";
import { fakeSuccessResult } from "../src/worker/fake.js";
import type { WorkerProvider } from "../src/worker/provider.js";

describe("Git-pinned integration validation worker", () => {
  let dir: string;
  let source: string;
  let repository: WorkerRepositoryConfig;
  let envelope: JobEnvelope;
  let baselineSha: string;
  let targetSha: string;
  let calls: number;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ggjira-quality-"));
    source = path.join(dir, "source");
    mkdirSync(source);
    git(source, "init", "-b", "main");
    git(source, "config", "user.email", "test@example.invalid");
    git(source, "config", "user.name", "test");
    writeFileSync(path.join(source, "feature.txt"), "baseline\n");
    git(source, "add", ".");
    git(source, "commit", "-m", "baseline");
    baselineSha = git(source, "rev-parse", "HEAD");
    git(dir, "clone", "--bare", source, "remote.git");
    git(source, "remote", "add", "origin", path.join(dir, "remote.git"));
    git(dir, "clone", path.join(dir, "remote.git"), "worker");
    // The shared worker checkout is deliberately behind the remote's integrated result.
    writeFileSync(path.join(source, "feature.txt"), "integrated\n");
    git(source, "add", ".");
    git(source, "commit", "-m", "integrated");
    git(source, "push", "origin", "main");
    targetSha = git(source, "rev-parse", "HEAD");
    calls = 0;
    repository = {
      id: "repo1",
      path: path.join(dir, "worker"),
      baseBranch: "main",
      validateCommand: 'node -e "process.exit(0)"',
      pushRemote: "origin",
      createPullRequest: false,
    };
    envelope = {
      protocolVersion: PROTOCOL_VERSION,
      jobId: "quality-job",
      attemptId: "quality-attempt",
      leaseToken: "lease",
      workspaceId: "ws1",
      repositoryId: "repo1",
      kind: "integration_check",
      providerId: "default",
      approvalId: "quality:cycle",
      inputHash: "v2:test",
      timeoutMs: 10000,
      systemPrompt: "read only",
      issueSnapshot: {
        key: "KAN-1",
        id: "1",
        summary: "Feature",
        description: "Feature",
        statusName: "AI 검토",
        labels: [],
        assigneeAccountId: "owner",
        issueTypeName: "Task",
        parentKey: null,
        projectKey: "KAN",
      },
      qualityContext: {
        cycleId: "cycle",
        planVersion: "v1",
        policyVersion: 1,
        objective: "Feature",
        acceptance: ["Works"],
        verification: ["Run tests"],
        integration: { baseBranch: "main", mergeCommits: [targetSha] },
        resultIds: ["result1"],
        previousFindings: [],
      },
    };
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  function provider(hook?: (cwd: string) => void, verificationPassed = true): WorkerProvider {
    return {
      run: async (request) => {
        calls++;
        expect(request.readOnly).toBe(true);
        expect(request.systemPrompt).toBe(envelope.systemPrompt);
        expect(git(request.cwd, "rev-parse", "HEAD")).toBe(targetSha);
        hook?.(request.cwd);
        return fakeSuccessResult({
          structuredOutput: {
            targetSha,
            baselineSha,
            summary: "Integrated feature inspected",
            verificationPassed,
            verificationEvidence: ["feature.txt contains integrated outcome"],
            findings: [],
          },
        });
      },
    };
  }
  function execute(worker = provider()) {
    return executeQualityEnvelope(envelope, {
      repository,
      provider: worker,
      worktreesRoot: path.join(dir, "worktrees"),
      logPath: path.join(dir, "logs"),
      signal: new AbortController().signal,
    });
  }
  function context() {
    if (!envelope.qualityContext) throw new Error("missing test context");
    return envelope.qualityContext;
  }
  it.each(["planning", "implementation"] as const)(
    "fetches the latest remote before %s and preserves local edits and HEAD",
    async (kind) => {
      writeFileSync(path.join(repository.path, "feature.txt"), "local edit\n");
      const worker: WorkerProvider = {
        run: async (request) => {
          calls++;
          expect(git(request.cwd, "rev-parse", "HEAD")).toBe(targetSha);
          expect(readFileSync(path.join(request.cwd, "feature.txt"), "utf8")).toBe("integrated\n");
          return fakeSuccessResult({
            structuredOutput:
              kind === "planning"
                ? { summary: "Plan", needsDecision: false, tasks: [] }
                : undefined,
          });
        },
      };
      const job = { ...envelope, kind, qualityContext: undefined };
      const deps = {
        repository,
        provider: worker,
        worktreesRoot: path.join(dir, "worktrees"),
        logPath: path.join(dir, "logs"),
        signal: new AbortController().signal,
      };
      if (kind === "planning") await executePlanningEnvelope(job, deps);
      else
        await executeEnvelope(job, {
          ...deps,
          config: resolveWorkerConfig(
            {
              configVersion: 6,
              routerUrl: "http://localhost:8787",
              repositories: [repository],
              providers: [{ id: "default", type: "claude-code" }],
            },
            path.join(dir, "data"),
          ),
          createProvider: () => worker,
          authorize: async () => true,
        });
      expect(calls).toBe(1);
      expect(git(repository.path, "rev-parse", "HEAD")).toBe(baselineSha);
      expect(readFileSync(path.join(repository.path, "feature.txt"), "utf8")).toBe("local edit\n");
    },
  );
  it("does not start planning when fetching the remote fails", async () => {
    git(repository.path, "remote", "set-url", "origin", path.join(dir, "missing.git"));
    const result = await executePlanningEnvelope(
      { ...envelope, kind: "planning" },
      {
        repository,
        provider: provider(),
        worktreesRoot: path.join(dir, "worktrees"),
        logPath: path.join(dir, "logs"),
        signal: new AbortController().signal,
      },
    );
    expect(result.status).toBe("failed");
    expect(calls).toBe(0);
  });
  it("fetches the integrated target without resetting the shared checkout", async () => {
    const result = await execute();
    expect(result).toMatchObject({
      status: "succeeded",
      quality: { targetSha, verificationPassed: true },
    });
    expect(git(repository.path, "rev-parse", "HEAD")).toBe(baselineSha);
    expect(calls).toBe(0);
  });
  it("refuses a dependency that is absent from the integrated target", async () => {
    context().integration.mergeCommits = ["f".repeat(40)];
    expect((await execute()).status).toBe("failed");
    expect(calls).toBe(0);
  });
  it("rejects a stale expected target before calling the model", async () => {
    context().expectedSha = baselineSha;
    expect((await execute()).failureReason).toContain("stale quality target");
    expect(calls).toBe(0);
  });
  it("validates the pinned merge even if another PR advanced the target branch", async () => {
    context().expectedSha = targetSha;
    writeFileSync(path.join(source, "other.txt"), "concurrent PR");
    git(source, "add", ".");
    git(source, "commit", "-m", "another PR");
    git(source, "push", "origin", "main");
    const result = await execute();
    expect(result).toMatchObject({
      status: "succeeded",
      quality: { targetSha, verificationPassed: true },
    });
    expect(calls).toBe(0);
  });
  it("marks failed trusted validation as not passed even when the agent says pass", async () => {
    repository.validateCommand = 'node -e "process.exit(1)"';
    expect(await execute()).toMatchObject({
      status: "succeeded",
      quality: { verificationPassed: false },
    });
  });
  it("performs the final freshness verification without another model call", async () => {
    context().expectedSha = targetSha;
    context().verificationOnly = true;
    expect(await execute()).toMatchObject({
      status: "succeeded",
      quality: { targetSha, verificationPassed: true },
    });
    expect(calls).toBe(0);
  });

  it("requires a trusted validation command", async () => {
    repository.validateCommand = null;
    expect((await execute()).status).toBe("failed");
    expect(calls).toBe(0);
  });
  it("rejects tracked edits from the validation command", async () => {
    repository.validateCommand = "node -e \"require('fs').writeFileSync('feature.txt','edited')\"";
    expect((await execute()).failureReason).toContain("modified");
  });
});
