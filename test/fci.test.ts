import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FCI_AXES,
  type FciAssessment,
  FciAssessmentSchema,
  FciConfigSchema,
  type FciSnapshot,
  type FciTask,
  FciTaskSchema,
  FciWeightsSchema,
  normalizedFci,
  rawFci,
} from "../src/contracts/fci.js";
import { PROTOCOL_VERSION } from "../src/contracts/protocol.js";
import { createJob } from "../src/router/db/jobs.js";
import { recordPullRequest } from "../src/router/db/pull-requests.js";
import { FciService } from "../src/router/fci-service.js";
import { pollPullRequests } from "../src/router/github.js";
import { RouterClient } from "../src/worker-runtime/client.js";
import { WorkerConfigSchema } from "../src/worker-runtime/config.js";
import { executeFci, resolveFciMerge } from "../src/worker-runtime/fci.js";
import { WorkerRunner } from "../src/worker-runtime/runner.js";
import { ResultSpool } from "../src/worker-runtime/spool.js";
import { fakeSuccessResult } from "../src/worker/fake.js";
import { collectFciFacts } from "../src/worker/fci-facts.js";
import { buildFciSystemPrompt } from "../src/worker/fci-prompt.js";
import { RouterHarness } from "./helpers/router-harness.js";

const weights = FciWeightsSchema.parse({});
function assessment(grade: number | null = 1): FciAssessment {
  return FciAssessmentSchema.parse({
    summary: "Experimental structure evaluation",
    axes: Object.fromEntries(
      FCI_AXES.map((axis) => [
        axis,
        {
          grade,
          confidence: "low",
          explanation: "Observed boundaries and verification structure, not development effort",
          evidence: [{ path: "app.ts", line: 1, explanation: "Observed function" }],
          uncertainties: [],
        },
      ]),
    ),
    priorities: [],
    unverified: [],
  });
}
function snapshot(sha: string, grade: number | null = 1): FciSnapshot {
  return {
    sha,
    assessment: assessment(grade),
    model: "test-model",
    modelSource: "configured",
    providerVersion: "unreported",
    facts: {},
    analyzedAt: "2026-10-22T00:00:00Z",
    tests: [{ command: "none", status: "not_run", evidence: "Not executed" }],
  };
}
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

describe("FCI score contracts", () => {
  it("separates weighted raw scores from anchored indices and supports zero baseline", () => {
    expect(rawFci(assessment(2), weights)).toBe(50);
    expect(normalizedFci(50, 25)).toBe(125);
    expect(normalizedFci(0, 0)).toBe(100);
    expect(normalizedFci(25, 0)).toBe(125);
  });
  it("does not treat missing axes or baseline as zero", () => {
    const a = assessment();
    a.axes.history.grade = null;
    expect(rawFci(a, weights)).toBeNull();
    expect(normalizedFci(30, null)).toBeNull();
    expect(() => FciWeightsSchema.parse({ coupling: 1 })).toThrow();
  });
  it("is opt-in and requires an explicit baseline and model", () => {
    expect(FciConfigSchema.parse({}).enabled).toBe(false);
    expect(() => FciConfigSchema.parse({ enabled: true })).toThrow();
  });
});

