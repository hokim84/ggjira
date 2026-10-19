import { createHash } from "node:crypto";
import type { JobKind } from "../contracts/protocol.js";
import { computeExecutionInputHash, isLegacyInputHash } from "../issue/input-hash.js";
import type { IssueRequirements } from "../issue/requirements.js";
import type { JiraGateway } from "../jira/gateway.js";
import type { JiraChangelogEntry, JiraChangelogItem, JiraIssue } from "../jira/types.js";
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
 *
 */
export async function computeApprovalId(
  jira: JiraGateway,
  issue: JiraIssue,
  requestStatus: string,
): Promise<string> {
  const changelog = await jira.getIssueChangelog(issue.key);
  const approvingEntries = changelog.filter((entry) =>
    entry.items.some((item) => item.field === "status" && item.toString === requestStatus),
  );
  if (approvingEntries.length === 0) {
    return `created:${issue.key}`;
  }
  const latest = approvingEntries.reduce((a, b) => (a.created > b.created ? a : b));
  return latest.id;
}

/** What a `delegation`-mode issue's changelog says about its request and plan approval. */
export interface DelegationApprovalIds {
  /** The latest entry into the request status, as `computeApprovalId` gives it. */
  requestApprovalId: string;
  /** The latest move from the plan-review status to the in-progress status made after that
   *  request, or `null` when there is none. Only a status move a human made from the plan-review
   *  status counts (ADR 0044); Router itself never makes that move. */
  planApprovalId: string | null;
}

/**
 * The two events of a delegated issue: which request started its current plan, and which move to
 * in progress approved a plan after it. There is no fallback for the approval: an issue that never
 * moved from plan review to in progress has approved nothing, even if it sits in progress.
 */
export async function computeDelegationApprovalIds(
  jira: JiraGateway,
  issue: JiraIssue,
  statuses: { requestStatus: string; planReviewStatus: string; inProgressStatus: string },
): Promise<DelegationApprovalIds> {
  // Oldest first; entries Jira stamped with the same time keep the order Jira listed them in.
  const ordered = (await jira.getIssueChangelog(issue.key))
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) =>
      a.entry.created === b.entry.created
        ? a.index - b.index
        : a.entry.created < b.entry.created
          ? -1
          : 1,
    )
    .map(({ entry }) => entry);
  const isStatusMove = (entry: JiraChangelogEntry, from: string | null, to: string) =>
    entry.items.some(
      (item) =>
        item.field === "status" &&
        item.toString === to &&
        (from === null || item.fromString === from),
    );
  let request: JiraChangelogEntry | undefined;
  let approval: JiraChangelogEntry | undefined;
  for (const entry of ordered) {
    if (isStatusMove(entry, null, statuses.requestStatus)) {
      request = entry;
      approval = undefined;
    } else if (isStatusMove(entry, statuses.planReviewStatus, statuses.inProgressStatus)) {
      approval = entry;
    }
  }
  return {
    requestApprovalId: request?.id ?? `created:${issue.key}`,
    planApprovalId: approval?.id ?? null,
  };
}

/**
 * The v1 input hash (stage 2): parsed objective/acceptance/dependencies/constraints/
 * capabilities and the plan version — but not the title, the description's free text or the
 * execution strategy. Kept only so jobs created before ADR 0035 are judged by the rules they were
 * created under until they close; nothing new is stamped with it.
 */
export function computeLegacyInputHash(
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

/**
 * Hashes everything a worker is told to do (ADR 0035, `src/issue/input-hash.ts`), so the
 * scheduler can detect any edit to the title, description, strategy, scope contract,
 * capabilities, dependencies or plan placement underneath an already-open job
 * (§2 "실행 중 작업 설명·요구 capability·의존성 변경도 취소하고 새 승인을 요구한다").
 */
export function computeInputHash(input: {
  kind: JobKind;
  issue: Pick<JiraIssue, "summary" | "description">;
  requirements: IssueRequirements;
  planTask: PlanTaskMetadata | null;
}): string {
  return computeExecutionInputHash({
    kind: input.kind,
    summary: input.issue.summary,
    description: input.issue.description,
    requirements: input.requirements,
    planTask: input.planTask,
  });
}

/**
 * Whether a job's stamped input hash still matches the approval as Jira shows it. A job stamped
 * before ADR 0035 carries a v1 hash and is compared with the v1 hash of the same inputs; it is
 * never silently re-stamped (only an admin retry does that, and the audit log records it).
 * `null` is a job created before input hashes existed at all.
 */
export function inputHashMatches(
  jobInputHash: string | null,
  approval: { inputHash: string; legacyInputHash?: string | undefined },
): boolean {
  if (jobInputHash === null || jobInputHash === approval.inputHash) return true;
  return isLegacyInputHash(jobInputHash) && approval.legacyInputHash === jobInputHash;
}
