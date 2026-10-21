import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { JobResult } from "../contracts/envelope.js";
import {
  type QualityContext,
  type QualityReport,
  QualityContextSchema,
  QualityReportSchema,
} from "../contracts/quality.js";
import type { JiraIssue } from "../jira/types.js";
import { planningRequirements } from "../pm/contract.js";
import { renderTaskDescription } from "../pm/plan-render.js";
import { computeInputHash } from "./approval.js";
import type { WorkspaceConfig } from "./config.js";
import { upsertApproval } from "./db/approvals.js";
import { createJob, getJob, getOpenJobForIssue, transitionJobState } from "./db/jobs.js";
import {
  type PlanDeploymentRow,
  type PlanReviewRow,
  getReviewedPlan,
} from "./db/plan-delegation.js";
import { type NewReportStep, insertReportBatch, listBatchReportSteps } from "./db/report-steps.js";
import { toIssueSnapshot } from "./issue-check.js";
import { integrationEvidence } from "./lifecycle.js";
import { latestPlanningRequest, planningFingerprint } from "./planning-requests.js";
import type { SchedulerDeps, SchedulerReport } from "./scheduler.js";

export interface QualityCycle {
  id: string;
  deployment_id: number;
  input_key: string;
  job_id: string;
  state: string;
  context: string;
  report: string | null;
  created_at: string;
  updated_at: string;
}
type Decision = {
  finding_id: string;
  action: number;
  reason: string;
  source_comment_id: string;
  batch_id: string | null;
};
function findingFingerprint(finding: QualityReport["findings"][number]): string {
  return JSON.stringify([
    finding.category,
    finding.summary,
    [...finding.evidence].sort(),
    finding.impact,
  ]);
}
export function latestQualityCycle(
  db: Database.Database,
  deploymentId: number,
): QualityCycle | undefined {
  return db
    .prepare("SELECT * FROM quality_cycles WHERE deployment_id=? ORDER BY rowid DESC LIMIT 1")
    .get(deploymentId) as QualityCycle | undefined;
}
export function recordQualityResult(
  db: Database.Database,
  jobId: string,
  result: JobResult,
  now: string,
): void {
  const parsed = QualityReportSchema.safeParse(result.quality);
  const cycle = db
    .prepare("SELECT id,deployment_id,context FROM quality_cycles WHERE job_id=?")
    .get(jobId) as { id: string; deployment_id: number; context: string } | undefined;
  const context = cycle ? QualityContextSchema.parse(JSON.parse(cycle.context)) : undefined;
  const ok =
    result.status === "succeeded" &&
    parsed.success &&
    (!context?.expectedSha || context.expectedSha === parsed.data.targetSha);
  if (ok && parsed.success && cycle) {
    // Exact evidence identity only: carry human dispositions, never an old verification pass.
    parsed.data.findings = [
      ...new Map(
        parsed.data.findings.map((finding) => [findingFingerprint(finding), finding]),
      ).values(),
    ];
    const previous = db
      .prepare(
        "SELECT id,report FROM quality_cycles WHERE deployment_id=? AND id<>? AND report IS NOT NULL ORDER BY rowid DESC",
      )
      .all(cycle.deployment_id, cycle.id) as { id: string; report: string }[];
    for (const finding of parsed.data.findings) {
      for (const prior of previous) {
        const match = QualityReportSchema.parse(JSON.parse(prior.report)).findings.find(
          (candidate) => findingFingerprint(candidate) === findingFingerprint(finding),
        );
        if (!match) continue;
        const decision = db
          .prepare(
            "SELECT * FROM quality_decisions WHERE cycle_id=? AND finding_id=? ORDER BY rowid DESC LIMIT 1",
          )
          .get(prior.id, match.id) as (Decision & { actor_id: string }) | undefined;
        if (decision && (decision.action === 2 || decision.action === 3))
          db.prepare(
            "INSERT OR IGNORE INTO quality_decisions (cycle_id,finding_id,action,reason,source_comment_id,batch_id,created_at,actor_id,source_cycle_id) VALUES (?,?,?,?,?,?,?,?,?)",
          ).run(
            cycle.id,
            finding.id,
            decision.action,
            decision.reason,
            decision.source_comment_id,
            decision.batch_id,
            now,
            decision.actor_id,
            prior.id,
          );
        break;
      }
    }
  }
  db.prepare(
    "UPDATE quality_cycles SET state=?, report=?, updated_at=? WHERE job_id=? AND state='running'",
  ).run(
    ok ? "judgment" : result.failureReason?.includes("stale quality target") ? "stale" : "failed",
    ok ? JSON.stringify(parsed.data) : null,
    now,
    jobId,
  );
}

