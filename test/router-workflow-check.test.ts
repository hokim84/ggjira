import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeJiraGateway } from "../src/jira/fake.js";
import { runRouterCheck } from "../src/router/check.js";
import {
  checkWorkflowHops,
  inspectProjectWorkflow,
  routerWorkflowHops,
} from "../src/router/workflow-check.js";
import { buildRouterConfig, workerPolicy } from "./helpers/router-fixtures.js";
import { RouterHarness } from "./helpers/router-harness.js";

const WORKFLOW = {
  requestStatus: "AI 작업 요청",
  inProgressStatus: "AI 작업 중",
  reviewStatus: "AI 작업 완료(리뷰)",
};
const STATUSES = ["해야 할 일", "AI 작업 요청", "AI 작업 중", "AI 작업 완료(리뷰)", "완료"];

function seededJira(): FakeJiraGateway {
  const jira = new FakeJiraGateway();
  jira.seedProject({
    key: "KAN",
    name: "Kanban",
    issueTypes: [
      { name: "작업", subtask: false },
      { name: "하위 작업", subtask: true },
    ],
  });
  jira.seedProjectStatuses("KAN", STATUSES);
  return jira;
}

describe("routerWorkflowHops", () => {
  it("lists only the moves Router makes, including optional planning/decision ones", () => {
    expect(routerWorkflowHops(WORKFLOW).map((hop) => `${hop.from}→${hop.to}`)).toEqual([
      "AI 작업 요청→AI 작업 중",
      "AI 작업 중→AI 작업 완료(리뷰)",
    ]);
    const withPlanning = routerWorkflowHops({
      ...WORKFLOW,
      planningStatus: "계획 요청",
      needsDecisionStatus: "결정 대기",
    });
    expect(withPlanning.map((hop) => hop.label)).toEqual([
      "작업 시작",
      "계획 시작",
      "작업 완료",
      "결정 요청(계획)",
    ]);
  });
});

describe("checkWorkflowHops", () => {
  it("confirms each hop on an issue in its source status", async () => {
    const jira = seededJira();
    jira.seedIssue({ key: "KAN-1", statusName: "AI 작업 요청", projectKey: "KAN" }, [
      { id: "1", name: "시작", toStatusName: "AI 작업 중" },
    ]);
    jira.seedIssue({ key: "KAN-2", statusName: "AI 작업 중", projectKey: "KAN" }, [
      { id: "2", name: "리뷰", toStatusName: "AI 작업 완료(리뷰)" },
    ]);
    const hops = await checkWorkflowHops(jira, "KAN", WORKFLOW);
    expect(hops.map((hop) => [hop.state, hop.state === "ok" ? hop.sampleIssue : null])).toEqual([
      ["ok", "KAN-1"],
      ["ok", "KAN-2"],
    ]);
  });

  it("reports a missing transition with what is reachable instead", async () => {
    const jira = seededJira();
    jira.seedIssue({ key: "KAN-1", statusName: "AI 작업 요청", projectKey: "KAN" }, [
      { id: "1", name: "다른 곳", toStatusName: "완료" },
    ]);
    const [start] = await checkWorkflowHops(jira, "KAN", WORKFLOW);
    expect(start).toMatchObject({ state: "missing", sampleIssue: "KAN-1", reachable: ["완료"] });
  });

  it("cannot verify a hop when no issue sits in its source status or a status is unknown", async () => {
    const jira = seededJira();
    const hops = await checkWorkflowHops(jira, "KAN", { ...WORKFLOW, reviewStatus: "없는 상태" });
    expect(hops[0]).toMatchObject({
      state: "unknown",
      reason: expect.stringContaining("이슈가 없어"),
    });
    expect(hops[1]).toMatchObject({
      state: "unknown",
      reason: expect.stringContaining("없는 상태"),
    });
  });

  it("reads the project's statuses and subtask issue types", async () => {
    expect(await inspectProjectWorkflow(seededJira(), "KAN")).toEqual({
      statuses: STATUSES,
      subtaskIssueTypes: ["하위 작업"],
    });
  });

  it("feeds router check with per-hop results", async () => {
    const jira = seededJira();
    jira.setSelf({ accountId: "bot", displayName: "Bot", emailAddress: null });
    jira.seedIssue({ key: "KAN-2", statusName: "AI 작업 중", projectKey: "KAN" }, []);
    const config = buildRouterConfig({
      workspaces: [
        { id: "default", repositoryId: "repo1", projectKeys: ["KAN"], workflow: WORKFLOW },
      ],
      workers: [workerPolicy()],
    });
    const items = await runRouterCheck(jira, config);
    expect(items).toContainEqual({
      level: "fail",
      message: expect.stringContaining('no transition "AI 작업 중" → "AI 작업 완료(리뷰)"'),
    });
    expect(items).toContainEqual({
      level: "warn",
      message: expect.stringContaining('"AI 작업 요청" → "AI 작업 중"'),
    });
  });
});

describe("admin Jira workflow API", () => {
  let dir: string;
  let router: RouterHarness;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ggjira-workflow-api-"));
    const configPath = path.join(dir, "router.config.json");
    router = new RouterHarness({ configPath });
    writeFileSync(configPath, JSON.stringify(router.config));
    router.jira.seedProject({
      key: "KAN",
      name: "Kanban",
      issueTypes: [{ name: "하위 작업", subtask: true }],
    });
    router.jira.seedProjectStatuses("KAN", STATUSES);
  });

  afterEach(async () => {
    await router.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns project statuses and checks an unsaved status mapping", async () => {
    const info = await router.adminCall("POST", "/jira/project", { projectKey: "KAN" });
    expect(info.statusCode).toBe(200);
    expect(info.json()).toEqual({ statuses: STATUSES, subtaskIssueTypes: ["하위 작업"] });

    router.jira.seedIssue({ key: "KAN-9", statusName: "AI 작업 요청", projectKey: "KAN" }, [
      { id: "1", name: "시작", toStatusName: "AI 작업 중" },
    ]);
    const check = await router.adminCall("POST", "/jira/workflow-check", {
      projectKey: "KAN",
      workflow: WORKFLOW,
    });
    expect(check.statusCode).toBe(200);
    const { hops } = check.json() as { hops: Array<{ state: string }> };
    expect(hops.map((hop) => hop.state)).toEqual(["ok", "unknown"]);
  });

  it("maps Jira failures to 502 and needs the admin token", async () => {
    const failed = await router.adminCall("POST", "/jira/project", { projectKey: "NOPE" });
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toMatchObject({ error: "jira_error" });
    const anonymous = await router.app.inject({
      method: "POST",
      url: "/api/v1/admin/jira/project",
      payload: { projectKey: "KAN" },
    });
    expect(anonymous.statusCode).toBe(401);
  });
});
