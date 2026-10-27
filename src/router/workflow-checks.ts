import { createHash } from "node:crypto";
import { assemblyContext, latestAssembly } from "./assembly.js";
import type { RouterDatabase } from "./db/connection.js";
import type { JobResult } from "../contracts/envelope.js";
import type { QualityContext } from "../contracts/quality.js";
import type { JiraGateway } from "../jira/gateway.js";
import type { JiraIssue } from "../jira/types.js";
import { planningRequirements } from "../pm/contract.js";
import { readPlanTaskMetadata } from "../pm/metadata.js";
import { requirementDescription } from "../pm/plan-render.js";
import { computeInputHash } from "./approval.js";
import type { RouterConfig, WorkspaceConfig } from "./config.js";
import { getActivePlanDeployment, getPlanReview, getReviewedPlan } from "./db/plan-delegation.js";
import { resolveAttention } from "./db/attention.js";
import { appendAudit } from "./db/audit.js";
import {
  appendReviewRecord,
  judgmentRecordAction,
  latestJudgment,
  listReviewTargets,
} from "./db/review-targets.js";
import type { ApprovalSnapshot } from "./issue-check.js";
import { integrationEvidence } from "./lifecycle.js";
import { latestPlanningRequest, planningFingerprint } from "./planning-requests.js";

export function latestImplementation(
  db: RouterDatabase,
  key: string,
): { id: string; payload: string; input_hash: string; approval_id: string } | undefined {
  return db
    .prepare(`SELECT r.id,r.payload,j.input_hash,j.approval_id FROM jobs j JOIN results r ON r.job_id=j.id
    WHERE j.issue_key=? AND j.kind='implementation' AND j.state='succeeded' AND r.applied=1
    AND j.rowid=(SELECT MAX(rowid) FROM jobs WHERE issue_key=? AND kind='implementation')
    ORDER BY r.rowid DESC LIMIT 1`)
    .get(key, key) as ReturnType<typeof latestImplementation>;
}

/** No PR is needed only when the worker explicitly reported zero changed paths and evidence. */
export function verifiedNoChange(result: JobResult): boolean {
  return (
    result.status === "succeeded" &&
    result.git?.committed !== true &&
    Boolean(
      result.implementation?.noChangeReason ||
        (result.git?.repository === "git" && !result.git.committed),
    ) &&
    !result.pullRequest &&
    result.scopeCheck?.changedPaths.length === 0 &&
    Boolean(result.implementation?.verification.length) &&
    result.implementation?.verification.every(
      (check) => check.status === "pass" && check.evidence.trim().length > 0,
    ) === true
  );
}

