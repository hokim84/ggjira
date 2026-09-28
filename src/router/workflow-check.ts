import type { JiraGateway } from "../jira/gateway.js";
import type { WorkflowStatus } from "./config.js";

/**
 * The status moves Router itself makes in Jira (ADR 0021), checked against the project's real
 * workflow so the web UI can show whether a configured status mapping will actually work. Jira
 * only reports transitions per issue, so each hop is checked on one issue currently sitting in
 * its source status — read-only, no admin permission needed.
 */

export interface WorkflowHop {
  /** Why Router makes this move (shown in the UI). */
  label: string;
  from: string;
  to: string;
}

export type WorkflowHopResult = WorkflowHop &
  (
    | { state: "ok"; sampleIssue: string | null }
    | { state: "missing"; sampleIssue: string; reachable: string[] }
    | { state: "unknown"; reason: string }
  );

export interface ProjectWorkflowInfo {
  statuses: string[];
  subtaskIssueTypes: string[];
}

const nfc = (value: string) => value.normalize("NFC");

export function routerWorkflowHops(workflow: WorkflowStatus): WorkflowHop[] {
  const hops: WorkflowHop[] = [
    { label: "작업 시작", from: workflow.requestStatus, to: workflow.inProgressStatus },
  ];
  if (workflow.planningStatus) {
    hops.push({ label: "계획 시작", from: workflow.planningStatus, to: workflow.inProgressStatus });
  }
  hops.push({ label: "작업 완료", from: workflow.inProgressStatus, to: workflow.reviewStatus });
  if (workflow.needsDecisionStatus) {
    hops.push({
      label: "결정 요청(계획)",
      from: workflow.inProgressStatus,
      to: workflow.needsDecisionStatus,
    });
  }
  return hops;
}

function jqlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export async function inspectProjectWorkflow(
  jira: JiraGateway,
  projectKey: string,
): Promise<ProjectWorkflowInfo> {
  const [statuses, project] = await Promise.all([
    jira.listProjectStatuses(projectKey),
    jira.getProject(projectKey),
  ]);
  return {
    statuses: statuses.map(nfc),
    subtaskIssueTypes: project.issueTypes.filter((type) => type.subtask).map((type) => type.name),
  };
}

export async function checkWorkflowHops(
  jira: JiraGateway,
  projectKey: string,
  workflow: WorkflowStatus,
): Promise<WorkflowHopResult[]> {
  const known = new Set((await jira.listProjectStatuses(projectKey)).map(nfc));
  // One sample issue (and its transitions) per source status, shared by the hops leaving it.
  const samples = new Map<string, Promise<{ key: string; reachable: string[] } | null>>();
  const sampleFrom = (status: string) => {
    let sample = samples.get(status);
    if (!sample) {
      sample = (async () => {
        const [issue] = await jira.searchIssues(
          `project in (${jqlString(projectKey)}) AND status = ${jqlString(status)} ORDER BY updated DESC`,
          { maxResults: 1, fields: ["status"] },
        );
        if (!issue) return null;
        const transitions = await jira.getTransitions(issue.key);
        return { key: issue.key, reachable: transitions.map((t) => nfc(t.toStatusName)) };
      })();
      samples.set(status, sample);
    }
    return sample;
  };

  const results: WorkflowHopResult[] = [];
  for (const hop of routerWorkflowHops(workflow)) {
    const from = nfc(hop.from);
    const to = nfc(hop.to);
    if (!known.has(from) || !known.has(to)) {
      const absent = [from, to].filter((status) => !known.has(status));
      results.push({
        ...hop,
        state: "unknown",
        reason: `Jira 프로젝트에 없는 상태: ${[...new Set(absent)].join(", ")}`,
      });
      continue;
    }
    if (from === to) {
      results.push({ ...hop, state: "ok", sampleIssue: null });
      continue;
    }
    const sample = await sampleFrom(from);
    if (!sample) {
      results.push({
        ...hop,
        state: "unknown",
        reason: `"${from}" 상태인 이슈가 없어 확인할 수 없습니다. 이슈 하나를 이 상태로 옮긴 뒤 다시 확인하세요`,
      });
      continue;
    }
    results.push(
      sample.reachable.includes(to)
        ? { ...hop, state: "ok", sampleIssue: sample.key }
        : { ...hop, state: "missing", sampleIssue: sample.key, reachable: sample.reachable },
    );
  }
  return results;
}
