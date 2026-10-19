import { insertReportBatch, listBatchReportSteps } from "../src/router/db/report-steps.js";
import { processReportJournal } from "../src/router/report-processor.js";
import { expect, it } from "vitest";
import { FakeJiraGateway } from "../src/jira/fake.js";
import { computeApprovalId } from "../src/router/approval.js";
import { buildWorkspaceJql, findWorkspaceCandidates } from "../src/router/candidates.js";
import { RouterConfigSchema } from "../src/router/config.js";
import {
  DELEGATION_REQUEST_STATUS,
  DELEGATION_TRANSITIONS,
  buildRouterConfig,
  delegationWorkspace,
} from "./helpers/router-fixtures.js";
import { RouterHarness } from "./helpers/router-harness.js";

it("rejects removed label mode and stale opt-in keys in every supported mode", () => {
  for (const workflow of [
    { ...delegationWorkspace.workflow, mode: "label", optInLabel: "ai-enabled" },
    { ...delegationWorkspace.workflow, optInLabel: "ai-enabled" },
    {
      requestStatus: "Request",
      inProgressStatus: "Progress",
      reviewStatus: "Review",
      optInLabel: "ai-enabled",
    },
  ])
    expect(
      RouterConfigSchema.safeParse(
        buildRouterConfig({
          workspaces: [
            { ...delegationWorkspace, workflow: workflow as typeof delegationWorkspace.workflow },
          ],
        }),
      ).success,
    ).toBe(false);
});

it("ignores arbitrary labels for candidates and request approval IDs", async () => {
  const jira = new FakeJiraGateway();
  jira.seedIssue(
    { key: "KAN-1", statusName: DELEGATION_REQUEST_STATUS, projectKey: "KAN" },
    DELEGATION_TRANSITIONS,
  );
  jira.seedIssue(
    { key: "KAN-2", statusName: "할 일", projectKey: "KAN", labels: ["ai-enabled"] },
    DELEGATION_TRANSITIONS,
  );
  expect(buildWorkspaceJql(delegationWorkspace)).not.toContain("labels");
  const before = await computeApprovalId(
    jira,
    await jira.getIssue("KAN-1"),
    DELEGATION_REQUEST_STATUS,
  );
  await jira.addLabel("KAN-1", "ai-enabled");
  await jira.removeLabel("KAN-1", "ai-enabled");
  await jira.addLabel("KAN-1", "other");
  expect(
    await computeApprovalId(jira, await jira.getIssue("KAN-1"), DELEGATION_REQUEST_STATUS),
  ).toBe(before);
  expect((await findWorkspaceCandidates(jira, delegationWorkspace)).map((i) => i.key)).toEqual([
    "KAN-1",
  ]);
});

it("keeps read-only issue diagnostics and removes opt-in and label migration endpoints", async () => {
  const router = new RouterHarness();
  router.jira.seedIssue({ key: "KAN-1", projectKey: "KAN", statusName: "Backlog" });
  try {
    const view = await router.adminCall("GET", "/issues/KAN-1");
    expect(view.statusCode).toBe(200);
    expect(view.json()).not.toHaveProperty("optInLabel");
    expect(view.json()).not.toHaveProperty("optedIn");
    expect(view.json().blockers).toContainEqual(expect.objectContaining({ code: "not_requested" }));
    expect(
      (await router.app.inject({ method: "GET", url: "/api/v1/admin/issues/KAN-1" })).statusCode,
    ).toBe(401);
    for (const [method, url] of [
      ["GET", "/issues/KAN-1/opt-in"],
      ["PUT", "/issues/KAN-1/opt-in"],
      ["POST", "/migrations/label/plan"],
      ["POST", "/migrations/label/apply"],
    ] as const) {
      expect(
        (await router.adminCall(method, url, method === "GET" ? undefined : {})).statusCode,
      ).toBe(404);
    }
    expect((await router.adminCall("GET", "/issues/OTHER-1")).statusCode).toBe(404);
    expect((await router.adminCall("GET", "/issues/bad")).statusCode).toBe(400);
    expect(await router.jira.getIssueChangelog("KAN-1")).toEqual([]);
  } finally {
    await router.close();
  }
});

it("never replays a pending transition authorized under the removed label rules", async () => {
  const router = new RouterHarness();
  try {
    await router.seedQueuedJob("KAN-1");
    const worker = await router.connectWorker("worker-1");
    const job = (await router.next(worker, "obsolete-transition-test")).json();
    insertReportBatch(router.db, {
      batchId: "obsolete-label-transition",
      jobId: job.jobId,
      attemptId: job.attemptId,
      issueKey: "KAN-1",
      now: router.clock.now(),
      steps: [
        {
          kind: "transition",
          params: {
            to: "작업 중",
            from: ["AI 작업 요청"],
            approvalStatus: "AI 작업 요청",
            approvalId: job.approvalId,
            optInLabel: "ai-enabled",
          },
        },
      ],
    });
    await processReportJournal({ db: router.db, jira: router.jira, now: router.clock.now });
    expect(listBatchReportSteps(router.db, "obsolete-label-transition")[0]).toMatchObject({
      status: "skipped",
    });
    expect((await router.jira.getIssue("KAN-1")).statusName).toBe("AI 작업 요청");
  } finally {
    await router.close();
  }
});
