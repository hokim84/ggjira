import type { RouterDatabase } from "./db/connection.js";
import type { AssemblyContext } from "../contracts/assembly.js";
import type { JobResult } from "../contracts/envelope.js";
import type { JiraGateway } from "../jira/gateway.js";
import type { JiraIssue } from "../jira/types.js";
import { readPlanTaskMetadata } from "../pm/metadata.js";
import { computeInputHash } from "./approval.js";
import type { WorkspaceConfig } from "./config.js";
import { getActivePlanDeployment, getPlanReview } from "./db/plan-delegation.js";
import type { ApprovalSnapshot } from "./issue-check.js";
import { latestPlanningRequest, planningFingerprint } from "./planning-requests.js";
import { integrationEvidence } from "./lifecycle.js";
import {
  latestImplementation,
  sourceKey,
  acceptedImplementation,
  verifiedNoChange,
} from "./workflow-checks.js";

/** Only approved, current, published results may enter a parent's PR. Jira Done alone is no evidence. */
export async function assemblyContext(
  db: RouterDatabase,
  jira: JiraGateway,
  workspace: WorkspaceConfig,
  parent: JiraIssue,
  baseBranch: string,
  completedOverrides: ReadonlySet<string> = new Set(),
): Promise<AssemblyContext | undefined> {
  const deployment = getActivePlanDeployment(db, parent.key);
  if (!deployment?.taskIds.length || !parent.assigneeAccountId) return;
  const review = getPlanReview(db, deployment.planReviewId);
  const request = latestPlanningRequest(db, parent.key);
  if (
    !review ||
    request?.id !== review.requestApprovalId ||
    request.input_hash !== planningFingerprint(parent)
  )
    return;
  const issues = (await jira.searchIssues(`parent = "${parent.key}"`, { all: true }))
    .filter((child) => !child.labels.includes("ggjira-superseded"))
    .map((child) =>
      completedOverrides.has(child.key)
        ? { ...child, statusName: workspace.workflow.implementationCompleteStatus }
        : child,
    );
  const children: AssemblyContext["children"] = [];
  const dependencyInputs = new Map<string, ApprovalSnapshot["integration"]>();
  const managed = new Set<string>();
  for (const child of issues) {
    const task = await readPlanTaskMetadata(jira, child.key);
    if (task) {
      if (managed.has(task.taskId)) return;
      if (task.planVersion !== deployment.planVersion || !deployment.taskIds.includes(task.taskId))
        return;
      managed.add(task.taskId);
    }
    if (
      ![workspace.workflow.implementationCompleteStatus, workspace.workflow.doneStatus].includes(
        child.statusName,
      )
    )
      return;
    const latest = latestImplementation(db, child.key);
    if (!latest) return;
    const frozen = db
      .prepare(
        "SELECT snapshot FROM job_inputs WHERE job_id=(SELECT job_id FROM results WHERE id=?)",
      )
      .get(latest.id) as { snapshot: string } | undefined;
    if (!frozen) return;
    const input = JSON.parse(frozen.snapshot) as ApprovalSnapshot;
    dependencyInputs.set(child.key, input.integration);
    if (
      computeInputHash({
        kind: "implementation",
        issue: child,
        requirements: input.requirements,
        planTask: input.planTask,
      }) !== latest.input_hash
    )
      return;
    const result = JSON.parse(latest.payload) as JobResult;
    const noChange = verifiedNoChange(result);
    if (!noChange && !acceptedImplementation(db, workspace, child, latest.id, result)) return;
    const integrated = integrationEvidence(db, child.key, baseBranch);
    if (
      !result.git?.baseSha ||
      (!noChange &&
        (!result.git.headSha ||
          !result.branch ||
          !result.artifacts?.some((a) => a.startsWith("pushed:"))))
    )
      return;
    children.push({
      issueKey: child.key,
      resultId: latest.id,
      baseSha: result.git.baseSha,
      headSha: result.git.headSha ?? result.git.baseSha,
      ...(result.branch ? { branch: result.branch } : {}),
      noChange,
      ...(integrated?.resultId === latest.id ? { integratedMergeSha: integrated.mergeSha } : {}),
      dependencies: input.requirements.dependencies.flatMap(
        (d) => d.match(/[A-Z][A-Z0-9_]+-\d+/)?.[0] ?? [],
      ),
    });
  }
  if (managed.size !== deployment.taskIds.length || !children.length) return;
  for (const child of children) {
    const consumed = dependencyInputs.get(child.issueKey);
    for (const key of child.dependencies) {
      const dependency = children.find((c) => c.issueKey === key);
      if (
        dependency &&
        !dependency.noChange &&
        !consumed?.resultCommits?.includes(dependency.headSha) &&
        !(
          dependency.integratedMergeSha &&
          consumed?.mergeCommits.includes(dependency.integratedMergeSha)
        )
      )
        return;
    }
  }
  const ordered: typeof children = [];
  const pending = [...children].sort((a, b) => a.issueKey.localeCompare(b.issueKey));
  while (pending.length) {
    const index = pending.findIndex((c) =>
      c.dependencies.every((key) => !pending.some((p) => p.issueKey === key)),
    );
    if (index < 0) return;
    ordered.push(...pending.splice(index, 1));
  }
  const cycleId = sourceKey([
    parent.key,
    deployment.planVersion,
    ordered.map((c) => [c.issueKey, c.resultId, c.headSha, c.integratedMergeSha ?? null]),
  ]);
  const prior = db
    .prepare(
      "SELECT r.payload,p.state FROM jobs j JOIN results r ON r.job_id=j.id LEFT JOIN pull_requests p ON p.job_id=j.id WHERE j.issue_key=? AND j.kind='assemble_pr' AND j.state='succeeded' AND r.applied=1 ORDER BY j.rowid DESC LIMIT 1",
    )
    .get(parent.key) as { payload: string; state: string | null } | undefined;
  const previousBranch =
    prior?.state === "open" ? (JSON.parse(prior.payload) as JobResult).branch : undefined;
  const replacedPullRequests = ordered.flatMap(
    (child) =>
      db
        .prepare("SELECT repo,number,url FROM pull_requests WHERE issue_key=? AND state='open'")
        .all(child.issueKey) as { repo: string; number: number; url: string }[],
  );
  return {
    cycleId,
    planVersion: deployment.planVersion,
    parentKey: parent.key,
    baseBranch,
    children: ordered,
    replacedPullRequests,
    ...(previousBranch ? { previousBranch } : {}),
  };
}

