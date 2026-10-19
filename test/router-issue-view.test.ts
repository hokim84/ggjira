import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JiraApiError } from "../src/jira/client.js";
import { getOpenJobForIssue } from "../src/router/db/jobs.js";
import type { IssueView } from "../src/router/issue-view.js";
import { IN_PROGRESS_STATUS, REQUEST_STATUS, issueDescription } from "./helpers/router-fixtures.js";
import { RouterHarness } from "./helpers/router-harness.js";

const TRANSITIONS = ["To Do", REQUEST_STATUS, IN_PROGRESS_STATUS].map((status) => ({
  id: `t-${status}`,
  name: `To ${status}`,
  toStatusName: status,
}));

/** `GET /api/v1/admin/issues/:key` (ADR 0046): read-only, and never reaches outside the workspace. */
describe("issue view admin API", () => {
  let router: RouterHarness;

  beforeEach(() => {
    router = new RouterHarness();
  });

  afterEach(async () => {
    await router.close();
  });

  function seed(
    opts: { statusName?: string; assignee?: string | null; description?: string } = {},
  ): void {
    router.jira.seedIssue(
      {
        key: "KAN-1",
        summary: "Work on KAN-1",
        statusName: opts.statusName ?? REQUEST_STATUS,
        projectKey: "KAN",
        assigneeAccountId: opts.assignee === undefined ? "user-1" : opts.assignee,
        description: opts.description ?? issueDescription(),
      },
      TRANSITIONS,
    );
  }

  async function show(key = "KAN-1"): Promise<IssueView> {
    const response = await router.adminCall("GET", `/issues/${key}`);
    expect(response.statusCode).toBe(200);
    return response.json() as IssueView;
  }

  it("explains why an issue would not start", async () => {
    seed({ statusName: IN_PROGRESS_STATUS, assignee: null });
    expect((await show()).blockers.map((b) => b.code)).toEqual(["not_requested", "no_assignee"]);

    seed({ description: issueDescription({ acceptance: [], verification: [] }) });
    await router.reconcile();
    const view = await show();
    expect(view.openJob).toBeNull();
    expect(view.blockers).toEqual([
      expect.objectContaining({ code: "readiness_hold", missing: ["acceptance", "verification"] }),
    ]);
  });

  it("shows an admin-cancelled approval until the issue is requested again", async () => {
    seed();
    await router.reconcile();
    const job = getOpenJobForIssue(router.db, "KAN-1");
    expect((await router.adminCall("POST", `/jobs/${job?.id}/cancel`)).statusCode).toBe(200);
    expect((await show()).blockers.map((b) => b.code)).toEqual(["approval_held"]);

    await router.jira.transitionIssueToStatus("KAN-1", "To Do");
    await router.jira.transitionIssueToStatus("KAN-1", REQUEST_STATUS);
    expect((await show()).blockers).toEqual([]);
  });

  it("refuses foreign projects and malformed keys before touching Jira", async () => {
    seed();
    const getIssue = vi.spyOn(router.jira, "getIssue");
    const foreign = await router.adminCall("GET", "/issues/OTHER-1");
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toMatchObject({ error: "unknown_project" });
    expect((await router.adminCall("GET", "/issues/kan-1;drop")).statusCode).toBe(400);
    expect(getIssue).not.toHaveBeenCalled();
  });

  it("refuses an issue that moved to a project outside the workspace", async () => {
    seed();
    vi.spyOn(router.jira, "getIssue").mockResolvedValue({
      ...(await router.jira.getIssue("KAN-1")),
      key: "OTHER-9",
      projectKey: "OTHER",
    });
    const response = await router.adminCall("GET", "/issues/KAN-1");
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "unknown_project" });
  });

  it("tells a missing issue, a permission error and a rate limit apart", async () => {
    seed();
    const getIssue = vi.spyOn(router.jira, "getIssue");
    for (const [status, httpStatus, error] of [
      [404, 404, "unknown_issue"],
      [403, 502, "jira_forbidden"],
      [429, 502, "jira_rate_limited"],
    ] as const) {
      getIssue.mockRejectedValueOnce(new JiraApiError("failed", status, "/issue/KAN-1"));
      const response = await router.adminCall("GET", "/issues/KAN-1");
      expect(response.statusCode).toBe(httpStatus);
      expect(response.json()).toMatchObject({ error });
    }
  });
});
