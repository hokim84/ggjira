import { createHash, randomUUID } from "node:crypto";
import type { RouterDatabase } from "./db/connection.js";
import { normalizeExecutionText } from "../issue/input-hash.js";
import type { JiraGateway } from "../jira/gateway.js";
import type { JiraComment, JiraIssue } from "../jira/types.js";
import { type HumanDecision, findHumanDecision } from "../pm/context.js";
import { DECISION_REQUEST_MARKER } from "../pm/marker.js";
import { requirementDescription } from "../pm/plan-render.js";
import { computeApprovalId } from "./approval.js";
import { getOpenJobForIssue } from "./db/jobs.js";
import {
  getActivePlanDeployment,
  getLatestPlanReview,
  getReviewedPlan,
} from "./db/plan-delegation.js";
import { listBatchReportSteps } from "./db/report-steps.js";

export function planningFingerprint(issue: Pick<JiraIssue, "summary" | "description">): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        normalizeExecutionText(issue.summary),
        requirementDescription(issue.description),
      ]),
    )
    .digest("hex");
}

export interface PlanningRequest {
  id: string;
  issue_key: string;
  entry_id: string;
  input_hash: string;
  input_snapshot: string;
  source_comment_id: string | null;
  decision: string | null;
  created_at: string;
  ready_history: string | null;
  lifecycle_version: 1 | 2;
}

export function latestPlanningRequest(
  db: RouterDatabase,
  key: string,
): PlanningRequest | undefined {
  return db
    .prepare("SELECT * FROM planning_requests WHERE issue_key = ? ORDER BY rowid DESC LIMIT 1")
    .get(key) as PlanningRequest | undefined;
}

function humanComment(comment: JiraComment, issue: JiraIssue): boolean {
  return (
    issue.assigneeAccountId !== null &&
    comment.authorAccountId === issue.assigneeAccountId &&
    !comment.body.includes("[GGJIRA:") &&
    !/^ggjira job:/m.test(comment.body)
  );
}

