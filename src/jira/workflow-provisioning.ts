import { randomUUID } from "node:crypto";
import { z } from "zod";

export const DEFAULT_AI_WORKFLOW = {
  requestStatus: "AI 계획",
  planningInProgressStatus: "AI 계획중",
  inProgressStatus: "AI 구현",
  integrationPendingStatus: "AI 통합 대기",
  implementationCompleteStatus: "AI 구현 완료",
  doneStatus: "Done",
};
export type DEFAULT_AI_WORKFLOW_TYPE = typeof DEFAULT_AI_WORKFLOW;
export interface WorkflowProvisionResult {
  statuses: string[];
  added: string[];
  workflowsUpdated: string[];
  messages: string[];
  complete: boolean;
  taskId?: string;
}
export type JiraWorkflowRequest = <T>(
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
) => Promise<T>;
const statusSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    statusCategory: z.string(),
    statusReference: z.string().optional(),
  })
  .passthrough()
  .transform((status) => ({ ...status, statusReference: status.statusReference ?? status.id }));
const workflowSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    isEditable: z.boolean(),
    scope: z.object({ type: z.string(), project: z.object({ id: z.string() }).optional() }),
    statuses: z.array(
      z
        .object({ statusReference: z.string(), properties: z.record(z.string()).default({}) })
        .passthrough(),
    ),
    transitions: z.array(
      z.object({ id: z.string(), type: z.string(), toStatusReference: z.string() }).passthrough(),
    ),
    version: z.object({ id: z.string(), versionNumber: z.number() }),
    startPointLayout: z.unknown().optional(),
    loopedTransitionContainerLayout: z.unknown().optional(),
  })
  .passthrough();
const readSchema = z.object({
  statuses: z.array(statusSchema),
  workflows: z.array(workflowSchema),
});

