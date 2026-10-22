import { describe, expect, it } from "vitest";
import {
  DEFAULT_AI_WORKFLOW,
  type JiraWorkflowRequest,
  ensureProjectAiWorkflow,
} from "../src/jira/workflow-provisioning.js";

function harness(
  options: { existing?: boolean; editable?: boolean; pending?: boolean; denied?: boolean } = {},
) {
  const names = options.existing ? ["To Do", ...Object.values(DEFAULT_AI_WORKFLOW)] : ["To Do"];
  let statuses = names.map((name, index) => ({
    id: String(index + 1),
    statusReference: String(index + 1),
    name,
    statusCategory: name === "Done" ? "DONE" : "TODO",
  }));
  let workflow = {
    id: "workflow-1",
    name: "Project workflow",
    isEditable: options.editable !== false,
    scope: { type: "PROJECT", project: { id: "10000" } },
    version: { id: "version-1", versionNumber: 7 },
    statuses: statuses.map((status) => ({ statusReference: status.id, properties: {} })),
    transitions: [
      {
        id: "1",
        type: "INITIAL",
        name: "Create",
        toStatusReference: "1",
        validators: [{ ruleKey: "original-validator" }],
      },
    ],
  };
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const request: JiraWorkflowRequest = async <T>(
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: unknown,
  ): Promise<T> => {
    calls.push({ method, path, body });
    if (options.denied) throw new Error("Jira project administration permission required");
    if (path.startsWith("/rest/api/3/project/"))
      return { id: "10000", issueTypes: [{ id: "task" }, { id: "subtask" }] } as T;
    if (path === "/rest/api/3/workflows")
      return structuredClone({ statuses, workflows: [workflow] }) as T;
    if (path === "/rest/api/3/status") return [] as T;
    if (path.endsWith("/validation")) return { errors: [] } as T;
    if (path === "/rest/api/3/workflows/update") {
      if (!options.pending) {
        const payload = body as { statuses: typeof statuses; workflows: Array<typeof workflow> };
        statuses = payload.statuses.map((status, index) => ({
          ...status,
          id: status.id ?? String(index + 1),
        }));
        workflow = { ...workflow, ...payload.workflows[0] };
      }
      return { taskId: "task-1" } as T;
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  };
  return { request, calls };
}
describe("initial Jira AI workflow provisioning", () => {
  it("adds missing states to Task and Subtask workflows and preserves existing rules and versions", async () => {
    const mock = harness();
    const result = await ensureProjectAiWorkflow(mock.request, "KAN");
    expect(result.complete).toBe(true);
    expect(result.added).toEqual(Object.values(DEFAULT_AI_WORKFLOW));
    expect(result.messages.join(" ")).toContain("자동 추가");
    const update = mock.calls.find((call) => call.path === "/rest/api/3/workflows/update");
    expect(update?.body).toMatchObject({
      workflows: [
        {
          version: { versionNumber: 7 },
          transitions: expect.arrayContaining([
            expect.objectContaining({ validators: [{ ruleKey: "original-validator" }] }),
          ]),
        },
      ],
    });
    expect(mock.calls.find((call) => call.path === "/rest/api/3/workflows")?.body).toEqual({
      projectAndIssueTypes: [
        { projectId: "10000", issueTypeId: "task" },
        { projectId: "10000", issueTypeId: "subtask" },
      ],
    });
  });
  it("is idempotent when the required states are already available", async () => {
    const mock = harness({ existing: true });
    expect((await ensureProjectAiWorkflow(mock.request, "KAN")).added).toEqual([]);
    expect(mock.calls.some((call) => call.path.endsWith("/update"))).toBe(false);
  });
  it("does not create duplicates on a second connection", async () => {
    const mock = harness();
    await ensureProjectAiWorkflow(mock.request, "KAN");
    expect((await ensureProjectAiWorkflow(mock.request, "KAN")).added).toEqual([]);
    expect(mock.calls.filter((call) => call.path.endsWith("/update"))).toHaveLength(1);
  });
  it("returns an explicit pending message rather than claiming setup is complete", async () => {
    const result = await ensureProjectAiWorkflow(harness({ pending: true }).request, "KAN");
    expect(result.complete).toBe(false);
    expect(result.messages.join(" ")).toContain("적용 중");
  });
  it("explains permissions and makes no update when workflow editing is unavailable", async () => {
    const mock = harness({ editable: false });
    await expect(ensureProjectAiWorkflow(mock.request, "KAN")).rejects.toThrow("편집 권한");
    expect(mock.calls.some((call) => call.path.endsWith("/update"))).toBe(false);
  });
});
