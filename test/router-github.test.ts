import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JobEnvelope } from "../src/contracts/envelope.js";
import { PROTOCOL_VERSION } from "../src/contracts/protocol.js";
import { listAudit } from "../src/router/db/audit.js";
import { getPullRequest } from "../src/router/db/pull-requests.js";
import {
  parsePullRequestClosed,
  pollErrorMessage,
  pollPullRequests,
} from "../src/router/github.js";
import { processReportJournal } from "../src/router/report-processor.js";
import {
  IN_PROGRESS_STATUS,
  issueDescription,
  REQUEST_STATUS,
  REVIEW_STATUS,
  testWorkspace,
  workerPolicy,
} from "./helpers/router-fixtures.js";
import { type RegisteredWorker, RouterHarness } from "./helpers/router-harness.js";

const SECRET = "github-webhook-secret-0123456789";
const DONE = "완료";
const PR = { repo: "Acme/App", number: 12, url: "https://github.com/Acme/App/pull/12" };

const TRANSITIONS = [
  { id: "t-progress", name: "Start", toStatusName: IN_PROGRESS_STATUS },
  { id: "t-review", name: "Review", toStatusName: REVIEW_STATUS },
  { id: "t-done", name: "Done", toStatusName: DONE },
];

function pullRequestEvent(merged: boolean, overrides: Record<string, unknown> = {}) {
  return {
    action: "closed",
    pull_request: { number: PR.number, merged, merged_by: merged ? { login: "reviewer" } : null },
    repository: { full_name: "acme/app" },
    sender: { login: "reviewer" },
    ...overrides,
  };
}