describe("immutable repository facts and merge boundaries", () => {
  let dir: string;
  let repo: string;
  let remote: string;
  let base: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ggjira-fci-"));
    repo = path.join(dir, "repo");
    mkdirSync(repo);
    git(repo, "init", "-b", "main");
    writeFileSync(
      path.join(repo, "app.ts"),
      "export function a(x: number) { if (x > 1) return x; return 0; }\n",
    );
    git(repo, "add", ".");
    git(repo, "commit", "-m", "initial");
    writeFileSync(path.join(repo, "README.md"), "A tool\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "documentation");
    base = git(repo, "rev-parse", "HEAD");
    remote = path.join(dir, "remote.git");
    git(dir, "clone", "--bare", repo, remote);
    git(repo, "remote", "add", "origin", remote);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  function commit(file: string, text: string) {
    writeFileSync(path.join(repo, file), text);
    git(repo, "add", ".");
    git(repo, "commit", "-m", `change ${file}`);
    return git(repo, "rev-parse", "HEAD");
  }
  function task(overrides: Partial<FciTask> = {}): FciTask {
    return FciTaskSchema.parse({
      id: "fci-1",
      attemptId: "attempt-1",
      leaseToken: "token",
      repositoryId: "repo1",
      providerId: "default",
      model: "test-model",
      seriesId: "series",
      profileKey: "profile",
      purpose: "task_result",
      baseBranch: "main",
      baselineSha: base,
      beforeSha: base,
      afterSha: base,
      prRepo: null,
      prNumber: null,
      issueKey: null,
      systemPrompt: buildFciSystemPrompt(),
      weights,
      timeoutMs: 30000,
      revision: 0,
      mergeSha: null,
      prCommits: [],
      originalBaseSha: null,
      ...overrides,
    });
  }
  it("deterministically parses TS, JS, Python and C# plus Unity GUID and assembly references", async () => {
    mkdirSync(path.join(repo, "Assets"));
    writeFileSync(
      path.join(repo, "Assets", "A.cs"),
      "using UnityEngine; public class A : MonoBehaviour { public int F(int x) { if (x > 0) return x; return 0; } }\n",
    );
    writeFileSync(
      path.join(repo, "Assets", "A.cs.meta"),
      "guid: 11111111111111111111111111111111\n",
    );
    writeFileSync(
      path.join(repo, "Assets", "A.prefab"),
      "%YAML 1.1\nm_Script: {fileID: 11500000, guid: 11111111111111111111111111111111, type: 3}\n",
    );
    writeFileSync(
      path.join(repo, "Assets", "Runtime.asmdef"),
      JSON.stringify({ name: "Runtime", references: ["Shared"] }),
    );
    writeFileSync(
      path.join(repo, "Shared.asmdef"),
      JSON.stringify({ name: "Shared", references: [] }),
    );
    writeFileSync(
      path.join(repo, "a.py"),
      "def f(x):\n    if x:\n        return 1\n    return 0\n",
    );
    writeFileSync(path.join(repo, "a.js"), "export function f(x) { return x ? 1 : 0; }\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "mixed source");
    const sha = git(repo, "rev-parse", "HEAD");
    const facts = await collectFciFacts(repo, sha);
    expect(facts.files.map((f) => f.language).sort()).toEqual([
      "c_sharp",
      "javascript",
      "python",
      "typescript",
    ]);
    expect(facts.files.every((f) => f.parsed)).toBe(true);
    expect(facts.unity.serializedReferences[0]?.target).toBe("Assets/A.cs");
    expect(
      facts.edges.some((e) => e.from === "Assets/Runtime.asmdef" && e.to === "Shared.asmdef"),
    ).toBe(true);
    expect(await collectFciFacts(repo, sha)).toEqual(facts);
  });
  it("wording changes do not alter measured control flow and duplicated logic is observed without scores", async () => {
    const initial = await collectFciFacts(repo, base);
    const wording = commit("README.md", "A renamed tool\n");
    const after = await collectFciFacts(repo, wording);
    expect(after.files).toEqual(initial.files);
    const body =
      "export function repeated(x: number) { let value = x; if (x > 0) { value += 10; } else { value -= 20; } for (let i = 0; i < x; i++) { value += i; if (value > 100) value -= 2; } return value; }\n";
    commit("app.ts", body);
    const duplicate = commit("copy.ts", body);
    expect((await collectFciFacts(repo, duplicate)).duplicateBodies).toHaveLength(1);
    git(repo, "rm", "copy.ts");
    mkdirSync(path.join(repo, "tests"));
    writeFileSync(
      path.join(repo, "tests", "app.test.ts"),
      "import { repeated } from '../app'; repeated(1);\n",
    );
    git(repo, "add", ".");
    git(repo, "commit", "-m", "deduplicate and verify");
    const improved = await collectFciFacts(repo, git(repo, "rev-parse", "HEAD"));
    expect(improved.duplicateBodies).toHaveLength(0);
    expect(improved.tests.files).toContain("tests/app.test.ts");
  });
  it.each(["merge", "squash", "rebase"])(
    "finds actual before/after for %s, with a concurrent base change",
    async (method) => {
      git(repo, "checkout", "-b", "feature");
      const c1 = commit("feature.txt", "one\n");
      const c2 = commit("feature.txt", "two\n");
      git(repo, "checkout", "main");
      const actualBefore = commit("other.txt", "another PR\n");
      if (method === "merge") git(repo, "merge", "--no-ff", "feature", "-m", "merge feature");
      else if (method === "squash") {
        git(repo, "merge", "--squash", "feature");
        git(repo, "commit", "-m", "squash feature");
      } else {
        git(repo, "checkout", "feature");
        git(repo, "rebase", "main");
        git(repo, "checkout", "main");
        git(repo, "merge", "--ff-only", "feature");
      }
      const after = git(repo, "rev-parse", "HEAD");
      const resolved = await resolveFciMerge(
        repo,
        task({ mergeSha: after, afterSha: c2, prCommits: [c1, c2], originalBaseSha: base }),
      );
      expect(resolved.before).toBe(actualBefore);
      expect(resolved.after).toBe(after);
    },
  );
  it("does not guess a rebase boundary without PR commit evidence", async () => {
    git(repo, "checkout", "-b", "feature");
    commit("first.txt", "one\n");
    const head = commit("last.txt", "two\n");
    git(repo, "checkout", "main");
    git(repo, "merge", "--ff-only", "feature");
    await expect(
      resolveFciMerge(repo, task({ mergeSha: head, afterSha: head, originalBaseSha: base })),
    ).rejects.toThrow(/ambiguous/);
  });
  it("reuses a pinned snapshot without calling AI and preserves the shared checkout", async () => {
    let calls = 0;
    const result = await executeFci(task(), {
      repository: {
        id: "repo1",
        path: repo,
        baseBranch: "main",
        createPullRequest: false,
        validateCommand: null,
      },
      provider: {
        run: async () => {
          calls++;
          return fakeSuccessResult();
        },
      },
      worktreesRoot: path.join(dir, "wt"),
      signal: new AbortController().signal,
      lookup: async (sha) => snapshot(sha),
    });
    expect(result.status).toBe("succeeded");
    expect(calls).toBe(0);
    expect(git(repo, "rev-parse", "HEAD")).toBe(base);
  });
  it("runs the real idle Worker HTTP reserve → snapshot cache → result flow independently of Jira jobs", async () => {
    const router = new RouterHarness({
      config: {
        repositories: [
          {
            id: "repo1",
            baseBranch: "main",
            fci: FciConfigSchema.parse({
              enabled: true,
              ruleVersion: "fci-v1",
              baselineSha: base,
              modelId: "test-model",
            }),
          },
        ],
      },
    });
    try {
      const registered = await router.connectWorker("worker-1");
      const client = new RouterClient({
        routerUrl: "http://router.test",
        workerToken: registered.token,
        fetch: async (url, init) => {
          const response = await router.app.inject({
            method: init.method as "POST",
            url: new URL(url).pathname,
            headers: init.headers as Record<string, string>,
            payload: JSON.parse(init.body as string),
          });
          return new Response(response.statusCode === 204 ? null : response.body, {
            status: response.statusCode,
            headers: { "content-type": "application/json" },
          });
        },
      });
      const config = WorkerConfigSchema.parse({
        configVersion: 5,
        routerUrl: "http://localhost:8787",
        credentialPath: path.join(dir, "credential.json"),
        dataDir: path.join(dir, "worker"),
        logPath: path.join(dir, "logs"),
        repositories: [{ id: "repo1", path: repo, baseBranch: "main" }],
        providers: [{ id: "default", type: "codex", model: "test-model" }],
      });
      let calls = 0;
      const runner = new WorkerRunner({
        config,
        client,
        workerId: "worker-1",
        spool: new ResultSpool(path.join(dir, "spool")),
        createProvider: () => ({
          run: async (request) => {
            calls++;
            expect(request.readOnly).toBe(true);
            return fakeSuccessResult({ model: "test-model", structuredOutput: assessment() });
          },
        }),
        worktreesRoot: path.join(dir, "http-worktrees"),
      });
      await runner.connect();
      expect(await runner.pollOnce()).toBe("executed");
      const analysis = router.service.fci.view().analyses[0];
      expect(analysis?.status).toBe("succeeded");
      expect(analysis?.afterFci).toBe(100);
      expect(calls).toBe(1);
      expect(router.db.prepare("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({ n: 0 });
    } finally {
      await router.close();
    }
  });
  it("collects facts before AI judgment, validates evidence and never runs project tests", async () => {
    const result = await executeFci(task(), {
      repository: {
        id: "repo1",
        path: repo,
        baseBranch: "main",
        createPullRequest: false,
        validateCommand: "a command that must not run",
      },
      provider: {
        run: async (request) => {
          expect(request.readOnly).toBe(true);
          expect(JSON.parse(request.prompt).facts.analyzer).toContain("tree-sitter");
          const a = assessment();
          a.axes.coupling.evidence = [{ path: "../outside.ts", line: 1, explanation: "invalid" }];
          return fakeSuccessResult({ model: "test-model", structuredOutput: a });
        },
      },
      worktreesRoot: path.join(dir, "wt"),
      signal: new AbortController().signal,
      lookup: async () => null,
    });
    expect(result.status).toBe("unassessable");
    expect(result.snapshots[0]?.assessment.axes.coupling.grade).toBeNull();
    expect(result.snapshots[0]?.tests[0]?.status).toBe("not_run");
  });
});

describe("independent FCI queue, cache and reporting", () => {
  let router: RouterHarness;
  let service: FciService;
  const base = "1".repeat(40);
  const head = "2".repeat(40);
  const merge = "3".repeat(40);
  let sequence = 0;
  beforeEach(() => {
    router = new RouterHarness({
      config: {
        repositories: [
          {
            id: "repo1",
            baseBranch: "main",
            fci: FciConfigSchema.parse({
              enabled: true,
              ruleVersion: "fci-v1",
              baselineSha: base,
              modelId: "test-model",
            }),
          },
        ],
      },
    });
    service = router.service.fci;
    sequence = 0;
  });
  afterEach(async () => router.close());
  const next = () =>
    service.next("worker-1", "session", `request-${++sequence}`, [
      { id: "default", model: "test-model", type: "codex" },
    ]);
  function baseline() {
    const task = next();
    if (!task) throw new Error("missing baseline");
    service.finish("worker-1", task.id, task.leaseToken, "baseline-result", {
      status: "succeeded",
      beforeSha: base,
      afterSha: base,
      snapshots: [snapshot(base)],
    });
    return task;
  }
  function pr(state = "open", n = 1, h = head, b = base, m: string | null = null) {
    const id = `job-${n}`;
    if (!router.db.prepare("SELECT 1 FROM jobs WHERE id=?").get(id))
      createJob(router.db, {
        id,
        issueKey: `KAN-${n}`,
        workspaceId: "ws1",
        repositoryId: "repo1",
        kind: "implementation",
        approvalId: "approved",
        state: "succeeded",
        now: router.clock.now(),
      });
    recordPullRequest(router.db, {
      repo: "org/repo",
      number: n,
      url: `https://github.com/org/repo/pull/${n}`,
      issueKey: `KAN-${n}`,
      jobId: id,
      attemptId: `attempt-${n}`,
      now: router.clock.now(),
    });
    router.jira.seedIssue({ key: `KAN-${n}` });
    router.db
      .prepare("INSERT OR REPLACE INTO fci_pr_observations VALUES (?,?,?,?,?,?,?,?,?)")
      .run("org/repo", n, h, b, "main", m, state, JSON.stringify([h]), router.clock.now());
    service.sync();
  }
  it("deduplicates registration and reservations and rejects a conflicting result replay", () => {
    service.sync();
    service.sync();
    expect(service.view().analyses).toHaveLength(1);
    const task = next();
    if (!task) throw new Error("missing");
    expect(
      service.next("worker-1", "session", task.attemptId, [{ id: "default", model: "test-model" }]),
    ).toEqual(task);
    const outcome = { status: "succeeded" as const, snapshots: [snapshot(base)] };
    service.finish("worker-1", task.id, task.leaseToken, "result", outcome);
    expect(service.finish("worker-1", task.id, task.leaseToken, "result", outcome)).toEqual({
      accepted: true,
    });
    expect(() =>
      service.finish("worker-1", task.id, task.leaseToken, "result", {
        ...outcome,
        reason: "different",
      }),
    ).toThrow(/conflicting/);
  });
  it("anchors baseline at 100, caches by SHA and stores a raw score separately", () => {
    const task = baseline();
    const d = service.detail(task.id);
    expect(d.rawAfter).toBe(25);
    expect(d.afterFci).toBe(100);
    expect(service.snapshot(task.seriesId, base)).not.toBeNull();
  });
  it("never queues implementation-result analysis, even for a successful published child", () => {
    baseline();
    createJob(router.db, {
      id: "child-result",
      issueKey: "KAN-2",
      workspaceId: "ws1",
      repositoryId: "repo1",
      kind: "implementation",
      approvalId: "approved",
      state: "succeeded",
      now: router.clock.now(),
    });
    router.db
      .prepare(
        "INSERT INTO results (id,job_id,attempt_id,payload,received_at,applied) VALUES (?,?,?,?,?,1)",
      )
      .run(
        "child-result-id",
        "child-result",
        "child-attempt",
        JSON.stringify({ status: "succeeded", git: { baseSha: base, headSha: head } }),
        router.clock.now(),
      );
    service.sync();
    expect(next()).toBeNull();
    expect(service.view().analyses.map((a) => a.purpose)).toEqual(["baseline"]);
  });
  it("invalidates previews for head and target changes, excludes closed PRs from confirmed history", () => {
    baseline();
    pr();
    pr("open", 1, "4".repeat(40));
    pr("open", 1, "4".repeat(40), "5".repeat(40));
    const previews = service.view().analyses.filter((a) => a.purpose === "pr_preview");
    expect(previews).toHaveLength(0);
    expect(next()).toBeNull();
    pr("closed", 1, "4".repeat(40), "5".repeat(40));
    expect(service.view().analyses.filter((a) => a.purpose === "merge_final")).toHaveLength(0);
    expect(
      service.view().analyses.filter((a) => a.purpose === "pr_preview" && !a.superseded),
    ).toHaveLength(0);
  });
  it("records a confirmed actual-state delta, not a sum of PR risk scores", () => {
    baseline();
    pr("merged", 1, head, base, merge);
    const t = next();
    if (!t) throw new Error("missing final");
    service.finish("worker-1", t.id, t.leaseToken, "merge-result", {
      status: "succeeded",
      beforeSha: base,
      afterSha: merge,
      snapshots: [snapshot(base), snapshot(merge, 2)],
      boundary: "squash",
      change: { targetOrder: 1 },
    });
    const d = service.detail(t.id);
    expect(d.afterFci).toBe(125);
    expect(d.delta).toBe(25);
  });
  it("separates analysis retry, explicit revisions and failed Jira reporting without re-running code", async () => {
    baseline();
    pr("merged", 1, head, base, merge);
    let t = next();
    if (!t) throw new Error("missing preview");
    service.finish("worker-1", t.id, t.leaseToken, "failed", {
      status: "failed",
      reason: "AI unavailable",
      snapshots: [],
    });
    await service.report(router.jira);
    expect(router.jira.comments).toHaveLength(1);
    service.retry(t.id);
    t = next();
    if (!t) throw new Error("missing retry");
    service.finish("worker-1", t.id, t.leaseToken, "successful", {
      status: "succeeded",
      beforeSha: base,
      afterSha: head,
      snapshots: [snapshot(base), snapshot(head, 2)],
    });
    await service.report(router.jira);
    await service.report(router.jira);
    expect(await router.jira.getComments("KAN-1")).toHaveLength(1);
    expect((await router.jira.getComments("KAN-1"))[0]?.body).toContain("125.00");
    service.retryReport(t.id);
    await service.report(router.jira);
    expect(await router.jira.getComments("KAN-1")).toHaveLength(1);
    service.retry(t.id, true);
    expect(service.view().analyses.some((a) => a.supersedes === t?.id && a.revision !== 0)).toBe(
      true,
    );
    expect(router.db.prepare("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({ n: 1 });
  });
  it("retains failed reporting for its own retry and marks missing axes as unavailable", async () => {
    baseline();
    pr("merged", 1, head, base, merge);
    const t = next();
    if (!t) throw new Error("missing");
    service.finish("worker-1", t.id, t.leaseToken, "partial", {
      status: "unassessable",
      beforeSha: base,
      afterSha: head,
      snapshots: [snapshot(base), snapshot(head, null)],
    });
    const add = router.jira.addComment.bind(router.jira);
    router.jira.addComment = async () => {
      throw new Error("offline");
    };
    await service.report(router.jira);
    expect(service.detail(t.id).report).toMatchObject({ status: "failed" });
    expect(service.detail(t.id).afterFci).toBeNull();
    router.jira.addComment = add;
    service.retryReport(t.id);
    await service.report(router.jira);
    expect(service.detail(t.id).report).toMatchObject({ status: "applied" });
  });
  it("forks series on rule, prompt, model or weight changes", () => {
    baseline();
    for (const change of ["rule", "prompt", "model", "weights"]) {
      const config = structuredClone(router.config);
      const cfg = config.repositories[0]?.fci;
      if (!cfg) throw new Error("missing config");
      if (change === "rule") cfg.ruleVersion = "next";
      if (change === "prompt")
        config.prompts.fci_analysis.additionalInstructions = "Explain evidence";
      if (change === "model") cfg.modelId = "different";
      if (change === "weights") cfg.weights = { ...weights, coupling: 0.3, history: 0.05 };
      new FciService(router.db, config, router.clock.now).sync();
    }
    expect(service.view().series).toHaveLength(5);
  });
  it("keeps FCI disabled with no queue, new AI calls, or workflow jobs", () => {
    const config = structuredClone(router.config);
    config.repositories = config.repositories.map((r) => ({
      ...r,
      fci: FciConfigSchema.parse({ enabled: false }),
    }));
    const disabled = new FciService(router.db, config, router.clock.now);
    disabled.sync();
    expect(disabled.view().analyses).toHaveLength(0);
    expect(
      disabled.next("worker-1", "session", "none", [{ id: "default", model: "test-model" }]),
    ).toBeNull();
    expect(router.db.prepare("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({ n: 0 });
  });
  it("uses existing auth and refuses unknown model metadata", async () => {
    expect(
      (
        await router.app.inject({
          method: "POST",
          url: "/api/v1/fci/next",
          payload: { protocolVersion: PROTOCOL_VERSION },
        })
      ).statusCode,
    ).toBe(401);
    expect(service.next("worker-1", "session", "no-model", [{ id: "default" }])).toBeNull();
  });
  it("coalesces concurrent snapshot claims and releases them as soon as evidence is published", () => {
    const first = next();
    if (!first) throw new Error("baseline missing");
    expect(service.lookup("worker-1", first.id, first.leaseToken, "session", base)).toBeNull();
    pr("merged", 1, head, base, merge);
    const second = service.next("worker-2", "session-2", "parallel", [
      { id: "default", model: "test-model", type: "codex" },
    ]);
    if (!second) throw new Error("parallel task missing");
    expect(() =>
      service.lookup("worker-2", second.id, second.leaseToken, "session-2", base),
    ).toThrow(/Identical snapshot/);
    service.publish("worker-1", first.id, first.leaseToken, "session", snapshot(base));
    expect(service.lookup("worker-2", second.id, second.leaseToken, "session-2", base)?.sha).toBe(
      base,
    );
  });
  it("retains late results as attempt evidence and cannot promote an expired analysis", () => {
    const first = next();
    if (!first) throw new Error("missing");
    router.clock.advance(60000);
    service.sync();
    expect(
      service.finish("worker-1", first.id, first.leaseToken, "late", {
        status: "succeeded",
        snapshots: [snapshot(base)],
      }),
    ).toEqual({ accepted: true });
    expect(service.detail(first.id).status).toBe("failed");
    expect(service.snapshot(first.seriesId, base)).toBeNull();
    service.retry(first.id);
    expect(next()?.id).toBe(first.id);
  });
  it("observes PR additions through existing polling and isolates FCI metadata failures", async () => {
    pr();
    const response = (url: string) =>
      url.includes("/commits?")
        ? new Response("no access", { status: 403 })
        : new Response(
            JSON.stringify({
              state: "closed",
              merged: true,
              merged_at: "now",
              head: { sha: head },
              base: { sha: base, ref: "main" },
              merge_commit_sha: merge,
            }),
            { status: 200 },
          );
    const report = await pollPullRequests({
      db: router.db,
      config: router.config,
      fetch: async (url) => response(url),
      now: router.clock.now,
    });
    expect(report.errors).toHaveLength(0);
    expect(router.db.prepare("SELECT state FROM pull_requests").get()).toEqual({ state: "merged" });
  });
});