export function latestAssembly(db: RouterDatabase, issueKey: string) {
  return db
    .prepare(
      "SELECT j.id,j.input_hash,r.id AS resultId,r.payload,a.context FROM jobs j JOIN results r ON r.job_id=j.id JOIN assembly_runs a ON a.job_id=j.id WHERE j.issue_key=? AND j.kind='assemble_pr' AND j.state='succeeded' AND r.applied=1 ORDER BY j.rowid DESC LIMIT 1",
    )
    .get(issueKey) as
    | { id: string; input_hash: string; resultId: string; payload: string; context: string }
    | undefined;
}

export async function publishedImplementation(
  db: RouterDatabase,
  jira: JiraGateway,
  workspace: WorkspaceConfig,
  key: string,
) {
  const issue = await jira.getIssue(key);
  if (
    ![workspace.workflow.implementationCompleteStatus, workspace.workflow.doneStatus].includes(
      issue.statusName,
    )
  )
    return;
  const latest = latestImplementation(db, key);
  if (!latest) return;
  const frozen = db
    .prepare("SELECT snapshot FROM job_inputs WHERE job_id=(SELECT job_id FROM results WHERE id=?)")
    .get(latest.id) as { snapshot: string } | undefined;
  if (!frozen) return;
  const input = JSON.parse(frozen.snapshot) as ApprovalSnapshot;
  if (
    computeInputHash({
      kind: "implementation",
      issue,
      requirements: input.requirements,
      planTask: input.planTask,
    }) !== latest.input_hash
  )
    return;
  const result = JSON.parse(latest.payload) as JobResult;
  return verifiedNoChange(result) ||
    (acceptedImplementation(db, workspace, issue, latest.id, result) &&
      result.git?.headSha &&
      result.artifacts?.some((a) => a.startsWith("pushed:")))
    ? result
    : undefined;
}
