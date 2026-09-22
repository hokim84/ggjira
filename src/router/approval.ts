import { createHash } from "node:crypto";
import type { JiraGateway } from "../jira/gateway.js";
import type { JiraIssue } from "../jira/types.js";
import type { IssueRequirements } from "../agent/requirements.js";
import type { PlanTaskMetadata } from "../pm/metadata.js";

/**
 * Identifies *which* entry into `requestStatus` this job is for
 * (docs/router-service-implementation-plan.md §3 "승인 식별자는 요청 상태로 진입한 Jira
 * changelog 항목을 사용한다"). A revoke-then-reapprove produces a different changelog
 * entry, hence a different approvalId, even though the issue key is unchanged — that's
 * what lets the scheduler tell "still the same approval" apart from "approved again".
 * Falls back to a stable per-issue sentinel when the issue was created directly into
 * `requestStatus` (§3 "생성부터 요청 상태였던 이슈는 생성 이벤트를 사용한다") — a plain
 * `updated` timestamp is explicitly not used as the approval identifier.
 */
export async function computeApprovalId(
  jira: JiraGateway,
  issue: JiraIssue,
  requestStatus: string,
): Promise<string> {
  const changelog = await jira.getIssueChangelog(issue.key);
  const entriesIntoRequestStatus = changelog.filter((entry) =>
    entry.items.some((item) => item.field === "status" && item.toString === requestStatus),
  );
  if (entriesIntoRequestStatus.length === 0) {
    return `created:${issue.key}`;
  }
  const latest = entriesIntoRequestStatus.reduce((a, b) => (a.created > b.created ? a : b));
  return latest.id;
}

/**
 * Hashes the inputs a job was dispatched with, so the scheduler can detect a
 * description/capability/dependency/plan-version edit underneath an already-open job
 * (§2 "실행 중 작업 설명·요구 capability·의존성 변경도 취소하고 새 승인을 요구한다").
 */
export function computeInputHash(
  requirements: IssueRequirements,
  planTask: PlanTaskMetadata | null,
): string {
  const canonical = {
    objective: requirements.objective,
    acceptanceCriteria: requirements.acceptanceCriteria,
    dependencies: [...requirements.dependencies].sort(),
    constraints: requirements.constraints,
    requiredCapabilities: [...requirements.requiredCapabilities].sort(),
    planVersion: planTask?.planVersion ?? null,
    planWorkspaceId: planTask?.workspaceId ?? null,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