export function sourceKey(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function verifiedImplementation(result: JobResult): boolean {
  return (
    result.status === "succeeded" &&
    result.implementation?.outcome === "completed" &&
    !!result.implementation.verification.length &&
    result.implementation.verification.every((v) => v.status === "pass" && !!v.evidence.trim()) &&
    !result.implementation.scopeDeviations?.length &&
    result.scopeCheck?.outsideAllowed.length === 0
  );
}

/**
 * ADR 0061: a pushed result whose only gap is acceptance criteria the agent said it could not
 * verify. It waits for a person to check them; a failed check is never in this state.
 */
export function awaitingHumanCheck(result: JobResult): boolean {
  const verification = result.implementation?.verification ?? [];
  return (
    result.status === "succeeded" &&
    result.implementation?.outcome === "completed" &&
    verification.some((v) => v.status === "not_verified") &&
    verification.every(
      (v) => v.status === "not_verified" || (v.status === "pass" && !!v.evidence.trim()),
    ) &&
    !result.implementation.scopeDeviations?.length &&
    result.scopeCheck?.outsideAllowed.length === 0 &&
    !!result.git?.headSha &&
    !!result.artifacts?.some((a) => a.startsWith("pushed:"))
  );
}

/** Whether a person confirmed this exact result on the review screen: the issue's current review
 *  target is the result's attempt and its latest judgment is a confirm. */
export function humanConfirmedResult(
  db: RouterDatabase,
  issueKey: string,
  resultId: string,
): boolean {
  const row = db.prepare("SELECT attempt_id FROM results WHERE id=?").get(resultId) as
    | { attempt_id: string }
    | undefined;
  const current = listReviewTargets(db, issueKey)[0];
  return (
    !!row &&
    current?.attemptId === row.attempt_id &&
    current.supersededBy === null &&
    latestJudgment(db, current.id)?.action === judgmentRecordAction("confirm")
  );
}

/**
 * A child result that counts as done (ADR 0061): verified by its own checks, or waiting for a
 * human check and moved by a person to `implementationCompleteStatus` or Done. Router never moves
 * a waiting child itself except for a review-screen confirm, so that status is the person's answer.
 * The first time Router sees such a move it records it as a confirm.
 */
export function acceptedImplementation(
  db: RouterDatabase,
  workspace: WorkspaceConfig,
  issue: { key: string; statusName: string },
  resultId: string,
  result: JobResult,
): boolean {
  if (verifiedImplementation(result)) return true;
  const { implementationCompleteStatus, doneStatus } = workspace.workflow;
  if (!awaitingHumanCheck(result)) return false;
  if (issue.statusName !== implementationCompleteStatus && issue.statusName !== doneStatus)
    return false;
  recordStatusConfirmation(db, issue.key, resultId, issue.statusName);
  return true;
}

/** Records a person's status move as the confirm of the result it accepted (ADR 0061), once. Jira's
 *  own issue history says who moved it. */
function recordStatusConfirmation(
  db: RouterDatabase,
  issueKey: string,
  resultId: string,
  statusName: string,
): void {
  if (humanConfirmedResult(db, issueKey, resultId)) return;
  const row = db.prepare("SELECT attempt_id FROM results WHERE id=?").get(resultId) as
    | { attempt_id: string }
    | undefined;
  const target = listReviewTargets(db, issueKey)[0];
  if (!row || target?.attemptId !== row.attempt_id || target.supersededBy !== null) return;
  const at = new Date().toISOString();
  db.transaction(() => {
    appendReviewRecord(db, {
      targetId: target.id,
      issueKey,
      action: judgmentRecordAction("confirm"),
      actor: "jira",
      authentication: "jira-status",
      headSha: target.headSha,
      outcome: "matched",
      detail: { attemptId: target.attemptId, commitState: target.commitState, status: statusName },
      at,
    });
    resolveAttention(db, {
      issueKey,
      kinds: ["review_required"],
      resolution: `moved to "${statusName}" in Jira`,
      now: at,
    });
    appendAudit(db, {
      at,
      actor: "jira",
      action: "review.judgment.confirm",
      subject: issueKey,
      detail: {
        targetId: target.id,
        attemptId: target.attemptId,
        via: "status",
        status: statusName,
      },
    });
  })();
}

export async function checkContext(
  db: RouterDatabase,
  jira: JiraGateway,
  config: Pick<RouterConfig, "repositories">,
  workspace: WorkspaceConfig,
  issue: JiraIssue,
  reviewOnly: boolean,
): Promise<QualityContext | undefined> {
  const baseBranch =
    config.repositories.find((repo) => repo.id === workspace.repositoryId)?.baseBranch ?? "main";
  const deployment = getActivePlanDeployment(db, issue.key);
  const review = deployment && getPlanReview(db, deployment.planReviewId);
  const plan = review && getReviewedPlan(db, review.id);
  const own = latestImplementation(db, issue.key);
  const aggregate = latestAssembly(db, issue.key);
  const ownNewer =
    own &&
    aggregate &&
    db
      .prepare(
        "SELECT 1 FROM jobs WHERE id=(SELECT job_id FROM results WHERE id=?) AND rowid>(SELECT rowid FROM jobs WHERE id=?)",
      )
      .get(own.id, aggregate.id);
  if (deployment?.taskIds.length && !ownNewer) {
    const current = await assemblyContext(db, jira, workspace, issue, baseBranch);
    if (!current || !aggregate || JSON.parse(aggregate.context).cycleId !== current.cycleId) return;
    const result = JSON.parse(aggregate.payload) as JobResult;
    const integrated = integrationEvidence(db, issue.key, baseBranch);
    const unchanged =
      current.children.every((c) => c.noChange || c.integratedMergeSha) && !result.pullRequest;
    if (!unchanged && (!integrated || integrated.resultId !== aggregate.resultId)) return;
    const expectedSha = unchanged ? result.git?.headSha : integrated?.mergeSha;
    if (!expectedSha) return;
    return {
      cycleId: sourceKey([current.cycleId, aggregate.resultId, expectedSha]),
      policyVersion: 1,
      planVersion: deployment.planVersion,
      objective: `${issue.summary}\n${requirementDescription(issue.description)}`,
      acceptance: plan?.acceptanceCriteria?.length ? plan.acceptanceCriteria : [issue.summary],
      verification: plan?.verification.length
        ? plan.verification
        : ["Verify the integrated parent result."],
      integration: { baseBranch, mergeCommits: unchanged ? [] : [expectedSha] },
      expectedSha,
      resultIds: [aggregate.resultId, ...current.children.map((c) => c.resultId)],
      previousFindings: [],
      verificationOnly: true,
    };
  }
  if (deployment && !own) {
    const request = latestPlanningRequest(db, issue.key);
    if (
      request?.id !== review?.requestApprovalId ||
      request?.input_hash !== planningFingerprint(issue)
    )
      return undefined;
  }
  if (own) {
    const snapshot = db
      .prepare(
        "SELECT i.snapshot FROM job_inputs i JOIN results r ON r.job_id=i.job_id WHERE r.id=?",
      )
      .get(own.id) as { snapshot: string } | undefined;
    if (snapshot) {
      const input = JSON.parse(snapshot.snapshot) as ApprovalSnapshot;
      if (
        computeInputHash({
          kind: "implementation",
          issue,
          requirements: input.requirements,
          planTask: input.planTask,
        }) !== own.input_hash
      )
        return undefined;
    }
  }
  const results: string[] = [];
  const merges: string[] = [];
  if (deployment?.taskIds.length && !own) {
    const children = await jira.searchIssues(`parent = "${issue.key}"`, { all: true });
    const tracked = [];
    let managed = 0;
    for (const child of children) {
      if (child.labels.includes("ggjira-superseded")) continue;
      const task = await readPlanTaskMetadata(jira, child.key);
      if (
        task &&
        task.planVersion === deployment.planVersion &&
        deployment.taskIds.includes(task.taskId)
      ) {
        tracked.push(child);
        managed++;
      } else if (!task) tracked.push(child);
    }
    if (managed !== deployment.taskIds.length) return undefined;
    for (const child of tracked) {
      if (
        ![
          workspace.workflow.implementationCompleteStatus,
          workspace.workflow.implementationCompleteStatus,
          workspace.workflow.doneStatus,
        ].includes(child.statusName)
      )
        return undefined;
      const latest = latestImplementation(db, child.key);
      if (!latest) return undefined;
      const frozen = db
        .prepare(
          "SELECT snapshot FROM job_inputs WHERE job_id=(SELECT job_id FROM results WHERE id=?)",
        )
        .get(latest.id) as { snapshot: string } | undefined;
      if (frozen) {
        const input = JSON.parse(frozen.snapshot) as ApprovalSnapshot;
        if (
          computeInputHash({
            kind: "implementation",
            issue: child,
            requirements: input.requirements,
            planTask: input.planTask,
          }) !== latest.input_hash
        )
          return undefined;
      }
      const result = JSON.parse(latest.payload) as JobResult;
      const integrated = integrationEvidence(db, child.key, baseBranch);
      if (verifiedNoChange(result)) results.push(latest.id);
      else {
        if (
          !integrated ||
          integrated.resultId !== latest.id ||
          !db
            .prepare(
              "SELECT 1 FROM workflow_checks WHERE issue_key=? AND verified=1 AND source_key=?",
            )
            .get(child.key, sourceKey([latest.id, integrated.mergeSha]))
        )
          return undefined;
        results.push(latest.id);
        merges.push(integrated.mergeSha);
      }
    }
  } else if (own) {
    results.push(own.id);
    const result = JSON.parse(own.payload) as JobResult;
    if (!verifiedNoChange(result)) {
      const integrated = integrationEvidence(db, issue.key, baseBranch);
      if (!integrated || integrated.resultId !== own.id) return undefined;
      merges.push(integrated.mergeSha);
    }
  } else if (!reviewOnly) return undefined;
  if (!results.length) results.push(`issue:${issue.key}`);
  return {
    cycleId: sourceKey([issue.key, results, merges]),
    policyVersion: 1,
    planVersion: deployment?.planVersion ?? "direct",
    objective: `${issue.summary}\n${requirementDescription(issue.description)}`,
    acceptance: plan?.acceptanceCriteria?.length ? plan.acceptanceCriteria : [issue.summary],
    verification: plan?.verification.length
      ? plan.verification
      : ["Verify the integrated result against the issue requirements."],
    integration: { baseBranch, mergeCommits: merges },
    resultIds: results,
    previousFindings: [],
    ...(merges.length ? { expectedSha: merges.at(-1) } : {}),
    verificationOnly: !reviewOnly,
  };
}

export function checkSource(context: QualityContext): string {
  return sourceKey(
    context.resultIds.length === 1 && context.integration.mergeCommits.length === 1
      ? [context.resultIds[0], context.integration.mergeCommits[0]]
      : [context.resultIds, context.integration.mergeCommits],
  );
}
