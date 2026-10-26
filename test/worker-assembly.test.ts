import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobEnvelope } from "../src/contracts/envelope.js";
import { PROTOCOL_VERSION } from "../src/contracts/protocol.js";
import { executeEnvelope, type ExecutorDeps } from "../src/worker-runtime/executor.js";
import { resolveWorkerConfig } from "../src/worker-runtime/config.js";
import * as worktree from "../src/worker/worktree.js";
import { fakeSuccessResult } from "../src/worker/fake.js";

describe("parent aggregate Git execution", () => {
  let root: string;
  let source: string;
  let base: string;
  let job: JobEnvelope;
  let deps: ExecutorDeps;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const child = (name: string, file: string, content = name) => {
    git(source, "checkout", "-B", name, base);
    writeFileSync(path.join(source, file), content);
    git(source, "add", ".");
    git(source, "commit", "-m", name);
    git(source, "push", "origin", name);
    return {
      issueKey: name,
      resultId: `result-${name}`,
      baseSha: base,
      headSha: git(source, "rev-parse", "HEAD"),
      branch: name,
      noChange: false,
      dependencies: [],
    };
  };
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "ggjira-aggregate-"));
    source = path.join(root, "source");
    mkdirSync(source);
    git(source, "init", "-b", "main");
    git(source, "config", "user.name", "test");
    git(source, "config", "user.email", "test@example.invalid");
    writeFileSync(path.join(source, "shared.txt"), "base\n");
    git(source, "add", ".");
    git(source, "commit", "-m", "base");
    base = git(source, "rev-parse", "HEAD");
    git(root, "clone", "--bare", source, "remote.git");
    git(source, "remote", "add", "origin", path.join(root, "remote.git"));
    git(root, "clone", path.join(root, "remote.git"), "worker");
    const config = resolveWorkerConfig(
      {
        configVersion: 6,
        routerUrl: "http://localhost:8787",
        repositories: [
          {
            id: "repo1",
            path: path.join(root, "worker"),
            baseBranch: "main",
            pushRemote: "origin",
            createPullRequest: true,
            validateCommand: 'node -e "process.exit(99)"',
          },
        ],
        providers: [{ id: "default", type: "codex" }],
      },
      path.join(root, "data"),
    );
    deps = {
      config,
      createProvider: () => {
        throw new Error("Aggregate must not initialize an AI provider");
      },
      signal: new AbortController().signal,
      authorize: async () => true,
      createPullRequest: vi.fn(async () => ({
        repo: "org/repo",
        number: 1,
        url: "https://github.com/org/repo/pull/1",
      })),
    };
    job = {
      protocolVersion: PROTOCOL_VERSION,
      jobId: "aggregate",
      attemptId: "first",
      leaseToken: "lease",
      workspaceId: "ws1",
      repositoryId: "repo1",
      providerId: "default",
      kind: "assemble_pr",
      approvalId: "aggregate:cycle",
      inputHash: "v2:cycle",
      systemPrompt: "No model",
      timeoutMs: 10000,
      issueSnapshot: {
        key: "KAN-1",
        id: "1",
        summary: "Feature",
        description: "Feature",
        statusName: "AI 구현",
        labels: [],
        assigneeAccountId: "owner",
        issueTypeName: "Task",
        parentKey: null,
        projectKey: "KAN",
      },
    };
    vi.spyOn(worktree, "githubRepoSlug").mockReturnValue("org/repo");
  }, 30000);
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });
  it("assembles two published children into one PR without changing the shared checkout or calling validation", async () => {
    job.assembly = {
      cycleId: "cycle",
      planVersion: "v1",
      parentKey: "KAN-1",
      baseBranch: "main",
      children: [child("KAN-2", "first.txt"), child("KAN-3", "second.txt")],
    };
    writeFileSync(path.join(root, "worker", "shared.txt"), "local edit");
    const result = await executeEnvelope(job, deps);
    expect(result.failureReason).toBeUndefined();
    expect(result.status).toBe("succeeded");
    expect(deps.createPullRequest).toHaveBeenCalledTimes(1);
    expect(git(path.join(root, "worker"), "rev-parse", "HEAD")).toBe(base);
    expect(readFileSync(path.join(root, "worker", "shared.txt"), "utf8")).toBe("local edit");
    expect(git(path.join(root, "remote.git"), "show", `${result.branch}:first.txt`)).toBe("KAN-2");
    expect(git(path.join(root, "remote.git"), "show", `${result.branch}:second.txt`)).toBe("KAN-3");
    expect(result.git?.headSha).not.toBe(base);
  }, 30000);
  it("reuses the remote aggregate head after losing the PR response", async () => {
    job.assembly = {
      cycleId: "stable",
      planVersion: "v1",
      parentKey: "KAN-1",
      baseBranch: "main",
      children: [child("KAN-2", "first.txt")],
    };
    deps.createPullRequest = vi
      .fn()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValue({
        repo: "org/repo",
        number: 1,
        url: "https://github.com/org/repo/pull/1",
      });
    expect((await executeEnvelope(job, deps)).status).toBe("failed");
    const before = git(
      path.join(root, "remote.git"),
      "rev-parse",
      "refs/heads/ggjira/aggregate-KAN-1-stable",
    );
    const result = await executeEnvelope({ ...job, attemptId: "retry" }, deps);
    expect(result.status).toBe("succeeded");
    expect(result.git?.headSha).toBe(before);
  }, 30000);
  it("reports conflicts without creating a PR or writing the target branch", async () => {
    job.assembly = {
      cycleId: "conflict",
      planVersion: "v1",
      parentKey: "KAN-1",
      baseBranch: "main",
      children: [child("KAN-2", "shared.txt", "one"), child("KAN-3", "shared.txt", "two")],
    };
    const result = await executeEnvelope(job, deps);
    expect(result.status).toBe("failed");
    expect(result.failureReason).toMatch(/CONFLICT|conflict/);
    expect(deps.createPullRequest).not.toHaveBeenCalled();
    expect(git(path.join(root, "remote.git"), "rev-parse", "main")).toBe(base);
  }, 30000);
  it("does not create empty PRs and refuses revoked publication", async () => {
    job.assembly = {
      cycleId: "empty",
      planVersion: "v1",
      parentKey: "KAN-1",
      baseBranch: "main",
      children: [
        {
          issueKey: "KAN-2",
          resultId: "none",
          baseSha: base,
          headSha: base,
          noChange: true,
          dependencies: [],
        },
      ],
    };
    expect(await executeEnvelope(job, deps)).toMatchObject({ status: "succeeded", changes: [] });
    expect(deps.createPullRequest).not.toHaveBeenCalled();
    job.assembly.children = [child("KAN-2", "first.txt")];
    deps.authorize = async () => false;
    expect((await executeEnvelope({ ...job, attemptId: "revoked" }, deps)).status).toBe("failed");
    expect(deps.createPullRequest).not.toHaveBeenCalled();
  }, 30000);
  it("publishes a verified child commit without opening a PR and consumes predecessor commits", async () => {
    const dependency = child("KAN-2", "dependency.txt");
    const repo = deps.config.repositories[0];
    if (!repo) throw new Error("missing repo");
    repo.validateCommand = 'node -e "process.exit(0)"';
    git(repo.path, "config", "user.name", "test");
    git(repo.path, "config", "user.email", "test@example.invalid");
    deps.createProvider = () => ({
      run: async (request) => {
        expect(readFileSync(path.join(request.cwd, "dependency.txt"), "utf8")).toBe("KAN-2");
        writeFileSync(path.join(request.cwd, "child.txt"), "child");
        return fakeSuccessResult();
      },
    });
    const result = await executeEnvelope(
      {
        ...job,
        kind: "implementation",
        deferPullRequest: true,
        integration: { baseBranch: "main", mergeCommits: [], resultCommits: [dependency.headSha] },
      },
      deps,
    );
    expect(result.failureReason).toBeUndefined();
    expect(result.status).toBe("succeeded");
    expect(result.artifacts).toContain(`pushed: origin/${result.branch}`);
    expect(result.pullRequest).toBeUndefined();
    expect(deps.createPullRequest).not.toHaveBeenCalled();
    expect(git(path.join(root, "remote.git"), "show", `${result.branch}:child.txt`)).toBe("child");
  }, 30000);
  it("updates the existing aggregate by fast-forward and retires legacy PRs only after replacement exists", async () => {
    const first = child("KAN-2", "first.txt");
    job.assembly = {
      cycleId: "first-cycle",
      planVersion: "v1",
      parentKey: "KAN-1",
      baseBranch: "main",
      children: [first],
    };
    const prior = await executeEnvelope(job, deps);
    expect(prior.status).toBe("succeeded");
    const second = child("KAN-3", "second.txt");
    deps.retirePullRequest = vi.fn(async (input) => {
      expect(deps.createPullRequest).toHaveBeenCalledTimes(2);
      expect(input.replacementUrl).toContain("/pull/1");
    });
    job.assembly = {
      ...job.assembly,
      cycleId: "second-cycle",
      previousBranch: prior.branch,
      children: [first, second],
      replacedPullRequests: [
        { repo: "org/repo", number: 2, url: "https://github.com/org/repo/pull/2" },
      ],
    };
    const result = await executeEnvelope({ ...job, attemptId: "second" }, deps);
    expect(result.status).toBe("succeeded");
    expect(result.branch).toBe(prior.branch);
    expect(deps.retirePullRequest).toHaveBeenCalledTimes(1);
    expect(
      git(
        path.join(root, "remote.git"),
        "merge-base",
        prior.git?.headSha as string,
        result.git?.headSha as string,
      ),
    ).toBe(prior.git?.headSha);
  }, 30000);
  it("recognizes previously merged legacy children without applying their old branch again", async () => {
    job.assembly = {
      cycleId: "legacy",
      planVersion: "v1",
      parentKey: "KAN-1",
      baseBranch: "main",
      children: [
        {
          issueKey: "KAN-2",
          resultId: "old",
          baseSha: base,
          headSha: "f".repeat(40),
          integratedMergeSha: base,
          noChange: false,
          dependencies: [],
        },
      ],
    };
    expect(await executeEnvelope(job, deps)).toMatchObject({ status: "succeeded", changes: [] });
    expect(deps.createPullRequest).not.toHaveBeenCalled();
  }, 30000);
});
