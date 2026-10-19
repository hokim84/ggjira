import { afterEach, describe, expect, it, vi } from "vitest";
import { renderSections } from "../src/issue/description.js";
import { JiraApiError } from "../src/jira/client.js";
import { listAudit } from "../src/router/db/audit.js";
import { getOpenJobForIssue } from "../src/router/db/jobs.js";
import type { IssueOptInView, SetOptInResult } from "../src/router/issue-opt-in.js";
import {
  issueDescription,
  LABEL_IN_PROGRESS_STATUS,
  LABEL_TRANSITIONS,
  labelWorkspace,
  OPT_IN_LABEL,
  testWorkspace,
  TODO_STATUS,
} from "./helpers/router-fixtures.js";
import { RouterHarness } from "./helpers/router-harness.js";

const OPT_IN = "/issues/KAN-1/opt-in";

/** M4-03 (ADR 0039): turning one issue's AI participation on or off through the admin API. */
describe("issue opt-in admin API", () => {
  let router: RouterHarness;

  afterEach(async () => {
    await router.close();
  });

  function start(workspace = labelWorkspace): void {
    router = new RouterHarness({ config: { workspaces: [workspace] } });
  }

  function seed(
    opts: {
      labels?: string[];
      statusName?: string;
      assignee?: string | null;
      description?: string;
      isSubtask?: boolean;
    } = {},
  ): void {
    router.jira.seedIssue(
      {
        key: "KAN-1",
        summary: "Work on KAN-1",
        statusName: opts.statusName ?? TODO_STATUS,
        projectKey: "KAN",
        assigneeAccountId: opts.assignee === undefined ? "user-1" : opts.assignee,
        labels: opts.labels ?? [],
        description: opts.description ?? issueDescription(),
        ...(opts.isSubtask ? { isSubtask: true } : {}),
      },
      LABEL_TRANSITIONS,
    );
  }

  async function show(): Promise<IssueOptInView> {
    const response = await router.adminCall("GET", OPT_IN);
    expect(response.statusCode).toBe(200);
    return response.json() as IssueOptInView;
  }

  function put(enabled: boolean) {
    return router.adminCall("PUT", OPT_IN, { enabled });
  }

  function audit() {
    return listAudit(router.db, "KAN-1");
  }

  it("adds only the opt-in label, keeps the others, and the next pass starts the issue (T01, T10)", async () => {
    start();
    seed({ labels: ["backend", "urgent"] });
    const before = await show();
    expect(before.issueUrl).toBe("https://example.atlassian.net/browse/KAN-1");
    expect(before.blockers.map((b) => b.code)).toEqual(["opt_in_missing"]);

    const response = await put(true);
    expect(response.statusCode).toBe(200);
    const result = response.json() as SetOptInResult;
    expect(result).toMatchObject({ outcome: "changed", confirmedAfterError: false });
    expect(result.view).toMatchObject({ optedIn: true, blockers: [], openJob: null });
    expect((await router.jira.getIssue("KAN-1")).labels).toEqual([
      "backend",
      "urgent",
      OPT_IN_LABEL,
    ]);
    expect(audit()).toEqual([
      expect.objectContaining({
        actor: "admin:tester",
        action: "issue.opt_in.added",
        detail: expect.objectContaining({
          requested: "on",
          authentication: "admin-token",
          label: OPT_IN_LABEL,
          labelsBefore: ["backend", "urgent"],
          labelsAfter: ["backend", "urgent", OPT_IN_LABEL],
        }),
      }),
    ]);

    await router.reconcile();
    expect(getOpenJobForIssue(router.db, "KAN-1")?.state).toBe("queued");
    expect((await show()).openJob).toMatchObject({ kind: "implementation", state: "queued" });
  });

  it("writes nothing when asked for the state the issue is already in", async () => {
    start();
    seed();
    await put(true);
    const again = await put(true);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ outcome: "unchanged" });
    expect(router.jira.labelChanges).toHaveLength(1);
    expect(audit().map((entry) => entry.action)).toEqual([
      "issue.opt_in.added",
      "issue.opt_in.unchanged",
    ]);
  });

  it("removes the label in any case spelling, and the open job is revoked by the next pass (T05)", async () => {
    start();
    seed({ labels: ["backend"] });
    await router.jira.addLabel("KAN-1", "AI-Enabled");
    await router.reconcile();
    const queued = getOpenJobForIssue(router.db, "KAN-1");
    expect(queued?.state).toBe("queued");

    const response = await put(false);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      outcome: "changed",
      view: { optedIn: false, openJob: { jobId: queued?.id } },
    });
    expect((await router.jira.getIssue("KAN-1")).labels).toEqual(["backend"]);
    expect(audit().at(-1)).toMatchObject({
      action: "issue.opt_in.removed",
      detail: { openJob: { jobId: queued?.id, state: "queued" } },
    });

    const report = await router.reconcile();
    expect(report.jobsCancelled).toEqual([queued?.id]);
  });

  it("explains why an opted-in issue would not start", async () => {
    start();
    seed({ labels: [OPT_IN_LABEL], statusName: LABEL_IN_PROGRESS_STATUS, assignee: null });
    expect((await show()).blockers.map((b) => b.code)).toEqual(["not_requested", "no_assignee"]);

    router.jira.seedIssue(
      {
        key: "KAN-1",
        summary: "Subtask without a contract",
        statusName: TODO_STATUS,
        projectKey: "KAN",
        assigneeAccountId: "user-1",
        labels: [OPT_IN_LABEL],
        isSubtask: true,
        description: renderSections([{ heading: "Required Capabilities", items: ["programming"] }]),
      },
      LABEL_TRANSITIONS,
    );
    await router.reconcile();
    const view = await show();
    expect(view.openJob).toBeNull();
    expect(view.blockers).toEqual([
      expect.objectContaining({
        code: "readiness_hold",
        missing: ["acceptance", "verification"],
      }),
    ]);
  });

  it("shows an admin-cancelled approval until the label is added again", async () => {
    start();
    seed();
    await put(true);
    await router.reconcile();
    const job = getOpenJobForIssue(router.db, "KAN-1");
    expect((await router.adminCall("POST", `/jobs/${job?.id}/cancel`)).statusCode).toBe(200);
    expect((await show()).blockers.map((b) => b.code)).toEqual(["approval_held"]);

    await put(false);
    await put(true);
    expect((await show()).blockers).toEqual([]);
  });

  it("refuses legacy workspaces, foreign projects and malformed keys before touching Jira", async () => {
    start(testWorkspace);
    seed();
    const getIssue = vi.spyOn(router.jira, "getIssue");
    expect((await show()).blockers.map((b) => b.code)).toEqual(["not_label_mode"]);
    const legacy = await put(true);
    expect(legacy.statusCode).toBe(409);
    expect(legacy.json()).toMatchObject({ error: "not_label_mode" });

    getIssue.mockClear();
    const foreign = await router.adminCall("PUT", "/issues/OTHER-1/opt-in", { enabled: true });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toMatchObject({ error: "unknown_project" });
    const malformed = await router.adminCall("GET", "/issues/kan-1;drop/opt-in");
    expect(malformed.statusCode).toBe(400);
    expect(getIssue).not.toHaveBeenCalled();
    expect(router.jira.labelChanges).toEqual([]);
  });

  it("refuses an issue that moved to a project outside the workspace", async () => {
    start();
    seed();
    vi.spyOn(router.jira, "getIssue").mockResolvedValue({
      ...(await router.jira.getIssue("KAN-1")),
      key: "OTHER-9",
      projectKey: "OTHER",
    });
    const response = await put(true);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "unknown_project" });
    expect(router.jira.labelChanges).toEqual([]);
  });

  it("tells a missing issue, a permission error and a rate limit apart (T09)", async () => {
    start();
    seed();
    const getIssue = vi.spyOn(router.jira, "getIssue");
    getIssue.mockRejectedValueOnce(new JiraApiError("not found", 404, "/issue/KAN-1"));
    const missing = await put(true);
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: "unknown_issue" });

    vi.spyOn(router.jira, "addLabel").mockRejectedValueOnce(
      new JiraApiError("forbidden", 403, "/issue/KAN-1"),
    );
    const forbidden = await put(true);
    expect(forbidden.statusCode).toBe(502);
    expect(forbidden.json()).toMatchObject({ error: "jira_forbidden" });

    vi.spyOn(router.jira, "addLabel").mockRejectedValueOnce(
      new JiraApiError("slow down", 429, "/issue/KAN-1"),
    );
    const limited = await put(true);
    expect(limited.json()).toMatchObject({ error: "jira_rate_limited" });

    expect(
      audit().map((entry) => [entry.action, (entry.detail as { error: string }).error]),
    ).toEqual([
      ["issue.opt_in.failed", "unknown_issue"],
      ["issue.opt_in.failed", "jira_forbidden"],
      ["issue.opt_in.failed", "jira_rate_limited"],
    ]);
  });

  it("settles an unclear write by re-reading, and never reports an unconfirmed change as done (T09)", async () => {
    start();
    seed();
    const realAdd = router.jira.addLabel.bind(router.jira);
    const addLabel = vi.spyOn(router.jira, "addLabel");
    addLabel.mockImplementationOnce(async () => {
      throw new JiraApiError("bad gateway", 502, "/issue/KAN-1");
    });
    const lost = await put(true);
    expect(lost.statusCode).toBe(502);
    expect(lost.json()).toMatchObject({ error: "unconfirmed" });
    expect(audit().at(-1)).toMatchObject({
      action: "issue.opt_in.failed",
      detail: { error: "unconfirmed" },
    });

    addLabel.mockImplementationOnce(async (key, label) => {
      await realAdd(key, label);
      throw new TypeError("fetch failed");
    });
    const applied = await put(true);
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toMatchObject({ outcome: "changed", confirmedAfterError: true });
    expect(audit().at(-1)).toMatchObject({
      action: "issue.opt_in.added",
      detail: { confirmedAfterError: true },
    });
  });
});
