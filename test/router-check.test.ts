import { describe, expect, it } from "vitest";
import { FakeJiraGateway } from "../src/jira/fake.js";
import {
  checkGithubRepositories,
  githubRepositoriesToCheck,
  runRouterCheck,
} from "../src/router/check.js";
import {
  buildRouterConfig,
  DONE_STATUS,
  IN_PROGRESS_STATUS,
  PLAN_REVIEW_STATUS,
  REQUEST_STATUS,
  REVIEW_STATUS,
  TODO_STATUS,
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

const ALL_STATUSES = [
  TODO_STATUS,
  REQUEST_STATUS,
  PLAN_REVIEW_STATUS,
  IN_PROGRESS_STATUS,
  REVIEW_STATUS,
  DONE_STATUS,
];

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
      { id: "1", name: "Planned", toStatusName: PLAN_REVIEW_STATUS },
    ]);
    jira.seedIssue({ key: "KAN-2", statusName: IN_PROGRESS_STATUS, projectKey: "KAN" }, []);

    const ok = await runRouterCheck(jira, config, { issueKey: "KAN-1" });
    expect(ok).toContainEqual({
      level: "ok",
      message: expect.stringContaining(`→ "${PLAN_REVIEW_STATUS}"`),
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

describe("router check: GitHub", () => {
  it("lists the repositories Router follows pull requests in", () => {
    const config = buildRouterConfig({ workers: [workerPolicy()] });
    const withClone = {
      ...config,
      repositories: [
        { id: "a", cloneUrl: "https://github.com/Acme/App.git" },
        { id: "b", cloneUrl: "https://gitlab.com/acme/other.git" },
      ],
    };
    expect(githubRepositoriesToCheck(withClone, ["acme/app", "Acme/Tools"])).toEqual([
      "acme/app",
      "acme/tools",
    ]);
  });

  it("says what to do when GitHub will not show the pull requests", async () => {
    const requests: string[] = [];
    const answers: Record<string, number> = { "acme/public": 200, "acme/private": 404 };
    const fetch = async (url: string, init: RequestInit) => {
      requests.push(`${url} ${(init.headers as Record<string, string>).authorization ?? "-"}`);
      const repo = url.split("/repos/")[1]?.split("/pulls")[0] ?? "";
      return new Response("[]", { status: answers[repo] ?? 500 });
    };

    const anonymous = await checkGithubRepositories({
      repos: ["acme/public", "acme/private"],
      fetch,
    });
    expect(anonymous).toEqual([
      { level: "ok", message: "GitHub acme/public: pull requests are readable without a token" },
      {
        level: "fail",
        message: expect.stringContaining(
          "acme/private: not visible without a token; a private repository needs GITHUB_TOKEN",
        ),
      },
    ]);
    expect(requests[0]).toBe(
      "https://api.github.com/repos/acme/public/pulls?state=all&per_page=1 -",
    );

    const withToken = await checkGithubRepositories({ repos: ["acme/private"], token: "t", fetch });
    expect(withToken[0]?.message).toMatch(/GITHUB_TOKEN cannot see this repository/);
    answers["acme/private"] = 401;
    const expired = await checkGithubRepositories({ repos: ["acme/private"], token: "t", fetch });
    expect(expired[0]).toEqual({
      level: "fail",
      message: "GitHub acme/private: GITHUB_TOKEN is invalid or expired",
    });
  });

  it("runs as part of router check", async () => {
    const jira = jiraWithProject(ALL_STATUSES);
    const config = buildRouterConfig({ workers: [workerPolicy()] });
    const items = await runRouterCheck(jira, config, {
      github: { repos: ["acme/app"], fetch: async () => new Response("[]", { status: 404 }) },
    });
    expect(items.at(-1)).toMatchObject({
      level: "fail",
      message: expect.stringContaining("GitHub acme/app:"),
    });
  });
});
