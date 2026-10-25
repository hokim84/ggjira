import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJob } from "../src/router/db/jobs.js";
import { recordResult } from "../src/router/db/results.js";
import { RouterHarness } from "./helpers/router-harness.js";

describe("dashboard task overview", () => {
  let router: RouterHarness;
  beforeEach(() => {
    router = new RouterHarness();
  });
  afterEach(async () => router.close());
  it("requires admin access, validates pagination and stays local when Jira is unavailable", async () => {
    await router.seedQueuedJob("KAN-1");
    const old = router.db
      .prepare(
        "SELECT id FROM jobs WHERE issue_key='KAN-1' ORDER BY created_at DESC,rowid DESC LIMIT 1",
      )
      .get() as {
      id: string;
    };
    router.db.prepare("UPDATE jobs SET state='succeeded' WHERE id=?").run(old.id);
    router.clock.advance(1000);
    createJob(router.db, {
      id: "new-run",
      issueKey: "KAN-1",
      workspaceId: "ws1",
      repositoryId: "repo1",
      kind: "implementation",
      approvalId: "next",
      now: router.clock.now(),
    });
    createJob(router.db, {
      id: "other",
      issueKey: "KAN-2",
      workspaceId: "ws1",
      repositoryId: "repo1",
      kind: "planning",
      approvalId: "other",
      state: "succeeded",
      now: router.clock.now(),
    });
    const getIssue = vi.spyOn(router.jira, "getIssue").mockRejectedValue(new Error("Jira offline"));
    const jobsBefore = router.db.prepare("SELECT COUNT(*) n FROM jobs").get();
    expect(
      (await router.app.inject({ method: "GET", url: "/api/v1/admin/tasks" })).statusCode,
    ).toBe(401);
    for (const query of ["?offset=-1", "?limit=0", "?limit=1000", "?offset=Infinity"])
      expect((await router.adminCall("GET", `/tasks${query}`)).statusCode).toBe(400);
    const response = await router.adminCall("GET", "/tasks?limit=1");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      total: 2,
      items: [{ issueKey: "KAN-1", state: "queued" }],
    });
    expect(
      (await router.adminCall("GET", "/tasks?offset=1&limit=1")).json().items[0].issueKey,
    ).toBe("KAN-2");
    expect(getIssue).not.toHaveBeenCalled();
    expect(router.jira.comments).toEqual([]);
    expect(router.db.prepare("SELECT COUNT(*) n FROM jobs").get()).toEqual(jobsBefore);
  });
  it("shows only the latest job's applied result in task detail", async () => {
    await router.seedQueuedJob("KAN-1");
    const { id } = router.db
      .prepare(
        "SELECT id FROM jobs WHERE issue_key='KAN-1' ORDER BY created_at DESC,rowid DESC LIMIT 1",
      )
      .get() as {
      id: string;
    };
    recordResult(router.db, {
      resultId: "good",
      jobId: id,
      attemptId: "old",
      payload: JSON.stringify({
        summary: "verified result",
        pullRequest: { url: "https://github.com/org/repo/pull/1", number: 1 },
      }),
      applied: true,
      now: router.clock.now(),
    });
    router.clock.advance(1000);
    recordResult(router.db, {
      resultId: "late",
      jobId: id,
      attemptId: "old",
      payload: JSON.stringify({ summary: "late rejected result" }),
      applied: false,
      now: router.clock.now(),
    });
    expect((await router.adminCall("GET", "/issues/KAN-1")).json().latestResult.summary).toBe(
      "verified result",
    );
    router.db.prepare("UPDATE jobs SET state='succeeded' WHERE id=?").run(id);
    router.clock.advance(1000);
    createJob(router.db, {
      id: "new",
      issueKey: "KAN-1",
      workspaceId: "ws1",
      repositoryId: "repo1",
      kind: "implementation",
      approvalId: "new",
      now: router.clock.now(),
    });
    expect((await router.adminCall("GET", "/issues/KAN-1")).json().latestResult).toBeNull();
  });
});
