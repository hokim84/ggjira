import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FciConfigSchema, FciTaskSchema } from "../src/contracts/fci.js";
import { collectFciFacts } from "../src/worker/fci-facts.js";
import { scoreStructure, structuralFindings } from "../src/worker/fci-static.js";
import { executeFci } from "../src/worker-runtime/fci.js";
import { fakeSuccessResult } from "../src/worker/fake.js";
import { RouterHarness } from "./helpers/router-harness.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
describe("static FCI end to end", () => {
  let dir: string;
  let repo: string;
  let base: string;
  let router: RouterHarness;
  let seq = 0;
  const commit = (file: string, text: string) => {
    writeFileSync(path.join(repo, file), text);
    git(repo, "add", ".");
    git(repo, "commit", "-m", file);
    return git(repo, "rev-parse", "HEAD");
  };
  const body =
    "export function calculate(x:number) { let value=x; if(x>0) {value+=10;} else {value-=20;} for(let i=0;i<x;i++){ value+=i; if(value>100) value-=2; } return value; }";
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ggjira-static-"));
    repo = path.join(dir, "repo");
    mkdirSync(repo);
    git(repo, "init", "-b", "main");
    base = commit("app.ts", body);
    git(dir, "clone", "--bare", repo, "remote.git");
    git(repo, "remote", "add", "origin", path.join(dir, "remote.git"));
    router = new RouterHarness({
      config: {
        repositories: [
          {
            id: "repo1",
            baseBranch: "main",
            fci: FciConfigSchema.parse({ enabled: true, baselineSha: base }),
          },
        ],
      },
    });
    seq = 0;
  });
  afterEach(async () => {
    await router.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const next = () => router.service.fci.next("worker-1", "session", `request-${++seq}`, []);
  async function execute() {
    const task = next();
    if (!task) throw new Error("expected task");
    const outcome = await executeFci(task, {
      repository: {
        baseBranch: "main",
        validateCommand: null,
        createPullRequest: false,
        id: "repo1",
        path: repo,
        pushRemote: "origin",
      },
      worktreesRoot: path.join(dir, "worktrees"),
      signal: new AbortController().signal,
      lookup: async (sha) =>
        router.service.fci.lookup("worker-1", task.id, task.leaseToken, "session", sha),
      publish: async (snapshot) =>
        router.service.fci.publish("worker-1", task.id, task.leaseToken, "session", snapshot),
    });
    router.service.fci.finish("worker-1", task.id, task.leaseToken, `result-${seq}`, outcome);
    return { task, outcome };
  }
  it("runs without a model, backfills one step or all, caches and resumes after pause", async () => {
    const second = commit("README.md", "words");
    const third = commit("copy.ts", body);
    git(repo, "push", "origin", "main");
    expect((await execute()).task.purpose).toBe("history_scan");
    expect((await execute()).task.purpose).toBe("baseline");
    expect(next()).toBeNull();
    expect(router.service.fci.historyView("repo1").commits[0]?.fci).toBe(100);
    const detail = await router.adminCall("GET", `/repositories/repo1/fci/commits/${base}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().snapshot.sha).toBe(base);
    expect(detail.json().findings).toBeInstanceOf(Array);
    expect(
      (await router.adminCall("GET", "/repositories/repo1/fci/commits/not-a-sha")).statusCode,
    ).toBe(400);
    router.service.fci.historyControl("repo1", "next");
    const step = await execute();
    expect(step.task.afterSha).toBe(second);
    expect(step.outcome.status).toBe("succeeded");
    expect(next()).toBeNull();
    router.service.fci.historyControl("repo1", "all");
    router.service.fci.historyControl("repo1", "pause");
    expect(next()).toBeNull();
    router.service.fci.historyControl("repo1", "resume");
    expect((await execute()).task.afterSha).toBe(third);
    const view = router.service.fci.historyView("repo1");
    expect(view.completed).toBe(3);
    expect(view.commits[1]?.fci).toBe(100);
    expect(view.commits[2]?.fci).toBeGreaterThan(100);
    router.service.fci.historyControl("repo1", "all");
    expect(next()).toBeNull();
    expect(router.db.prepare("SELECT COUNT(*) n FROM fci_snapshots").get()).toEqual({ n: 3 });
  });
  it("automatically evaluates new target commits while older missing history remains paused", async () => {
    commit("README.md", "old gap");
    git(repo, "push", "origin", "main");
    await execute();
    await execute();
    const newest = commit("copy.ts", body);
    git(repo, "push", "origin", "main");
    router.clock.advance(61000);
    await execute();
    const result = await execute();
    expect(result.task.afterSha).toBe(newest);
    const view = router.service.fci.historyView("repo1");
    expect(view.commits[1]?.fci).toBeNull();
    expect(view.commits[2]?.fci).not.toBeNull();
  });
  it("does not infer successful tests, penalize wording, or score missing observations as zero", async () => {
    const initialFacts = await collectFciFacts(repo, base);
    const initial = scoreStructure(initialFacts);
    const wording = commit("README.md", "documentation");
    expect(scoreStructure(await collectFciFacts(repo, wording))).toEqual(initial);
    expect(structuralFindings(await collectFciFacts(repo, wording), initialFacts)).toEqual([]);
    const duplicate = commit("copy.ts", body);
    const duplicated = scoreStructure(await collectFciFacts(repo, duplicate));
    expect(duplicated.axes.duplication).toBeGreaterThan(initial.axes.duplication as number);
    git(repo, "rm", "copy.ts");
    mkdirSync(path.join(repo, "test"));
    const cleaned = commit("test/app.test.ts", body);
    expect(scoreStructure(await collectFciFacts(repo, cleaned)).axes.duplication).toBe(0);
    const unknown = commit("app.rs", "fn main() {}");
    const unsupported = scoreStructure(await collectFciFacts(repo, unknown));
    expect(unsupported.raw).toBeNull();
    expect(unsupported.confidence).toBe("low");
  });
  it("resolves C# type dependencies and emitted JS imports, counts nested functions separately", async () => {
    commit("other.ts", "export const other=1;");
    commit("use.ts", "import {other} from './other.js'; export const value=other;");
    commit("B.cs", "public class B { public int Value; }");
    commit("A.cs", "public class A { public B field; }");
    const sha = commit(
      "nested.ts",
      "export function outer(){const inner=()=>{if(true)return 1;return 0;};return inner();}",
    );
    const facts = await collectFciFacts(repo, sha);
    expect(facts.edges.some((e) => e.from === "use.ts" && e.to === "other.ts")).toBe(true);
    expect(facts.edges.some((e) => e.from === "A.cs" && e.to === "B.cs")).toBe(true);
    expect(facts.files.find((f) => f.path === "nested.ts")?.functions[0]?.cyclomatic).toBe(1);
  });
  it("persists pause across restart, supports explicit failed retry, and isolates explanation from scores", async () => {
    const head = commit("README.md", "next");
    git(repo, "push", "origin", "main");
    await execute();
    await execute();
    router.service.fci.historyControl("repo1", "all");
    router.service.fci.historyControl("repo1", "pause");
    await router.restart();
    expect(next()).toBeNull();
    router.service.fci.historyControl("repo1", "resume");
    const task = next();
    if (!task) throw new Error("missing commit");
    router.service.fci.finish("worker-1", task.id, task.leaseToken, "failed", {
      status: "failed",
      reason: "temporary IO",
      snapshots: [],
    });
    expect(router.service.fci.historyView("repo1").commits[1]?.fci).toBeNull();
    router.service.fci.historyControl("repo1", "pause");
    router.service.fci.retry(task.id);
    expect((await execute()).task.afterSha).toBe(head);
    router.service.fci.historyControl("repo1", "explain", head);
    router.service.fci.historyControl("repo1", "explain", head);
    expect(
      router.db.prepare("SELECT COUNT(*) n FROM fci_tasks WHERE purpose='explain'").get(),
    ).toEqual({ n: 1 });
    expect(next()).toBeNull(); // No provider is advertised, but all static work has completed.
    const explanation = router.service.fci.next("worker-1", "session", "explain-request", [
      { id: "default", type: "codex" },
    ]);
    expect(explanation?.purpose).toBe("explain");
    if (!explanation) throw new Error("missing explanation");
    router.service.fci.finish(
      "worker-1",
      explanation.id,
      explanation.leaseToken,
      "explain-failed",
      { status: "failed", reason: "provider offline", snapshots: [] },
    );
    expect(router.service.fci.historyView("repo1").commits[1]?.fci).toBe(100);
    expect(router.db.prepare("SELECT COUNT(*) n FROM jobs").get()).toEqual({ n: 0 });
  });
  it("resolves abbreviated baselines and does not fork static series for model or prompt changes", async () => {
    const cfg = router.config.repositories[0]?.fci;
    if (!cfg) throw new Error("config");
    cfg.baselineSha = base.slice(0, 9);
    await execute();
    await execute();
    const series = router.service.fci.historyView("repo1").series;
    expect(series?.baselineSha).toBe(base);
    cfg.modelId = "another-model";
    router.config.prompts.fci_analysis.additionalInstructions = "Explain carefully";
    expect(router.service.fci.historyView("repo1").series?.id).toBe(series?.id);
    cfg.enabled = false;
    expect(next()).toBeNull();
  });
  it("continues automatic tracking after target history rewrites and archives removed points", async () => {
    const oldHead = commit("README.md", "original target");
    git(repo, "push", "origin", "main");
    await execute();
    await execute();
    git(repo, "checkout", "-b", "replacement", base);
    const rewritten = commit("replacement.ts", "export const replacement=1;");
    git(repo, "push", "--force", "origin", "HEAD:main");
    router.clock.advance(61000);
    expect((await execute()).task.purpose).toBe("history_scan");
    expect((await execute()).task.afterSha).toBe(rewritten);
    const history = router.service.fci.historyView("repo1");
    expect(history.commits.map((c) => c.sha)).toEqual([base, rewritten]);
    expect(
      router.db.prepare("SELECT active FROM fci_history_commits WHERE sha=?").get(oldHead),
    ).toEqual({ active: 0 });
  });
  it("handles scoped C# names, path aliases and literal require dependencies", async () => {
    commit(
      "tsconfig.json",
      JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@app/*": ["*"] } } }),
    );
    commit("alias.ts", "import {calculate} from '@app/app'; export const c=calculate(1);");
    commit("require.js", "const app=require('./app'); module.exports=app;");
    commit("One.cs", "namespace First { public class Item {} }");
    commit("Two.cs", "namespace Second { public class Item {} }");
    const sha = commit(
      "Use.cs",
      "using First; namespace Consumer { public class Use { public Item field; } }",
    );
    const facts = await collectFciFacts(repo, sha);
    expect(facts.edges.some((e) => e.from === "Use.cs" && e.to === "One.cs")).toBe(true);
    expect(facts.edges.some((e) => e.from === "Use.cs" && e.to === "Two.cs")).toBe(false);
    expect(facts.edges.some((e) => e.from === "alias.ts" && e.to === "app.ts")).toBe(true);
    expect(facts.edges.some((e) => e.from === "require.js" && e.to === "app.ts")).toBe(true);
  });
  it("validates read-only AI explanation evidence and never changes static scores", async () => {
    await execute();
    await execute();
    router.service.fci.historyControl("repo1", "explain", base);
    const task = router.service.fci.next("worker-1", "session", "explanation", [
      { id: "default", type: "codex" },
    ]);
    if (!task) throw new Error("missing explanation");
    const run = async (line: number, id: string) =>
      executeFci(
        { ...task, id },
        {
          repository: {
            id: "repo1",
            path: repo,
            baseBranch: "main",
            validateCommand: null,
            createPullRequest: false,
          },
          worktreesRoot: path.join(dir, "worktrees"),
          signal: new AbortController().signal,
          lookup: async () => null,
          provider: {
            run: async (request) => {
              expect(request.readOnly).toBe(true);
              return fakeSuccessResult({
                model: "reported-model",
                structuredOutput: {
                  summary: "구조 설명",
                  evidence: [{ path: "app.ts", line, explanation: "조건 분기 확인" }],
                  priorities: ["경계 조건 테스트"],
                  uncertainties: ["테스트 미실행"],
                },
              });
            },
          },
        },
      );
    const good = await run(1, "good-explanation");
    expect(good.status).toBe("succeeded");
    expect(good.snapshots).toEqual([]);
    expect(good.change?.model).toBe("reported-model");
    const bad = await run(99999, "bad-explanation");
    expect(bad.status).toBe("failed");
    expect(bad.reason).toContain("invalid file/line");
    expect(router.service.fci.historyView("repo1").commits[0]?.fci).toBe(100);
  });
  it("rejects a baseline outside first-parent history without fabricating baseline 100", async () => {
    git(repo, "checkout", "-b", "side");
    const side = commit("side.ts", "export const side=1;");
    git(repo, "checkout", "main");
    git(repo, "merge", "--no-ff", "side", "-m", "merge");
    git(repo, "push", "origin", "main");
    const task = FciTaskSchema.parse({
      id: "scan",
      attemptId: "a",
      leaseToken: "t",
      repositoryId: "repo1",
      providerId: "none",
      model: "static",
      seriesId: "s",
      profileKey: "p",
      purpose: "history_scan",
      staticAnalysis: true,
      baseBranch: "main",
      baselineSha: side,
      beforeSha: side,
      afterSha: side,
      prRepo: null,
      prNumber: null,
      issueKey: null,
      systemPrompt: "",
      weights: {},
      timeoutMs: 30000,
      revision: 0,
      mergeSha: null,
      prCommits: [],
      originalBaseSha: null,
    });
    const result = await executeFci(task, {
      repository: {
        baseBranch: "main",
        validateCommand: null,
        createPullRequest: false,
        id: "repo1",
        path: repo,
      },
      worktreesRoot: path.join(dir, "worktrees"),
      signal: new AbortController().signal,
      lookup: async () => null,
    });
    expect(result.status).toBe("unassessable");
    expect(result.snapshots).toEqual([]);
  });
});
