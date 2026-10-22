import { afterEach, describe, expect, it } from "vitest";
import { FakeJiraGateway } from "../src/jira/fake.js";
import {
  checkWorkflowHops,
  inspectProjectWorkflow,
  routerWorkflowHops,
} from "../src/router/workflow-check.js";
import { testWorkspace } from "./helpers/router-fixtures.js";
import { RouterHarness } from "./helpers/router-harness.js";

const WORKFLOW = testWorkspace.workflow;
const STATUSES = Object.values(WORKFLOW);
function seededJira(samples = true) {
  const jira = new FakeJiraGateway();
  jira.seedProject({
    key: "KAN",
    name: "Test",
    issueTypes: [
      { name: "Task", subtask: false },
      { name: "Subtask", subtask: true },
    ],
  });
  jira.seedProjectStatuses("KAN", STATUSES);
  if (samples)
    STATUSES.forEach((status, index) =>
      jira.seedIssue(
        { key: `KAN-${index + 1}`, statusName: status },
        STATUSES.map((to, i) => ({ id: String(i), name: to, toStatusName: to })),
      ),
    );
  return jira;
}
describe("board workflow transition inspection", () => {
  it("checks automatic planning, integration completion and manual review/Done separately", () => {
    const hops = routerWorkflowHops(WORKFLOW);
    expect(hops).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: WORKFLOW.requestStatus,
          to: WORKFLOW.planningInProgressStatus,
        }),
        expect.objectContaining({
          from: WORKFLOW.inProgressStatus,
          to: WORKFLOW.integrationPendingStatus,
        }),
        expect.objectContaining({
          from: WORKFLOW.integrationPendingStatus,
          to: WORKFLOW.implementationCompleteStatus,
        }),
        expect.objectContaining({
          from: WORKFLOW.implementationCompleteStatus,
          to: WORKFLOW.doneStatus,
        }),
        expect.objectContaining({ from: WORKFLOW.reviewStatus, to: WORKFLOW.doneStatus }),
      ]),
    );
    expect(
      hops.some(
        (hop) => hop.from === WORKFLOW.integrationPendingStatus && hop.to === WORKFLOW.doneStatus,
      ),
    ).toBe(false);
  });
  it("verifies transitions using issues in each source status", async () => {
    const hops = await checkWorkflowHops(seededJira(), "KAN", WORKFLOW);
    expect(hops.every((hop) => hop.state === "ok" && hop.sampleIssue)).toBe(true);
  });
  it("reports a missing transition with the actual reachable statuses", async () => {
    const jira = seededJira();
    jira.seedIssue({ key: "KAN-1", statusName: WORKFLOW.requestStatus }, []);
    expect((await checkWorkflowHops(jira, "KAN", WORKFLOW))[0]).toMatchObject({
      state: "missing",
      sampleIssue: "KAN-1",
      reachable: [],
    });
  });
  it("reports unknown when no issue is available to inspect", async () => {
    const hops = await checkWorkflowHops(seededJira(false), "KAN", WORKFLOW);
    expect(hops.every((hop) => hop.state === "unknown")).toBe(true);
  });
  it("reports statuses and actual subtask types", async () => {
    expect(await inspectProjectWorkflow(seededJira(), "KAN")).toEqual({
      statuses: STATUSES,
      subtaskIssueTypes: ["Subtask"],
    });
  });
  let router: RouterHarness | undefined;
  afterEach(async () => {
    await router?.close();
  });
  it("validates all seven mapping fields through the admin API", async () => {
    router = new RouterHarness();
    router.jira.seedProjectStatuses("KAN", STATUSES);
    const response = await router.adminCall("POST", "/jira/workflow-check", {
      projectKey: "KAN",
      workflow: WORKFLOW,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().hops.every((hop: { state: string }) => hop.state === "unknown")).toBe(
      true,
    );
    const { integrationPendingStatus: _missing, ...incomplete } = WORKFLOW;
    expect(
      (
        await router.adminCall("POST", "/jira/workflow-check", {
          projectKey: "KAN",
          workflow: incomplete,
        })
      ).statusCode,
    ).toBe(400);
  });
});
