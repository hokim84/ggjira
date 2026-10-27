import type { RouterDatabase } from "./db/connection.js";
import type { JiraIssue } from "../jira/types.js";
import { PLAN_PROPERTY_KEY, PlanMetadataSchema, readPlanTaskMetadata } from "../pm/metadata.js";
import { computeApprovalId } from "./approval.js";
import type { WorkspaceConfig } from "./config.js";
import type { JobRow } from "./db/jobs.js";
import { getOpenJobForIssue } from "./db/jobs.js";
import {
  getActivePlanDeployment,
  getPlanDeployment,
  listOpenPlanReviews,
  recordPlanDeployment,
  setPlanDeploymentState,
} from "./db/plan-delegation.js";
import { insertReportBatch } from "./db/report-steps.js";
import { latestPlanningRequest, planningFingerprint } from "./planning-requests.js";
import type { SchedulerDeps, SchedulerReport } from "./scheduler.js";
import { latestImplementation, sourceKey } from "./workflow-checks.js";

/** Plans publish waiting children; only a child's own status entry approves execution. */
export async function reconcileDelegatedPlans(
  deps: SchedulerDeps,
  workspace: WorkspaceConfig,
  report: SchedulerReport,
  reconcile: (issue: JiraIssue) => Promise<void>,
): Promise<void> {
  const w = workspace.workflow;
  for (const review of listOpenPlanReviews(deps.db, workspace.id)) {
    if (review.outcome !== "planned") continue;
    const issue = await deps.jira.getIssue(review.issueKey);
    const request = latestPlanningRequest(deps.db, issue.key);
    if (request?.id !== review.requestApprovalId || !request.ready_history) continue;
    const prior = getPlanDeployment(deps.db, issue.key, request.id);
    if (
      ![
        w.planningInProgressStatus,
        w.inProgressStatus,
        w.integrationPendingStatus,
        w.implementationCompleteStatus,
        w.implementationCompleteStatus,
      ].includes(issue.statusName)
    ) {
      if (prior?.state === "active")
        setPlanDeploymentState(
          deps.db,
          prior.id,
          "revoked",
          "parent withdrawn or replanned",
          deps.now(),
        );
      continue;
    }
    if (planningFingerprint(issue) !== request.input_hash) {
      report.held.push({
        issueKey: issue.key,
        target: "human",
        reason: "부모 요구사항이 변경되었습니다. AI 계획으로 옮겨 재계획하세요.",
      });
      continue;
    }
    const property = PlanMetadataSchema.safeParse(
      await deps.jira.getIssueProperty(issue.key, PLAN_PROPERTY_KEY),
    );
    if (!property.success || property.data.version !== review.planVersion) continue;
    const deployment =
      prior ??
      recordPlanDeployment(deps.db, {
        issueKey: issue.key,
        planReviewId: review.id,
        planVersion: review.planVersion,
        approvalId: request.id,
        taskIds: property.data.taskIds,
        state: "active",
        now: deps.now(),
      }).row;
    if (deployment.state !== "active" || !deployment.taskIds.length) continue;
    const children = await deps.jira.searchIssues(`parent = "${issue.key}"`, { all: true });
    const tasks: JiraIssue[] = [];
    let managed = 0;
    for (const child of children) {
      if (child.labels.includes("ggjira-superseded")) continue;
      const metadata = await readPlanTaskMetadata(deps.jira, child.key);
      if (
        metadata?.planVersion === deployment.planVersion &&
        deployment.taskIds.includes(metadata.taskId)
      ) {
        tasks.push(child);
        managed++;
      } else if (!metadata) tasks.push(child);
    }
    for (const child of tasks) if (child.statusName === w.inProgressStatus) await reconcile(child);
    if (managed !== deployment.taskIds.length) continue;
    // Only successful aggregate publication may move the parent to integration pending.
  }
}

export function planDeploymentAuthorizes(
  db: RouterDatabase,
  job: JobRow,
  parentKey: string | null,
): boolean {
  if (!parentKey) return true;
  const deployment = getActivePlanDeployment(db, parentKey);
  return Boolean(deployment && job.approvalId.startsWith(`${deployment.approvalId}#`));
}
