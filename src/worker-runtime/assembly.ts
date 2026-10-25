import type { JobEnvelope } from "../contracts/envelope.js";
import { createPullRequest, retirePullRequest } from "../worker/github.js";
import {
  changedFilesSince,
  commitIsAncestor,
  createWorktree,
  githubRepoSlug,
  integrationTarget,
  mergeResultCommits,
  remoteBranchHead,
  remoteUrl,
  removeWorktree,
  pushResultHead,
  revParse,
  fetchResultCommit,
} from "../worker/worktree.js";
import type { ExecutionOutcome, ExecutorDeps } from "./executor.js";
import type { WorkerRepositoryConfig } from "./config.js";

/** Deterministic Git assembly; never runs an AI or the post-merge validation command. */
export async function executeAssembly(
  envelope: JobEnvelope,
  deps: ExecutorDeps,
  repo: WorkerRepositoryConfig,
): Promise<ExecutionOutcome> {
  let cwd: string | undefined;
  try {
    const context = envelope.assembly;
    if (!context || context.baseBranch !== repo.baseBranch || !repo.pushRemote)
      throw new Error("Aggregate PR needs a matching Git base and push remote");
    const remote = repo.pushRemote;
    const base = await integrationTarget(repo.path, remote, repo.baseBranch, []);
    const branch =
      context.previousBranch ??
      `ggjira/aggregate-${context.parentKey}-${context.cycleId.slice(0, 16)}`;
    const previous = await remoteBranchHead(repo.path, remote, branch);
    if (previous) await fetchResultCommit(repo.path, remote, previous);
    cwd = (
      await createWorktree(
        repo.path,
        previous ?? base,
        `ggjira-assemble/${envelope.attemptId}`,
        deps.worktreesRoot,
      )
    ).path;
    if (previous) await mergeResultCommits(cwd, remote, [base]);
    for (const child of context.children) {
      if (deps.signal.aborted || !(await deps.authorize("commit")))
        throw new Error("Aggregate authority withdrawn");
      if (child.integratedMergeSha) {
        if (!(await commitIsAncestor(cwd, child.integratedMergeSha, base)))
          throw new Error(`Previously merged child ${child.issueKey} left the target branch`);
      } else if (!child.noChange) await mergeResultCommits(cwd, remote, [child.headSha]);
    }
    const head = await revParse(cwd, "HEAD");
    const changes = await changedFilesSince(cwd, base);
    const summary = `부모 통합 결과: ${context.children.map((c) => c.issueKey).join(", ")}`;
    const evidence = {
      branch,
      git: {
        repository: "git" as const,
        baseBranch: repo.baseBranch,
        baseSha: base,
        headSha: head,
        committed: changes.length > 0,
      },
      changes,
    };
    if (!changes.length)
      return {
        status: "succeeded",
        summary: `${summary} · 대상 브랜치에 추가할 변경 없음`,
        ...evidence,
      };
    if (!repo.createPullRequest)
      throw new Error("Enable createPullRequest on the Worker to create the parent PR");
    if (deps.signal.aborted || !(await deps.authorize("push")))
      throw new Error("Aggregate authority withdrawn before push");
    if (previous && !(await commitIsAncestor(cwd, previous, head)))
      throw new Error("Aggregate update is not fast-forward");
    await pushResultHead(cwd, remote, branch);
    const url = await remoteUrl(repo.path, remote);
    const slug = url && githubRepoSlug(url);
    if (!slug) throw new Error("Aggregate PR requires a configured GitHub remote");
    if (!(await deps.authorize("push")))
      throw new Error("Aggregate authority withdrawn before PR creation");
    const pullRequest = await (deps.createPullRequest ?? createPullRequest)({
      cwd,
      repo: slug,
      base: repo.baseBranch,
      head: branch,
      title: `[${context.parentKey}] ${envelope.issueSnapshot.summary}`.slice(0, 200),
      body: [
        summary,
        "",
        ...context.children.map(
          (c) => `- ${c.issueKey}: result ${c.resultId}, commit ${c.headSha}`,
        ),
        "",
        "모든 자식 구현·자체 테스트가 완료되었습니다. 사람의 병합 후 부모 통합 검증과 선택적 FCI 분석을 수행합니다. Done은 수동입니다.",
        `<!-- ggjira aggregate=${context.cycleId} issue=${context.parentKey} -->`,
      ].join("\n"),
    });
    for (const prior of context.replacedPullRequests ?? []) {
      if (prior.repo.toLowerCase() !== slug.toLowerCase())
        throw new Error("Legacy PR repository differs from the aggregate repository");
      if (prior.number === pullRequest.number) continue;
      if (!(await deps.authorize("push")))
        throw new Error("Aggregate authority withdrawn before legacy PR retirement");
      await (deps.retirePullRequest ?? retirePullRequest)({
        cwd,
        repo: slug,
        number: prior.number,
        replacementUrl: pullRequest.url,
      });
    }
    return {
      status: "succeeded",
      summary,
      ...evidence,
      pullRequest,
      artifacts: [`pushed: ${remote}/${branch}`],
    };
  } catch (error) {
    return {
      status: deps.signal.aborted ? "cancelled" : "failed",
      summary:
        "부모 통합 PR 생성을 완료하지 못했습니다. 자식 구현을 다시 실행하지 말고 통합 단계만 재시도하세요.",
      failureReason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (cwd) await removeWorktree(repo.path, cwd).catch(() => undefined);
  }
}
