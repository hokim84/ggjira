import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { JobEnvelope } from "../contracts/envelope.js";
import {
  QUALITY_REPORT_JSON_SCHEMA,
  type QualityReport,
  QualityReportSchema,
} from "../contracts/quality.js";
import type { UsageReading, WorkerProvider } from "../worker/provider.js";
import { runValidateCommand } from "../worker/validate.js";
import {
  createWorktree,
  hasUncommittedChanges,
  integrationTarget,
  isGitRepository,
  revParse,
  commitIsAncestor,
} from "../worker/worktree.js";
import type { WorkerRepositoryConfig } from "./config.js";
import type { ExecutionOutcome } from "./executor.js";
import type { ExecutionStage } from "./progress.js";

/** Code is inspected only in a disposable worktree at a fetched, immutable target. */
export async function executeQualityEnvelope(
  envelope: JobEnvelope,
  deps: {
    repository: WorkerRepositoryConfig;
    provider: WorkerProvider;
    worktreesRoot: string;
    logPath: string;
    signal: AbortSignal;
    onUsage?: (usage: UsageReading) => void;
    onProgress?: (stage: ExecutionStage) => void;
  },
): Promise<ExecutionOutcome> {
  try {
    const context = envelope.qualityContext;
    if (!context || !(await isGitRepository(deps.repository.path)))
      throw new Error("quality review requires a Git repository and a pinned context");
    const remote = deps.repository.pushRemote ?? "origin";
    deps.onProgress?.("checking_target");
    const branchTip = await integrationTarget(
      deps.repository.path,
      remote,
      context.integration.baseBranch,
      context.integration.mergeCommits,
    );
    const targetSha = context.expectedSha ?? branchTip;
    for (const merge of context.integration.mergeCommits) {
      if (!(await commitIsAncestor(deps.repository.path, merge, targetSha)))
        throw new Error("stale quality target precedes the recorded merge");
    }
    if (!(await commitIsAncestor(deps.repository.path, targetSha, branchTip)))
      throw new Error("pinned merge target is no longer on the target branch");
    const cwd = (
      await createWorktree(
        deps.repository.path,
        targetSha,
        `ggjira-quality/${envelope.issueSnapshot.key}-${envelope.attemptId}`,
        deps.worktreesRoot,
      )
    ).path;
    if (!deps.repository.validateCommand && envelope.kind === "integration_check")
      throw new Error("quality review needs a trusted repository.validateCommand");
    if (deps.signal.aborted) return { status: "cancelled", summary: "Quality review cancelled." };
    deps.onProgress?.("validating");
    const validation = deps.repository.validateCommand
      ? await runValidateCommand(deps.repository.validateCommand, cwd, {
          signal: deps.signal,
          timeoutMs: Math.min(deps.repository.validateTimeoutMs, envelope.timeoutMs),
        })
      : { ok: false, summary: "검증 명령이 설정되지 않았습니다. 리뷰 의견만 제공합니다." };
    const baselineSha = context.integration.mergeCommits[0]
      ? await revParse(cwd, `${context.integration.mergeCommits[0]}^`)
      : targetSha;
    const quality = QualityReportSchema.parse({
      targetSha,
      baselineSha,
      summary: "평가 대상 최신성 및 통합 검증 재확인",
      verificationPassed: validation.ok,
      verificationEvidence: [validation.summary],
      findings: [],
    });
    if (deps.signal.aborted) return { status: "cancelled", summary: "Quality review cancelled." };
    if ((await hasUncommittedChanges(cwd)) || (await revParse(cwd, "HEAD")) !== targetSha)
      throw new Error("read-only review modified the evaluation worktree");
    deps.onProgress?.("checking_target");
    const latestTip = await integrationTarget(
      deps.repository.path,
      remote,
      context.integration.baseBranch,
      context.integration.mergeCommits,
    );
    if (!(await commitIsAncestor(deps.repository.path, targetSha, latestTip)))
      throw new Error("pinned merge target left the target branch during validation");
    return {
      status: "succeeded",
      summary: quality.summary,
      quality,
      validation: [validation.summary],
    };
  } catch (error) {
    return {
      status: deps.signal.aborted ? "cancelled" : "failed",
      summary: "병합 후 통합 검증을 완료하지 못했습니다.",
      failureReason: error instanceof Error ? error.message : String(error),
    };
  }
}
