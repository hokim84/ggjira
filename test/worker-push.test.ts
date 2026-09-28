import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JobEnvelope } from "../src/contracts/envelope.js";
import { PROTOCOL_VERSION } from "../src/contracts/protocol.js";
import { WorkerConfigSchema } from "../src/worker-runtime/config.js";
import { executeEnvelope } from "../src/worker-runtime/executor.js";
import { fakeSuccessResult } from "../src/worker/fake.js";
import type { WorkerProvider, WorkerRequest } from "../src/worker/provider.js";
import { createPullRequest, pullRequestFromUrl } from "../src/worker/github.js";
import { githubCompareUrl, githubRepoSlug } from "../src/worker/worktree.js";

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

/** Writes a file in the job's working directory, like a real provider editing code. */
class WritingProvider implements WorkerProvider {
  async run(request: WorkerRequest) {
    writeFileSync(path.join(request.cwd, "result.txt"), "made by the worker\n");
    return fakeSuccessResult({ summary: "wrote result.txt" });
  }
}

function envelope(): JobEnvelope {
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
    inputHash: "hash",
    issueSnapshot: {
      key: "KAN-1",
      id: "1",
      summary: "Write a file",
      description: "Create result.txt",
      statusName: "작업 중",
      labels: [],
      assigneeAccountId: "user-1",
      issueTypeName: "Task",
      parentKey: null,
      projectKey: "KAN",
    },
    systemPrompt: "system",
    timeoutMs: 60_000,
  };
}

