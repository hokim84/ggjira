import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  FCI_AXES,
  FCI_OUTPUT_SCHEMA,
  FciAssessmentSchema,
  type FciOutcome,
  type FciSnapshot,
  type FciTask,
  rawFci,
} from "../contracts/fci.js";
import { collectFciFacts, fciGit } from "../worker/fci-facts.js";
import type { WorkerProvider } from "../worker/provider.js";
import { createWorktree, removeWorktree } from "../worker/worktree.js";
import type { WorkerRepositoryConfig } from "./config.js";
class UnassessableFci extends Error {}

function patchId(cwd: string, before: string, after: string) {
  const diff = execFileSync("git", ["diff", "--binary", before, after], {
    cwd,
    maxBuffer: 32 * 1024 * 1024,
  });
  return (
    execFileSync("git", ["patch-id", "--stable"], { cwd, input: diff, encoding: "utf8" })
      .trim()
      .split(/\s/)[0] ?? ""
  );
}
export async function resolveFciMerge(
  cwd: string,
  task: Pick<FciTask, "mergeSha" | "prCommits" | "originalBaseSha" | "afterSha">,
): Promise<{ before: string; after: string; boundary: string }> {
  const merge = task.mergeSha;
  if (!merge) throw new Error("No actual merge SHA");
  const parents = (await fciGit(cwd, ["rev-list", "--parents", "-n", "1", merge]))
    .split(" ")
    .slice(1);
  if (parents.length === 2)
    return { before: parents[0] as string, after: merge, boundary: "merge-first-parent" };
  if (parents.length !== 1) throw new Error("Merge boundary cannot be proven");
  const base = await fciGit(cwd, [
    "merge-base",
    task.originalBaseSha ?? (parents[0] as string),
    task.afterSha,
  ]);
  const originalPatch = patchId(cwd, base, task.afterSha);
  const candidates = new Map<string, string>();
  if (patchId(cwd, parents[0] as string, merge) === originalPatch)
    candidates.set(parents[0] as string, "squash-or-single-commit");
  if (task.prCommits.length) {
    const range = (
      await fciGit(cwd, [
        "rev-list",
        "--first-parent",
        "--max-count",
        String(task.prCommits.length),
        merge,
      ])
    )
      .split(/\r?\n/)
      .reverse();
    const prior = await fciGit(cwd, ["rev-parse", `${range[0]}^`]);
    const original = task.prCommits.map((commit) => patchId(cwd, `${commit}^`, commit));
    const rebased = range.map((commit) => patchId(cwd, `${commit}^`, commit));
    if (
      range.length === original.length &&
      original.every((p, i) => p === rebased[i]) &&
      patchId(cwd, prior, merge) === originalPatch
    )
      candidates.set(prior, "verified-rebase-range");
  }
  if (candidates.size !== 1)
    throw new Error("Actual pre-merge boundary is ambiguous; cannot confirm ΔFCI");
  const [before, boundary] = [...candidates][0] as [string, string];
  return { before, after: merge, boundary };
}
function validEvidence(
  cwd: string,
  e: { path: string; line: number; endLine?: number | undefined },
) {
  if (path.isAbsolute(e.path) || e.path.split(/[\\/]/).includes("..")) return false;
  const p = path.resolve(cwd, e.path);
  if (!p.startsWith(`${path.resolve(cwd)}${path.sep}`)) return false;
  try {
    if (!lstatSync(p).isFile() || lstatSync(p).isSymbolicLink()) return false;
    const lines = readFileSync(p, "utf8").split(/\r?\n/).length;
    return e.line <= lines && (e.endLine ?? e.line) <= lines;
  } catch {
    return false;
  }
}
export async function executeFci(
  task: FciTask,
  deps: {
    repository: WorkerRepositoryConfig;
    provider: WorkerProvider;
    worktreesRoot: string;
    signal: AbortSignal;
    lookup: (sha: string) => Promise<FciSnapshot | null>;
    publish?: (snapshot: FciSnapshot) => Promise<unknown>;
  },
): Promise<FciOutcome> {
  const { repository, signal } = deps;
  const remote = repository.pushRemote ?? "origin";
  try {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote) ||
      !/^[A-Za-z0-9_./-]+$/.test(task.baseBranch) ||
      task.baseBranch.startsWith("-")
    )
      throw new Error("Invalid FCI ref");
    await fciGit(
      repository.path,
      ["fetch", "--no-tags", remote, `refs/heads/${task.baseBranch}`],
      signal,
    );
    const tip = await fciGit(repository.path, ["rev-parse", "FETCH_HEAD"], signal);
    for (const sha of new Set(
      [task.beforeSha, task.afterSha, task.baselineSha, task.mergeSha, ...task.prCommits].filter(
        Boolean,
      ) as string[],
    )) {
      try {
        await fciGit(repository.path, ["cat-file", "-e", `${sha}^{commit}`], signal);
      } catch {
        await fciGit(repository.path, ["fetch", "--no-tags", remote, sha], signal);
      }
    }
    let before = task.beforeSha;
    let after = task.afterSha;
    let boundary: string = task.purpose;
    if (task.purpose === "merge_final") {
      const resolved = await resolveFciMerge(repository.path, task).catch((error) => {
        throw new UnassessableFci(error instanceof Error ? error.message : String(error));
      });
      before = resolved.before;
      after = resolved.after;
      boundary = resolved.boundary;
      await fciGit(repository.path, ["merge-base", "--is-ancestor", after, tip], signal);
    } else if (task.purpose === "pr_preview") {
      const tree = (
        await fciGit(repository.path, ["merge-tree", "--write-tree", before, after], signal)
      ).split(/\r?\n/)[0] as string;
      after = execFileSync(
        "git",
        [
          "-c",
          "user.name=GGJIRA FCI",
          "-c",
          "user.email=fci@localhost",
          "commit-tree",
          tree,
          "-p",
          before,
          "-p",
          after,
          "-m",
          "FCI provisional merge",
        ],
        {
          cwd: repository.path,
          encoding: "utf8",
          env: {
            ...process.env,
            GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
            GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
          },
        },
      ).trim();
      boundary = "synthetic-merge-not-confirmed";
    }
    if (task.purpose !== "baseline")
      await fciGit(
        repository.path,
        ["merge-base", "--is-ancestor", task.baselineSha, after],
        signal,
      );
    const snapshots: FciSnapshot[] = [];
    for (const sha of new Set([before, after])) {
      const cached = await deps.lookup(sha);
      if (cached) {
        snapshots.push(cached);
        continue;
      }
      const wt = await createWorktree(
        repository.path,
        sha,
        `ggjira-fci/${task.id}-${task.attemptId}-${snapshots.length}`,
        deps.worktreesRoot,
      );
      try {
        const facts = await collectFciFacts(wt.path, sha, signal);
        const result = await deps.provider.run(
          {
            cwd: wt.path,
            readOnly: true,
            systemPrompt: task.systemPrompt,
            timeoutMs: task.timeoutMs,
            outputSchema: FCI_OUTPUT_SCHEMA,
            prompt: JSON.stringify({
              snapshotSha: sha,
              facts,
              validationEvidence: task.validationEvidence.filter((e) => e.sha === sha),
              tests: [
                {
                  status: "not_run",
                  explanation:
                    "FCI does not automatically rerun project tests; inspect static testability and report missing execution evidence.",
                },
              ],
            }),
          },
          { signal },
        );
        if (result.exitReason !== "completed" || result.isError) throw new Error(result.summary);
        if (result.model && result.model !== task.model)
          throw new Error(`Reported model ${result.model} differs from profile ${task.model}`);
        const assessment = FciAssessmentSchema.parse(
          result.structuredOutput ?? JSON.parse(result.summary),
        );
        for (const axis of FCI_AXES) {
          const a = assessment.axes[axis];
          if (
            a.grade !== null &&
            (!a.evidence.length || a.evidence.some((e) => !validEvidence(wt.path, e)))
          ) {
            a.grade = null;
            a.confidence = "low";
            a.uncertainties.push("Missing or invalid SHA-pinned file/line evidence");
          }
          if (facts.uncertainties.length && a.confidence === "high") a.confidence = "medium";
        }
        if (facts.history.commits < 2) {
          assessment.axes.history.grade = null;
          assessment.axes.history.confidence = "low";
          assessment.axes.history.uncertainties.push("Insufficient observed Git history");
        }
        assessment.priorities = assessment.priorities.filter(
          (p) => p.evidence.length && p.evidence.every((e) => validEvidence(wt.path, e)),
        );
        assessment.unverified.push(...facts.uncertainties);
        if (facts.history.commits < 10) assessment.axes.history.confidence = "low";
        if (
          (await fciGit(wt.path, ["status", "--porcelain", "--untracked-files=all"], signal)) ||
          (await fciGit(wt.path, ["rev-parse", "HEAD"], signal)) !== sha
        )
          throw new Error("Read-only FCI analysis modified its worktree");
        const snapshot: FciSnapshot = {
          sha,
          assessment,
          facts: {
            ...facts,
            providerMetadata: {
              providerType: task.providerType,
              providerVersion: "unreported",
              modelId: task.model,
              promptHash: createHash("sha256").update(task.systemPrompt).digest("hex"),
            },
          } as unknown as Record<string, unknown>,
          model: result.model ?? task.model,
          modelSource: result.model ? "reported" : "configured",
          providerVersion: "unreported",
          analyzedAt: new Date().toISOString(),
          tests: [
            {
              command: repository.validateCommand ?? "not configured",
              status: "not_run",
              evidence: "FCI analysis did not execute project tests; no pass/fail is inferred.",
            },
          ],
        };
        await deps.publish?.(snapshot);
        snapshots.push(snapshot);
      } finally {
        await removeWorktree(repository.path, wt.path);
      }
    }
    const targetOrder =
      task.purpose === "merge_final"
        ? Number(
            await fciGit(
              repository.path,
              ["rev-list", "--first-parent", "--count", `${task.baselineSha}..${after}`],
              signal,
            ),
          )
        : 0;
    const change = {
      validationEvidence: task.validationEvidence,
      targetOrder,
      paths: (await fciGit(repository.path, ["diff", "--name-status", before, after], signal))
        .split(/\r?\n/)
        .filter(Boolean),
      numstat: await fciGit(repository.path, ["diff", "--numstat", before, after], signal),
    };
    return {
      status: snapshots.every((s) => rawFci(s.assessment, task.weights) !== null)
        ? "succeeded"
        : "unassessable",
      beforeSha: before,
      afterSha: after,
      snapshots,
      boundary,
      change,
      ...(snapshots.some((s) => rawFci(s.assessment, task.weights) === null)
        ? { reason: "One or more axes lack evidence; aggregate FCI is unavailable." }
        : {}),
    };
  } catch (error) {
    return {
      status: error instanceof UnassessableFci ? "unassessable" : "failed",
      reason: error instanceof Error ? error.message : String(error),
      snapshots: [],
    };
  }
}
