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
    const targetSha = await integrationTarget(
      deps.repository.path,
      remote,
      context.integration.baseBranch,
      context.integration.mergeCommits,
    );
    if (context.expectedSha && context.expectedSha !== targetSha)
      throw new Error("stale quality target; reply 재시도 to assess the latest commit");
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
          timeoutMs: envelope.timeoutMs,
        })
      : { ok: false, summary: "검증 명령이 설정되지 않았습니다. 리뷰 의견만 제공합니다." };
    const baselineSha = context.integration.mergeCommits[0]
      ? await revParse(cwd, `${context.integration.mergeCommits[0]}^`)
      : targetSha;
    let quality: QualityReport;
    if (envelope.kind === "integration_check" || context.verificationOnly) {
      quality = QualityReportSchema.parse({
        targetSha,
        baselineSha,
        summary: "평가 대상 최신성 및 통합 검증 재확인",
        verificationPassed: validation.ok,
        verificationEvidence: [validation.summary],
        findings: [],
      });
    } else {
      mkdirSync(deps.logPath, { recursive: true });
      const log = path.join(deps.logPath, `${envelope.jobId}-${envelope.attemptId}.jsonl`);
      deps.onProgress?.("agent");
      const result = await deps.provider.run(
        {
          cwd,
          readOnly: true,
          timeoutMs: envelope.timeoutMs,
          outputSchema: QUALITY_REPORT_JSON_SCHEMA,
          systemPrompt:
            "Review the integrated result read-only. Never edit, commit, push or merge. Report evidence and uncertainties. Do not use numerical debt scores. Distinguish defects, new debt, directly relevant existing debt, environment failures and missing evidence. Each finding needs a complete, independently executable remediation contract. Recheck previous findings and affected integration; do not recursively invent repository-wide cleanup.",
          prompt: JSON.stringify({
            ...context,
            targetSha,
            baselineSha,
            trustedValidation: validation,
          }),
        },
        {
          signal: deps.signal,
          onEvent: (line) => appendFileSync(log, `${line}\n`),
          ...(deps.onUsage ? { onUsage: deps.onUsage } : {}),
        },
      );
      if (result.isError || result.exitReason !== "completed") throw new Error(result.summary);
      const raw =
        result.structuredOutput ??
        JSON.parse(result.summary.match(/```json\s*([\s\S]*?)```/i)?.[1] ?? result.summary);
      quality = QualityReportSchema.parse(raw);
      if (quality.targetSha !== targetSha || quality.baselineSha !== baselineSha)
        throw new Error("review returned a different target");
      quality.verificationPassed &&= validation.ok;
      quality.verificationEvidence.unshift(validation.summary);
    }
    if (deps.signal.aborted) return { status: "cancelled", summary: "Quality review cancelled." };
    if ((await hasUncommittedChanges(cwd)) || (await revParse(cwd, "HEAD")) !== targetSha)
      throw new Error("read-only review modified the evaluation worktree");
    deps.onProgress?.("checking_target");
    if (
      (await integrationTarget(
        deps.repository.path,
        remote,
        context.integration.baseBranch,
        context.integration.mergeCommits,
      )) !== targetSha
    )
      throw new Error("stale quality target; reply 재시도 to assess the latest commit");
    return {
      status: "succeeded",
      summary: quality.summary,
      quality,
      validation: [validation.summary],
    };
  } catch (error) {
    return {
      status: deps.signal.aborted ? "cancelled" : "failed",
      summary: "통합 검증·기술부채 평가를 완료하지 못했습니다.",
      failureReason: error instanceof Error ? error.message : String(error),
    };
  }
}