/** One completion procedure per parent: initial assessment, human dispositions and focused rechecks. */
export async function reconcileQualityReview(
  deps: SchedulerDeps,
  workspace: WorkspaceConfig,
  parent: JiraIssue,
  review: PlanReviewRow,
  deployment: PlanDeploymentRow,
  tasks: JiraIssue[],
  report: SchedulerReport,
): Promise<void> {
  const { db } = deps;
  const now = deps.now();
  const held = (reason: string) => {
    report.held.push({ issueKey: parent.key, target: "human", reason });
    const current = db
      .prepare("SELECT reason FROM plan_deployments WHERE id=?")
      .get(deployment.id) as { reason: string | null };
    if (current.reason !== reason)
      db.transaction(() => {
        db.prepare("UPDATE plan_deployments SET reason=?,updated_at=? WHERE id=?").run(
          reason,
          now,
          deployment.id,
        );
        insertReportBatch(db, {
          batchId: `quality:progress:${deployment.id}:${randomUUID()}`,
          jobId: review.jobId,
          attemptId: review.attemptId,
          issueKey: parent.key,
          steps: [{ kind: "lifecycle-summary", params: { summary: reason } }],
          now,
        });
      })();
  };
  const request = latestPlanningRequest(db, parent.key);
  if (
    !request ||
    request.id !== review.requestApprovalId ||
    request.input_hash !== planningFingerprint(parent)
  ) {
    held(
      "요구사항이 변경되었습니다. 실행 중 작업을 마친 뒤 ‘재계획’ 댓글로 작업 목록을 갱신하세요.",
    );
    return;
  }
  if (!parent.assigneeAccountId) {
    held("부모 담당자가 필요합니다.");
    return;
  }
  const baseBranch =
    deps.config.repositories.find((repo) => repo.id === workspace.repositoryId)?.baseBranch ??
    "main";
  const integrated = tasks.map((task) => integrationEvidence(db, task.key, baseBranch));
  if (
    tasks.length !== deployment.taskIds.length ||
    !tasks.length ||
    tasks.some(
      (task, index) =>
        !integrated[index] ||
        (workspace.workflow.doneStatus
          ? task.statusName !== workspace.workflow.doneStatus
          : task.statusName !== workspace.workflow.reviewStatus),
    )
  ) {
    held(
      `필수 작업 완료·통합 대기 (${integrated.filter(Boolean).length}/${deployment.taskIds.length})`,
    );
    return;
  }
  const inputKey = createHash("sha256")
    .update(JSON.stringify([review.planVersion, integrated, 1]))
    .digest("hex");
  let cycle = latestQualityCycle(db, deployment.id);
  if (
    cycle?.state === "passed" &&
    listBatchReportSteps(db, `quality:${cycle.id}:complete`).some(
      (step) => step.kind === "transition" && step.status === "skipped",
    )
  ) {
    db.prepare("UPDATE quality_cycles SET state='stale',updated_at=? WHERE id=?").run(
      now,
      cycle.id,
    );
    cycle = { ...cycle, state: "stale", updated_at: now };
  }
  if (cycle?.state === "running") {
    const job = getJob(db, cycle.job_id);
    if (job && ["failed", "timed_out", "cancelled"].includes(job.state)) {
      db.prepare("UPDATE quality_cycles SET state='failed',updated_at=? WHERE id=?").run(
        now,
        cycle.id,
      );
      cycle = { ...cycle, state: "failed", updated_at: now };
    } else {
      held("통합 검증·기술부채 평가 중");
      return;
    }
  }
  const comments = await deps.jira.getComments(parent.key);
  const human = comments.filter(
    (comment) =>
      comment.authorAccountId === parent.assigneeAccountId && !comment.body.includes("[GGJIRA:"),
  );
  const retry =
    cycle &&
    human.find((comment) => comment.created > cycle.updated_at && comment.body.trim() === "재시도");
  if (cycle && ["failed", "stale"].includes(cycle.state) && !retry) {
    held("평가 미완료: 원인을 확인한 뒤 ‘재시도’ 댓글을 남기세요.");
    return;
  }
  const quality = cycle?.report ? QualityReportSchema.parse(JSON.parse(cycle.report)) : undefined;
  if (cycle && cycle.input_key === inputKey && quality && !retry) {
    const decisions = db
      .prepare("SELECT * FROM quality_decisions WHERE cycle_id=? ORDER BY rowid")
      .all(cycle.id) as Decision[];
    const latest = new Map(decisions.map((decision) => [decision.finding_id, decision]));
    const pending = quality.findings.find(
      (finding) => !latest.has(finding.id) || latest.get(finding.id)?.action === 4,
    );
    const batch = (id: string, steps: NewReportStep[]) =>
      insertReportBatch(db, {
        batchId: id,
        jobId: cycle.job_id,
        attemptId: getJob(db, cycle.job_id)?.currentAttemptId ?? review.attemptId,
        issueKey: parent.key,
        steps,
        now,
      });
    if (pending) {
      const marker = `[GGJIRA:QUALITY:${cycle.id}:${pending.id}]`;
      const prompt = [
        marker,
        `질문 ${quality.findings.indexOf(pending) + 1}/${quality.findings.length}: ${pending.summary}`,
        `분류: ${pending.category}\n영향: ${pending.impact}`,
        ...pending.evidence.map((evidence) => `- ${evidence}`),
        `개선안: ${pending.remediation.title}`,
        renderTaskDescription(pending.remediation),
        "1. 이번에 개선",
        "2. 후속 이관 (사유 필요)",
        "3. 수용·기각 (사유 필요)",
        "4. 보류 (사유 필요)",
        "번호와 사유를 댓글로 입력하세요. 결함·환경 장애·근거 부족은 1 또는 4만 가능합니다.",
      ].join("\n");
      batch(`quality:${cycle.id}:question:${pending.id}`, [
        { kind: "comment", params: { body: prompt } },
      ]);
      const questionIndex = comments.findIndex((comment) => comment.body.includes(marker));
      if (questionIndex < 0) return;
      const answer = [...human]
        .reverse()
        .find(
          (comment) =>
            comments.indexOf(comment) > questionIndex &&
            !decisions.some((decision) => decision.source_comment_id === comment.id) &&
            /^[1-4]\s*(?:번)?(?:\s+.*)?$/s.test(comment.body.trim()),
        );
      if (!answer) {
        held("기술부채 후보 판단 대기");
        return;
      }
      const match = /^([1-4])\s*(?:번)?(?:\s+([\s\S]+))?$/.exec(answer.body.trim());
      const action = Number(match?.[1]);
      let reason = match?.[2]?.trim() ?? "";
      if (action !== 1 && (!reason || /^\d+\s*번?$/.test(reason))) {
        const follow = human.find(
          (comment) =>
            comments.indexOf(comment) > comments.indexOf(answer) &&
            !/^\d+(?:\s*번)?(?:\s|$)/.test(comment.body.trim()) &&
            !["재시도", "재계획"].includes(comment.body.trim()) &&
            !decisions.some((decision) => decision.source_comment_id === comment.id),
        );
        if (follow) reason = follow.body.trim();
        else {
          batch(`quality:${cycle.id}:reason:${answer.id}`, [
            { kind: "comment", params: { body: "선택 이유를 다음 댓글에 입력하세요." } },
          ]);
          return;
        }
      }
      if (
        ["defect", "environment", "unknown"].includes(pending.category) &&
        (action === 2 || action === 3)
      ) {
        batch(`quality:${cycle.id}:invalid:${answer.id}`, [
          {
            kind: "comment",
            params: {
              body: "필수 문제를 후속 이관·수용으로 통과시킬 수 없습니다. 1(개선) 또는 4(보류)를 사유와 함께 선택하세요.",
            },
          },
        ]);
        // Consume rejected replies as holds so they cannot shadow a later valid answer.
        db.prepare(
          "INSERT OR IGNORE INTO quality_decisions (cycle_id,finding_id,action,reason,source_comment_id,batch_id,created_at,actor_id) VALUES (?,?,?,?,?,?,?,?)",
        ).run(
          cycle.id,
          pending.id,
          4,
          "invalid disposition",
          answer.id,
          null,
          now,
          parent.assigneeAccountId,
        );
        return;
      }
      const batchId = `quality:${cycle.id}:decision:${answer.id}`;
      db.transaction(() => {
        db.prepare(
          "INSERT OR IGNORE INTO quality_decisions (cycle_id,finding_id,action,reason,source_comment_id,batch_id,created_at,actor_id) VALUES (?,?,?,?,?,?,?,?)",
        ).run(
          cycle.id,
          pending.id,
          action,
          reason,
          answer.id,
          action === 1 || action === 2 ? batchId : null,
          now,
          parent.assigneeAccountId,
        );
        if (action === 1 || action === 2) {
          const taskId = `quality-${createHash("sha256").update(`${cycle.id}:${pending.id}`).digest("hex").slice(0, 16)}`;
          const task = { ...pending.remediation, taskId, dependencies: [] };
          const steps: NewReportStep[] = [
            {
              kind: "create-subtask",
              params: {
                taskId,
                projectKey: parent.projectKey,
                parentKey: parent.key,
                standalone: action === 2,
                issueTypeName:
                  action === 1
                    ? deps.config.planning.subtaskIssueType
                    : deps.config.planning.followupIssueType,
                summary: task.title,
                description: `${renderTaskDescription(task)}\n\n원본: ${parent.key}\n근거: ${pending.evidence.join("; ")}\n판단: ${reason}`,
                assigneeAccountId: parent.assigneeAccountId,
              },
            },
          ];
          if (action === 1) {
            db.prepare("INSERT OR IGNORE INTO plan_extensions VALUES (?,?,?,?,?,?,?)").run(
              cycle.id,
              pending.id,
              parent.key,
              review.planVersion,
              taskId,
              JSON.stringify(task),
              answer.id,
            );
            steps.push(
              {
                kind: "stamp-task",
                params: {
                  taskId,
                  task,
                  planVersion: review.planVersion,
                  parentKey: parent.key,
                  workspaceId: workspace.id,
                },
              },
              {
                kind: "extend-plan",
                params: { taskId, version: review.planVersion, deploymentId: deployment.id },
              },
            );
          }
          steps.push({
            kind: "plan-comment",
            params: {
              summary: `${action === 1 ? "이번 개선" : "후속 이관"}: ${pending.summary}`,
              signature: marker,
              language: deps.config.reporting.language,
              next: action === 1 ? ["생성된 자식을 작업 중으로 옮기면 실행합니다."] : [],
            },
          });
          if (action === 1) {
            steps.push({
              kind: "children-ready",
              params: {
                version: review.planVersion,
                inProgressStatus: workspace.workflow.inProgressStatus,
              },
            });
          }
          batch(batchId, steps);
        }
      })();
      return;
    }
    if (
      decisions.some(
        (decision) =>
          decision.batch_id &&
          !listBatchReportSteps(db, decision.batch_id).every((step) => step.status === "applied"),
      )
    ) {
      held("개선·후속 이슈 반영 대기");
      return;
    }
    if (quality.findings.some((finding) => latest.get(finding.id)?.action === 1)) {
      held("필수 개선 작업 완료·통합 대기");
      return;
    }
    if (!quality.verificationPassed) {
      held("필수 통합 검증이 통과하지 못했습니다. 원인 해결 후 재시도하세요.");
      return;
    }
    const context = QualityContextSchema.parse(JSON.parse(cycle.context));
    if (!context.verificationOnly) {
      enqueue({
        ...context,
        cycleId: randomUUID(),
        expectedSha: quality.targetSha,
        verificationOnly: true,
      });
      return;
    }
    const rule = {
      kind: "quality",
      cycleId: cycle.id,
      planVersion: review.planVersion,
      requestId: request.id,
      inputHash: request.input_hash,
      tasks: tasks.map((task, index) => ({ key: task.key, resultId: integrated[index]?.resultId })),
      baseBranch,
      taskStatus: workspace.workflow.doneStatus ?? workspace.workflow.reviewStatus,
    };
    batch(`quality:${cycle.id}:complete`, [
      {
        kind: "comment",
        params: {
          body: `통합 검증·기술부채 판단이 완료되었습니다. ${workspace.workflow.reviewStatus}에서 최종 검토해 주세요.\n대상: ${quality.targetSha}\n필수 작업: ${tasks.map((task) => task.key).join(", ")}`,
        },
      },
      {
        kind: "transition",
        params: {
          to: workspace.workflow.reviewStatus,
          from: [workspace.workflow.requestStatus],
          approvalStatus: workspace.workflow.requestStatus,
          approvalId: request.id,
          approvalRule: rule,
        },
      },
    ]);
    db.prepare("UPDATE quality_cycles SET state='passed',updated_at=? WHERE id=?").run(
      now,
      cycle.id,
    );
    return;
  }
  const plan = getReviewedPlan(db, review.id);
  if (!plan?.acceptanceCriteria?.length || !plan.verification.length) {
    held("부모 완료 조건과 통합 검증 계약이 필요합니다.");
    return;
  }
  const prior = db
    .prepare(
      "SELECT q.report, d.finding_id,d.action,d.reason FROM quality_cycles q LEFT JOIN quality_decisions d ON d.cycle_id=q.id WHERE q.deployment_id=? AND q.report IS NOT NULL",
    )
    .all(deployment.id) as object[];
  enqueue({
    cycleId: randomUUID(),
    planVersion: review.planVersion,
    policyVersion: 1,
    objective: plan.objective ?? plan.summary,
    acceptance: plan.acceptanceCriteria,
    verification: plan.verification,
    integration: {
      baseBranch,
      mergeCommits: integrated.flatMap((item) => (item ? [item.mergeSha] : [])),
    },
    resultIds: integrated.flatMap((item) => (item ? [item.resultId] : [])),
    previousFindings: prior.map((item) => JSON.stringify(item)),
  });

  function enqueue(context: QualityContext): void {
    const open = getOpenJobForIssue(db, parent.key);
    if (open && !["failed", "timed_out"].includes(open.state)) return;
    db.transaction(() => {
      if (open) transitionJobState(db, open.id, "cancelled", now);
      const id = randomUUID();
      const approvalId = `quality:${context.cycleId}`;
      const requirements = planningRequirements(parent.summary);
      const inputHash = computeInputHash({
        kind: "quality_review",
        issue: parent,
        requirements,
        planTask: null,
      });
      upsertApproval(db, {
        issueKey: parent.key,
        approvalId,
        inputHash,
        inputSnapshot: {
          issue: toIssueSnapshot(parent),
          requirements,
          planTask: null,
          quality: context,
        },
        now,
      });
      createJob(db, {
        id,
        issueKey: parent.key,
        workspaceId: workspace.id,
        repositoryId: workspace.repositoryId,
        kind: "quality_review",
        approvalId,
        inputHash,
        now,
      });
      db.prepare(
        "INSERT INTO quality_cycles (id,deployment_id,input_key,job_id,state,context,created_at,updated_at) VALUES (?,?,?,?,'running',?,?,?)",
      ).run(context.cycleId, deployment.id, inputKey, id, JSON.stringify(context), now, now);
      report.jobsCreated.push(id);
    })();
  }
}