/** One durable request per status entry, requirement edit, answer or explicit retry. */
export async function syncPlanningRequest(
  db: RouterDatabase,
  jira: JiraGateway,
  issue: JiraIssue,
  requestStatus: string,
  now = new Date().toISOString(),
  planningInProgressStatus?: string,
): Promise<PlanningRequest | undefined> {
  const entry = await computeApprovalId(jira, issue, requestStatus);
  const hash = planningFingerprint(issue);
  const previous = latestPlanningRequest(db, issue.key);
  if (previous && planningInProgressStatus && previous.entry_id === entry) {
    const snapshot = JSON.parse(previous.input_snapshot) as Record<string, unknown>;
    if (snapshot.planningInProgressStatus !== planningInProgressStatus) {
      previous.input_snapshot = JSON.stringify({ ...snapshot, planningInProgressStatus });
      db.prepare("UPDATE planning_requests SET input_snapshot=? WHERE id=?").run(
        previous.input_snapshot,
        previous.id,
      );
    }
  }
  const live = getActivePlanDeployment(db, issue.key);
  if (previous?.lifecycle_version === 2 && live && previous.input_hash !== hash) {
    const started = db
      .prepare(
        "SELECT 1 FROM jobs WHERE issue_key IN (SELECT issue_key FROM approvals WHERE json_extract(input_snapshot,'$.planTask.parentKey') = ?) AND kind='implementation' AND attempt_count > 0 LIMIT 1",
      )
      .get(issue.key);
    if (started) {
      const busy = db
        .prepare(
          "SELECT 1 FROM jobs WHERE issue_key IN (SELECT issue_key FROM approvals WHERE json_extract(input_snapshot,'$.planTask.parentKey') = ?) AND kind='implementation' AND state NOT IN ('succeeded','cancelled','failed','timed_out') LIMIT 1",
        )
        .get(issue.key);
      const comments = await jira.getComments(issue.key);
      if (
        busy ||
        !comments.some(
          (comment) =>
            humanComment(comment, issue) &&
            comment.body.trim() === "재계획" &&
            comment.created > live.createdAt,
        )
      )
        return previous;
    }
  }
  // An upgrade never adopts old requests or their approvals silently.
  const baseline = db.prepare("SELECT MIN(cutoff) AS cutoff FROM planning_baselines").get() as {
    cutoff: string | null;
  };
  const cutoff = baseline.cutoff;
  if (cutoff && !previous) {
    const history = await jira.getIssueChangelog(issue.key);
    if (!history.some((item) => item.id === entry && item.created > cutoff)) return undefined;
  }
  let source: JiraComment | undefined;
  let decision: HumanDecision | undefined;
  if (previous && previous.entry_id === entry && previous.input_hash === hash) {
    const review = getLatestPlanReview(db, issue.key);
    const job = getOpenJobForIssue(db, issue.key);
    const comments = await jira.getComments(issue.key);
    const available = comments.filter(
      (comment) =>
        humanComment(comment, issue) &&
        !db
          .prepare("SELECT 1 FROM planning_requests WHERE issue_key = ? AND source_comment_id = ?")
          .get(issue.key, comment.id),
    );
    if (review?.requestApprovalId === previous.id && review.outcome === "needs_decision") {
      const requestIndex = comments.findIndex(
        (comment) =>
          comment.body.includes(DECISION_REQUEST_MARKER) &&
          comment.body.replace(/\r\n/g, "\n").includes(`planVersion: ${review.planVersion}\n`),
      );
      if (requestIndex >= 0) {
        const request = comments[requestIndex];
        if (request)
          for (const comment of available) {
            if (comments.indexOf(comment) <= requestIndex) continue;
            // Automatic continuation is a choice, never an arbitrary discussion comment.
            if (!/^(?:\d+\s*(?:번)?|Decision:\s*\S+)$/i.test(comment.body.trim())) continue;
            const parsed = findHumanDecision([request, comment], "", issue.assigneeAccountId);
            if (
              parsed?.optionId &&
              getReviewedPlan(db, review.id)?.decision?.options.some(
                (option) => option.id === parsed.optionId,
              )
            ) {
              source = comment;
              decision = parsed;
              break;
            }
          }
      }
    } else if (
      (job?.kind === "planning" && ["failed", "timed_out"].includes(job.state)) ||
      (review?.requestApprovalId === previous.id && review.outcome === "not_applied")
    ) {
      const failedAt = job?.updatedAt ?? review?.createdAt ?? previous.created_at;
      source = available.find(
        (comment) => comment.body.trim() === "재시도" && comment.created > failedAt,
      );
    }
    if (!source) return previous;
  }
  const id = `planning:${randomUUID()}`;
  return db.transaction(() => {
    const current = latestPlanningRequest(db, issue.key);
    // Concurrent heartbeat/reconcile reads may have discovered this same change already.
    if (current?.id !== previous?.id) {
      return current?.entry_id === entry && current.input_hash === hash ? current : undefined;
    }
    db.prepare(`INSERT INTO planning_requests
    (id, issue_key, entry_id, input_hash, input_snapshot, source_comment_id, decision, created_at, lifecycle_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 2)`).run(
      id,
      issue.key,
      entry,
      hash,
      JSON.stringify({
        summary: issue.summary,
        description: requirementDescription(issue.description),
        statusName: requestStatus,
        planningInProgressStatus,
        assigneeAccountId: issue.assigneeAccountId,
      }),
      source?.id ?? null,
      decision ? JSON.stringify(decision) : null,
      now,
    );
    return latestPlanningRequest(db, issue.key);
  })();
}

/** Mark a plan approvable only after every write succeeded while still in AI review. */
export async function markReadyPlans(db: RouterDatabase, jira: JiraGateway): Promise<void> {
  const requests = db
    .prepare(
      "SELECT * FROM planning_requests AS p WHERE ready_history IS NULL AND rowid = (SELECT MAX(rowid) FROM planning_requests WHERE issue_key = p.issue_key)",
    )
    .all() as unknown as PlanningRequest[];
  for (const request of requests) {
    if (latestPlanningRequest(db, request.issue_key)?.id !== request.id) continue;
    const review = getLatestPlanReview(db, request.issue_key);
    if (
      !review ||
      review.requestApprovalId !== request.id ||
      review.outcome !== "planned" ||
      review.closedAt
    )
      continue;
    const steps = listBatchReportSteps(db, review.id);
    if (
      !steps.length ||
      !steps.every(
        (step) =>
          step.status === "applied" ||
          (step.kind === "supersede" &&
            step.status === "skipped" &&
            step.lastError?.includes("already started")),
      )
    )
      continue;
    const issue = await jira.getIssue(request.issue_key);
    const snapshot = JSON.parse(request.input_snapshot) as {
      statusName?: string;
      planningInProgressStatus?: string;
    };
    if (
      ![snapshot.statusName, snapshot.planningInProgressStatus].includes(issue.statusName) ||
      planningFingerprint(issue) !== request.input_hash
    )
      continue;
    const history = await jira.getIssueChangelog(issue.key);
    db.prepare("UPDATE planning_requests SET ready_history = ? WHERE id = ?").run(
      JSON.stringify(history.map((entry) => entry.id)),
      request.id,
    );
  }
}

export function planningDecision(request: PlanningRequest | undefined): HumanDecision | undefined {
  return request?.decision ? (JSON.parse(request.decision) as HumanDecision) : undefined;
}
