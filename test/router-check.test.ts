import { describe, expect, it } from "vitest";
import { FakeJiraGateway } from "../src/jira/fake.js";
import { runRouterCheck } from "../src/router/check.js";
import {
  buildRouterConfig,
  IN_PROGRESS_STATUS,
  PLANNING_STATUS,
  REQUEST_STATUS,
  REVIEW_STATUS,
  workerPolicy,
} from "./helpers/router-fixtures.js";

function jiraWithProject(statuses: string[]): FakeJiraGateway {
  const jira = new FakeJiraGateway();
  jira.setSelf({ accountId: "router-bot", displayName: "Router Bot", emailAddress: null });
  jira.seedProject({
    key: "KAN",
    name: "Kanban",
    issueTypes: [
      { name: "Task", subtask: false },
      { name: "Sub-task", subtask: true },
    ],
  });
  jira.seedProjectStatuses("KAN", statuses);
  return jira;
}

const ALL_STATUSES = ["To Do", REQUEST_STATUS, PLANNING_STATUS, IN_PROGRESS_STATUS, REVIEW_STATUS];

describe("router check", () => {
  const config = buildRouterConfig({ workers: [workerPolicy()] });

  it("passes when every configured status and the subtask type exist", async () => {
    const items = await runRouterCheck(jiraWithProject(ALL_STATUSES), config);
    expect(items.filter((item) => item.level === "fail")).toEqual([]);
    expect(items[0]?.message).toContain("Router Bot");
    // The initial status of new subtasks can't be read over REST; it stays a manual check.
    expect(items.some((item) => item.level === "warn" && item.message.includes("by hand"))).toBe(
      true,
    );
  });

  it("fails on a status the project does not have", async () => {
    const items = await runRouterCheck(
      jiraWithProject(ALL_STATUSES.filter((s) => s !== REVIEW_STATUS)),
      config,
    );
    expect(items).toContainEqual({
      level: "fail",
      message: expect.stringContaining(`reviewStatus "${REVIEW_STATUS}"`),
    });
  });

  it("checks the transitions Router needs on a sample issue", async () => {
    const jira = jiraWithProject(ALL_STATUSES);
    jira.seedIssue({ key: "KAN-1", statusName: REQUEST_STATUS, projectKey: "KAN" }, [
      { id: "1", name: "Start", toStatusName: IN_PROGRESS_STATUS },
    ]);
    jira.seedIssue({ key: "KAN-2", statusName: IN_PROGRESS_STATUS, projectKey: "KAN" }, []);

    const ok = await runRouterCheck(jira, config, { issueKey: "KAN-1" });
    expect(ok).toContainEqual({
      level: "ok",
      message: expect.stringContaining(`→ "${IN_PROGRESS_STATUS}"`),
    });

    const missing = await runRouterCheck(jira, config, { issueKey: "KAN-2" });
    expect(missing).toContainEqual({
      level: "fail",
      message: expect.stringContaining(
        `no transition from "${IN_PROGRESS_STATUS}" to "${REVIEW_STATUS}"`,
      ),
    });
  });

  it("stops at authentication when Jira rejects the credentials", async () => {
    const jira = jiraWithProject(ALL_STATUSES);
    jira.getMyself = async () => {
      throw new Error("401 Unauthorized");
    };
    const items = await runRouterCheck(jira, config);
    expect(items).toEqual([
      { level: "fail", message: "Jira authentication failed: 401 Unauthorized" },
    ]);
  });
});