describe("GitHub pull request → Jira done", () => {
  let router: RouterHarness;
  let worker: RegisteredWorker;

  beforeEach(async () => {
    router = new RouterHarness({
      githubWebhookSecret: SECRET,
      config: {
        workspaces: [
          { ...testWorkspace, workflow: { ...testWorkspace.workflow, doneStatus: DONE } },
        ],
        workers: [workerPolicy({ workerId: "worker-1" })],
      },
    });
    worker = await router.connectWorker("worker-1");
  });

  afterEach(async () => {
    await router.close();
  });

  const process = () =>
    processReportJournal({ db: router.db, jira: router.jira, now: router.clock.now });

  async function status(key: string): Promise<string> {
    return (await router.jira.getIssue(key)).statusName;
  }

  /** Runs KAN-1 to a succeeded result that carries `PR`, and applies its journal. */
  async function finishWithPullRequest(pullRequest: typeof PR | undefined = PR) {
    router.jira.seedIssue(
      {
        key: "KAN-1",
        summary: "Work",
        statusName: REQUEST_STATUS,
        projectKey: "KAN",
        assigneeAccountId: "user-1",
        description: issueDescription(),
      },
      TRANSITIONS,
    );
    router.jira.seedChangelogEntry("KAN-1", {
      id: "KAN-1-approved",
      items: [{ field: "status", fromString: "To Do", toString: REQUEST_STATUS }],
    });
    await router.reconcile();
    const envelope = (await router.next(worker, "req-1")).json() as JobEnvelope;
    const lease = { attemptId: envelope.attemptId, leaseToken: envelope.leaseToken };
    await router.jobCall(worker, envelope.jobId, "start", lease);
    await process();
    const submitted = await router.post(
      `/api/v1/jobs/${envelope.jobId}/result`,
      {
        protocolVersion: PROTOCOL_VERSION,
        jobId: envelope.jobId,
        attemptId: envelope.attemptId,
        resultId: "result-1",
        status: "succeeded",
        summary: "done",
        branch: "ggjira/KAN-1-abc",
        ...(pullRequest ? { pullRequest } : {}),
      },
      worker.token,
    );
    expect(submitted.statusCode).toBe(200);
    await process();
    expect(await status("KAN-1")).toBe(REVIEW_STATUS);
    return envelope;
  }

  function webhook(
    body: unknown,
    opts: { event?: string; delivery?: string; secret?: string } = {},
  ) {
    const payload = JSON.stringify(body);
    const signature = `sha256=${createHmac("sha256", opts.secret ?? SECRET)
      .update(payload)
      .digest("hex")}`;
    return router.app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature,
        "x-github-event": opts.event ?? "pull_request",
        "x-github-delivery": opts.delivery ?? "delivery-1",
      },
      payload,
    });
  }

  it("records the worker's pull request with its issue and job", async () => {
    const envelope = await finishWithPullRequest();
    expect(getPullRequest(router.db, "acme/app", 12)).toMatchObject({
      issueKey: "KAN-1",
      jobId: envelope.jobId,
      state: "open",
      url: PR.url,
    });
  });

  it("moves the issue from review to done when the PR is merged (webhook)", async () => {
    await finishWithPullRequest();
    const response = await webhook(pullRequestEvent(true));
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: "journaled" });

    const pass = await process();
    expect(pass.blocked).toEqual([]);
    expect(await status("KAN-1")).toBe(DONE);
    const comments = router.jira.comments.filter((c) => c.key === "KAN-1").map((c) => c.body);
    expect(comments.at(-1)).toContain("Pull request #12 was merged by reviewer");
    expect(listAudit(router.db, "KAN-1").map((entry) => entry.action)).toContain(
      "pull_request.merged",
    );

    // A replayed delivery and a second event for the same PR change nothing.
    expect((await webhook(pullRequestEvent(true))).json()).toEqual({ status: "duplicate" });
    expect((await webhook(pullRequestEvent(true), { delivery: "delivery-2" })).json()).toEqual({
      status: "already-closed",
    });
  });

  it("only comments when the PR is closed without merging", async () => {
    await finishWithPullRequest();
    await webhook(pullRequestEvent(false));
    await process();
    expect(await status("KAN-1")).toBe(REVIEW_STATUS);
    const comments = router.jira.comments.filter((c) => c.key === "KAN-1").map((c) => c.body);
    expect(comments.at(-1)).toContain("closed without merging");
  });

  it("leaves an issue a human already moved out of review", async () => {
    await finishWithPullRequest();
    router.jira.seedIssue(
      {
        ...(await router.jira.getIssue("KAN-1")),
        statusName: "To Do",
      },
      TRANSITIONS,
    );
    await webhook(pullRequestEvent(true));
    const pass = await process();
    expect(pass.skipped.map((s) => s.reason).join()).toContain("a human moved it");
    expect(await status("KAN-1")).toBe("To Do");
  });

  it("rejects bad signatures and ignores unrelated events and PRs", async () => {
    await finishWithPullRequest();
    expect((await webhook(pullRequestEvent(true), { secret: "x".repeat(20) })).statusCode).toBe(
      401,
    );
    expect((await webhook({ zen: "hi" }, { event: "ping" })).json()).toEqual({ status: "pong" });
    expect((await webhook({ action: "opened" }, { delivery: "d-opened" })).json()).toEqual({
      status: "ignored",
    });
    expect(
      (
        await webhook(pullRequestEvent(true, { pull_request: { number: 999, merged: true } }), {
          delivery: "d-other",
        })
      ).json(),
    ).toEqual({ status: "unknown" });
  });

  it("falls back to polling GitHub for open pull requests", async () => {
    await finishWithPullRequest();
    const requests: string[] = [];
    const report = await pollPullRequests({
      db: router.db,
      config: router.config,
      token: "read-token",
      now: router.clock.now,
      fetch: async (url, init) => {
        requests.push(`${url} ${(init.headers as Record<string, string>).authorization}`);
        return new Response(
          JSON.stringify({ state: "closed", merged: true, merged_by: { login: "lead" } }),
          { status: 200 },
        );
      },
    });
    expect(requests).toEqual(["https://api.github.com/repos/acme/app/pulls/12 Bearer read-token"]);
    expect(report.closed).toEqual([{ repo: "acme/app", number: 12, merged: true }]);
    await process();
    expect(await status("KAN-1")).toBe(DONE);

    // Nothing open any more: the next poll asks GitHub nothing.
    const again = await pollPullRequests({
      db: router.db,
      config: router.config,
      now: router.clock.now,
      fetch: async () => {
        throw new Error("should not be called");
      },
    });
    expect(again.checked).toBe(0);
  });

  it("records each poll's outcome and says a private repository needs a token (ADR 0032)", async () => {
    await finishWithPullRequest();
    const answer = (status: number, body: unknown) => async () =>
      new Response(JSON.stringify(body), { status });

    const failed = await pollPullRequests({
      db: router.db,
      config: router.config,
      now: router.clock.now,
      fetch: answer(404, { message: "Not Found" }),
    });
    expect(failed.errors[0]?.error).toMatch(/private repository needs GITHUB_TOKEN/);
    let row = getPullRequest(router.db, "acme/app", 12);
    expect(row?.state).toBe("open");
    expect(row?.lastCheckedAt).toBe(router.clock.now());
    expect(row?.lastError).toMatch(/404.*needs GITHUB_TOKEN/);

    await pollPullRequests({
      db: router.db,
      config: router.config,
      token: "read-token",
      now: router.clock.now,
      fetch: answer(200, { state: "open", merged: false }),
    });
    row = getPullRequest(router.db, "acme/app", 12);
    expect(row?.lastError).toBeNull();
    expect(row?.state).toBe("open");
  });
});

describe("pollErrorMessage", () => {
  const pr = { repo: "acme/app", number: 1 };
  it("explains the usual failures", () => {
    expect(pollErrorMessage(404, pr, false)).toMatch(/private repository needs GITHUB_TOKEN/);
    expect(pollErrorMessage(404, pr, true)).toMatch(/token cannot see this repository/);
    expect(pollErrorMessage(401, pr, true)).toMatch(/invalid or expired/);
    expect(pollErrorMessage(403, pr, false)).toMatch(/rate limited.*raises the limit/);
    expect(pollErrorMessage(500, pr, true)).toBe("GitHub answered 500 for acme/app#1");
  });
});

describe("parsePullRequestClosed", () => {
  it("reads merged and closed events and ignores the rest", () => {
    expect(parsePullRequestClosed("pull_request", pullRequestEvent(true))).toEqual({
      repo: "acme/app",
      number: 12,
      merged: true,
      by: "reviewer",
    });
    expect(parsePullRequestClosed("pull_request", { action: "opened" })).toBeUndefined();
    expect(parsePullRequestClosed("push", pullRequestEvent(true))).toBeUndefined();
  });
});