describe("pushing the job branch", () => {
  let dir: string;
  let remote: string;
  let clone: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ggjira-push-"));
    const seed = path.join(dir, "seed");
    mkdirSync(seed);
    git(["init"], seed);
    writeFileSync(path.join(seed, "README.md"), "hi\n");
    git(["add", "."], seed);
    git(["commit", "-m", "init"], seed);
    remote = path.join(dir, "remote.git");
    git(["clone", "--bare", seed, remote], dir);
    clone = path.join(dir, "ai-clone");
    git(["clone", remote, clone], dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function config(pushRemote?: string, createPullRequest = false) {
    return WorkerConfigSchema.parse({
      configVersion: 5,
      routerUrl: "http://127.0.0.1:8787",
      credentialPath: path.join(dir, "credential.json"),
      repositories: [
        { id: "repo1", path: clone, createPullRequest, ...(pushRemote ? { pushRemote } : {}) },
      ],
      providers: [{ id: "default", type: "claude-code" }],
      dataDir: path.join(dir, "data"),
      logPath: path.join(dir, "logs"),
    });
  }

  function run(pushRemote: string | undefined, authorize = async (_stage: string) => true) {
    const stages: string[] = [];
    const outcome = executeEnvelope(envelope(), {
      config: config(pushRemote),
      createProvider: () => new WritingProvider(),
      worktreesRoot: path.join(dir, "data", "worktrees"),
      signal: new AbortController().signal,
      authorize: async (stage) => {
        stages.push(stage);
        return authorize(stage);
      },
    });
    return { outcome, stages };
  }

  it("pushes the committed branch to the configured remote after asking Router", async () => {
    const { outcome, stages } = run("origin");
    const result = await outcome;
    expect(result.status).toBe("succeeded");
    expect(stages).toEqual(["commit", "push"]);
    expect(result.artifacts).toContain("pushed: origin/ggjira/KAN-1-attempt-");
    const branches = git(["branch", "--list"], remote);
    expect(branches).toContain("ggjira/KAN-1-attempt-");
    expect(git(["show", "ggjira/KAN-1-attempt-:result.txt"], remote)).toContain(
      "made by the worker",
    );
  });

  it("keeps the branch local when no push remote is configured", async () => {
    const { outcome, stages } = run(undefined);
    const result = await outcome;
    expect(stages).toEqual(["commit"]);
    expect(result.artifacts).toEqual(["branch: ggjira/KAN-1-attempt-"]);
    expect(git(["branch", "--list"], remote)).not.toContain("ggjira/");
  });

  it("reports a failed push without failing the job", async () => {
    const { outcome } = run("nosuchremote");
    const result = await outcome;
    expect(result.status).toBe("succeeded");
    expect(result.artifacts?.some((a) => a.startsWith("push failed (nosuchremote)"))).toBe(true);
  });

  it("stops before pushing when Router withdraws authority", async () => {
    const { outcome } = run("origin", async (stage) => stage !== "push");
    const result = await outcome;
    expect(result.status).toBe("cancelled");
    expect(git(["branch", "--list"], remote)).not.toContain("ggjira/");
  });

  it("opens a pull request on a GitHub remote and returns it with the result", async () => {
    // origin looks like GitHub for the PR, but pushes still go to the local bare repository.
    git(["remote", "set-url", "origin", "https://github.com/acme/app.git"], clone);
    git(["remote", "set-url", "--push", "origin", remote], clone);
    const calls: Array<Record<string, string>> = [];
    const result = await executeEnvelope(envelope(), {
      config: config("origin", true),
      createProvider: () => new WritingProvider(),
      worktreesRoot: path.join(dir, "data", "worktrees"),
      signal: new AbortController().signal,
      authorize: async () => true,
      createPullRequest: async (input) => {
        calls.push({ repo: input.repo, base: input.base, head: input.head, title: input.title });
        expect(input.body).toContain("<!-- ggjira issue=KAN-1 job=job-1");
        return { repo: input.repo, number: 7, url: "https://github.com/acme/app/pull/7" };
      },
    });
    expect(calls).toEqual([
      {
        repo: "acme/app",
        base: "main",
        head: "ggjira/KAN-1-attempt-",
        title: "[KAN-1] Write a file",
      },
    ]);
    expect(result.pullRequest).toEqual({
      repo: "acme/app",
      number: 7,
      url: "https://github.com/acme/app/pull/7",
    });
    expect(result.artifacts).toContain("pull request: https://github.com/acme/app/pull/7");
  });

  it("reports a failed pull request with a manual link, keeping the job succeeded", async () => {
    git(["remote", "set-url", "origin", "https://github.com/acme/app.git"], clone);
    git(["remote", "set-url", "--push", "origin", remote], clone);
    const result = await executeEnvelope(envelope(), {
      config: config("origin", true),
      createProvider: () => new WritingProvider(),
      worktreesRoot: path.join(dir, "data", "worktrees"),
      signal: new AbortController().signal,
      authorize: async () => true,
      createPullRequest: async () => {
        throw new Error("gh: not logged in");
      },
    });
    expect(result.status).toBe("succeeded");
    expect(result.pullRequest).toBeUndefined();
    expect(result.artifacts).toContain("pull request failed: gh: not logged in");
    expect(
      result.artifacts?.some((a) =>
        a.startsWith("open a pull request: https://github.com/acme/app/compare/"),
      ),
    ).toBe(true);
  });

  it("creates the PR through the gh CLI and falls back to an existing one", async () => {
    if (process.platform === "win32") return;
    const gh = path.join(dir, "fake-gh.sh");
    writeFileSync(
      gh,
      [
        "#!/bin/sh",
        'if [ "$2" = "create" ]; then',
        '  if [ -f "$0.exists" ]; then echo "a pull request already exists" >&2; exit 1; fi',
        '  echo "https://github.com/acme/app/pull/21"; touch "$0.exists"; exit 0',
        "fi",
        'echo \'{"number":21,"url":"https://github.com/acme/app/pull/21"}\'',
      ].join("\n"),
      { mode: 0o755 },
    );
    const input = {
      cwd: dir,
      repo: "acme/app",
      base: "main",
      head: "ggjira/KAN-1-x",
      title: "t",
      body: "b",
      ghCommand: gh,
    };
    expect(await createPullRequest(input)).toEqual({
      repo: "acme/app",
      number: 21,
      url: "https://github.com/acme/app/pull/21",
    });
    expect(await createPullRequest(input)).toEqual({
      repo: "acme/app",
      number: 21,
      url: "https://github.com/acme/app/pull/21",
    });
  });

  it("rejects a push remote that is not a plain remote name", () => {
    expect(() => config("--upload-pack=evil")).toThrow(/git remote name/);
  });
});

describe("GitHub URL helpers", () => {
  it("reads owner/repo and PR numbers", () => {
    expect(githubRepoSlug("https://github.com/hokim84/gg-repo.git")).toBe("hokim84/gg-repo");
    expect(githubRepoSlug("git@github.com:hokim84/gg-repo.git")).toBe("hokim84/gg-repo");
    expect(githubRepoSlug("/tmp/remote.git")).toBeUndefined();
    expect(pullRequestFromUrl("a/b", "https://github.com/a/b/pull/5")).toEqual({
      repo: "a/b",
      number: 5,
      url: "https://github.com/a/b/pull/5",
    });
  });
});

describe("githubCompareUrl", () => {
  it("builds a pull request link for GitHub remotes only", () => {
    expect(
      githubCompareUrl("https://github.com/hokim84/gg-repo.git", "main", "ggjira/KAN-1-ab"),
    ).toBe("https://github.com/hokim84/gg-repo/compare/main...ggjira/KAN-1-ab?expand=1");
    expect(githubCompareUrl("git@github.com:hokim84/gg-repo.git", "main", "b")).toBe(
      "https://github.com/hokim84/gg-repo/compare/main...b?expand=1",
    );
    expect(githubCompareUrl("https://gitlab.com/a/b.git", "main", "b")).toBeUndefined();
  });
});