/** Additive provisioning: keep existing statuses, transitions, rules and workflow versions. */
export async function ensureProjectAiWorkflow(
  request: JiraWorkflowRequest,
  projectKey: string,
  mapping = DEFAULT_AI_WORKFLOW,
): Promise<WorkflowProvisionResult> {
  const project = await request<{ id: string; issueTypes: Array<{ id: string }> }>(
    "GET",
    `/rest/api/3/project/${encodeURIComponent(projectKey)}`,
  );
  const readBody = {
    projectAndIssueTypes: project.issueTypes.map((type) => ({
      projectId: project.id,
      issueTypeId: type.id,
    })),
  };
  const read = readSchema.parse(await request("POST", "/rest/api/3/workflows", readBody));
  if (!read.workflows.length)
    throw new Error(
      "프로젝트의 워크플로우를 조회하지 못했습니다. Jira 프로젝트 관리 권한을 확인하세요.",
    );
  const desired = Object.values(mapping);
  const available = () =>
    read.workflows.every((workflow) =>
      desired.every((name) =>
        workflow.statuses.some((reference) =>
          read.statuses.some(
            (status) =>
              status.statusReference === reference.statusReference &&
              status.name.normalize("NFC") === name,
          ),
        ),
      ),
    );
  if (available())
    return {
      statuses: [...new Set(read.statuses.map((status) => status.name))],
      added: [],
      workflowsUpdated: [],
      messages: ["필요한 AI 상태가 이미 있습니다."],
      complete: true,
    };
  const activeStatuses = await request<
    Array<{
      id: string;
      name: string;
      scope?: { type: string; project?: { id: string } };
      statusCategory: { key: string };
    }>
  >("GET", "/rest/api/3/status");
  const added: string[] = [];
  const updates: Array<{
    id: string;
    version: { id: string; versionNumber: number };
    statuses: unknown[];
    transitions: unknown[];
    startPointLayout?: unknown;
    loopedTransitionContainerLayout?: unknown;
  }> = [];
  const statuses = read.statuses.map((status) => ({
    id: status.id,
    name: status.name,
    statusCategory: status.statusCategory,
    statusReference: status.statusReference ?? status.id,
  }));
  for (const workflow of read.workflows) {
    const missing = desired.filter(
      (name) =>
        !workflow.statuses.some((reference) =>
          statuses.some(
            (status) =>
              status.statusReference === reference.statusReference &&
              status.name.normalize("NFC") === name,
          ),
        ),
    );
    if (!missing.length) continue;
    if (!workflow.isEditable)
      throw new Error(
        `${workflow.name}: 워크플로우 편집 권한이 없습니다. Jira 관리자에게 프로젝트 워크플로우 편집 권한을 요청하세요.`,
      );
    if (workflow.scope.type === "GLOBAL") {
      const usage = await request<{
        projects?: { values?: Array<{ id: string }>; total?: number };
        values?: Array<{ id: string }>;
        total?: number;
      }>("GET", `/rest/api/3/workflow/${encodeURIComponent(workflow.id)}/projectUsages`);
      const projects = usage.projects?.values ?? usage.values;
      if (
        !projects ||
        projects.some((item) => item.id !== project.id) ||
        (usage.projects?.total ?? usage.total ?? projects.length) > projects.length
      )
        throw new Error(
          `${workflow.name}: 다른 프로젝트와 공유되거나 사용 범위를 확인할 수 없는 워크플로우입니다. 이 프로젝트 전용 워크플로우를 연결한 뒤 다시 시도하세요.`,
        );
    }
    const refs = workflow.statuses.map(({ deprecated: _deprecated, ...status }) => status);
    const transitions = [...workflow.transitions];
    let nextId = Math.max(0, ...transitions.map((transition) => Number(transition.id) || 0)) + 10;
    for (const name of missing) {
      let status = statuses.find((item) => item.name.normalize("NFC") === name);
      if (!status) {
        const existing = activeStatuses.find(
          (item) =>
            item.name.normalize("NFC") === name &&
            (!item.scope || item.scope.type === "GLOBAL" || item.scope.project?.id === project.id),
        );
        const statusCategory =
          name === mapping.doneStatus
            ? "DONE"
            : name === mapping.requestStatus
              ? "TODO"
              : "IN_PROGRESS";
        status = {
          ...(existing ? { id: existing.id } : {}),
          name,
          statusCategory,
          statusReference: existing?.id ?? randomUUID(),
        } as (typeof statuses)[number];
        statuses.push(status);
        if (!existing) added.push(name);
      }
      refs.push({
        statusReference: status.statusReference,
        properties: {},
        layout: { x: refs.length * 180, y: 250 },
      });
      transitions.push({
        id: String(nextId++),
        name,
        type: "GLOBAL",
        toStatusReference: status.statusReference,
        links: [],
        actions: [],
        validators: [],
        triggers: [],
        properties: {},
      });
    }
    updates.push({
      id: workflow.id,
      version: workflow.version,
      statuses: refs,
      transitions,
      ...(workflow.startPointLayout ? { startPointLayout: workflow.startPointLayout } : {}),
      ...(workflow.loopedTransitionContainerLayout
        ? { loopedTransitionContainerLayout: workflow.loopedTransitionContainerLayout }
        : {}),
    });
  }
  const payload = { statuses, workflows: updates };
  const validation = await request<{ errors?: unknown[] }>(
    "POST",
    "/rest/api/3/workflows/update/validation",
    { payload, validationOptions: { levels: ["ERROR"] } },
  );
  if (validation?.errors?.length)
    throw new Error(`Jira 워크플로우 검증 실패: ${JSON.stringify(validation.errors)}`);
  const result = await request<{ taskId?: string }>(
    "POST",
    "/rest/api/3/workflows/update",
    payload,
  );
  const refreshed = readSchema.parse(await request("POST", "/rest/api/3/workflows", readBody));
  const complete = refreshed.workflows.every((workflow) =>
    desired.every((name) =>
      workflow.statuses.some((reference) =>
        refreshed.statuses.some(
          (status) =>
            status.statusReference === reference.statusReference &&
            status.name.normalize("NFC") === name,
        ),
      ),
    ),
  );
  return {
    statuses: [...new Set(refreshed.statuses.map((status) => status.name))],
    added: [...new Set(added)],
    workflowsUpdated: read.workflows
      .filter((workflow) => updates.some((update) => update.id === workflow.id))
      .map((workflow) => workflow.name),
    messages: [
      `필요한 AI 상태와 전이를 자동 추가했습니다: ${desired.join(", ")}`,
      "칸반 보드 설정에서 각 AI 상태를 별도 열에 배치하고 실패·답변 대기 라벨 표시를 켜세요.",
      ...(complete ? [] : ["Jira가 변경을 적용 중입니다. 상태를 다시 불러온 뒤 계속하세요."]),
    ],
    complete,
    ...(result?.taskId ? { taskId: result.taskId } : {}),
  };
}
