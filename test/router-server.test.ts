import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openRouterDb } from "../src/router/db/connection.js";
import { listUnprocessedEvents } from "../src/router/db/events.js";
import { buildRouterServer, JIRA_WEBHOOK_BODY_LIMIT } from "../src/router/server.js";

const SECRET = "webhook-secret-at-least-16-chars";

function sign(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
}

describe("Router server", () => {
  let dataDir: string;
  let db: Database.Database;
  let app: FastifyInstance;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "ggjira-router-server-test-"));
    db = openRouterDb(path.join(dataDir, "router.sqlite3"));
    app = buildRouterServer({ db, webhookSecret: SECRET, siteId: "site-1" });
  });

  afterEach(async () => {
    await app.close();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("GET /health returns ok", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", mode: "router" });
  });

  it("accepts a correctly signed webhook and persists one event", async () => {
    const payload = JSON.stringify({ webhookEvent: "jira:issue_updated" });
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: {
        "content-type": "application/json",
        "x-hub-signature": sign(payload),
        "x-atlassian-webhook-identifier": "delivery-1",
      },
      payload,
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: "accepted" });
    expect(listUnprocessedEvents(db)).toHaveLength(1);
  });

  it("rejects a webhook with an invalid signature and persists nothing", async () => {
    const payload = JSON.stringify({ webhookEvent: "jira:issue_updated" });
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: {
        "content-type": "application/json",
        "x-hub-signature": "sha256=deadbeef",
        "x-atlassian-webhook-identifier": "delivery-1",
      },
      payload,
    });
    expect(response.statusCode).toBe(401);
    expect(listUnprocessedEvents(db)).toHaveLength(0);
  });

  it("deduplicates the same delivery received twice, forward or reverse order", async () => {
    const first = JSON.stringify({ seq: 1 });
    const second = JSON.stringify({ seq: 2 });
    const send = (payload: string, deliveryId: string) =>
      app.inject({
        method: "POST",
        url: "/webhooks/jira",
        headers: {
          "content-type": "application/json",
          "x-hub-signature": sign(payload),
          "x-atlassian-webhook-identifier": deliveryId,
        },
        payload,
      });

    // Reverse order: "delivery-2" arrives before "delivery-1", then both repeat.
    expect((await send(second, "delivery-2")).json()).toEqual({ status: "accepted" });
    expect((await send(first, "delivery-1")).json()).toEqual({ status: "accepted" });
    expect((await send(second, "delivery-2")).json()).toEqual({ status: "duplicate" });
    expect((await send(first, "delivery-1")).json()).toEqual({ status: "duplicate" });
    expect(listUnprocessedEvents(db)).toHaveLength(2);
  });

  describe("webhook hardening (ADR 0038)", () => {
    function deliver(body: unknown, deliveryId: string) {
      const payload = JSON.stringify(body);
      return app.inject({
        method: "POST",
        url: "/webhooks/jira",
        headers: {
          "content-type": "application/json",
          "x-hub-signature": sign(payload),
          "x-atlassian-webhook-identifier": deliveryId,
        },
        payload,
      });
    }

    const issueUpdated = (key: string) => ({
      webhookEvent: "jira:issue_updated",
      user: { accountId: "someone", emailAddress: "someone@example.com" },
      issue: {
        key,
        fields: { project: { key: key.split("-")[0] }, description: "secret details" },
      },
      changelog: { items: [{ field: "labels" }, { field: "status" }, { field: "labels" }] },
    });

    beforeEach(async () => {
      await app.close();
      app = buildRouterServer({
        db,
        webhookSecret: SECRET,
        siteId: "site-1",
        isWorkspaceProject: (projectKey) => projectKey === "KAN",
      });
    });

    it("stores only what identifies the change, never the issue body or the user", async () => {
      expect((await deliver(issueUpdated("KAN-7"), "d-1")).json()).toEqual({ status: "accepted" });
      const [event] = listUnprocessedEvents(db);
      expect(event?.payload).toEqual({
        webhookEvent: "jira:issue_updated",
        issueKey: "KAN-7",
        projectKey: "KAN",
        changedFields: ["labels", "status"],
      });
    });

    it("records comment events and other projects' events without waking a reconcile", async () => {
      const comment = { webhookEvent: "comment_created", issue: { key: "KAN-7" } };
      expect((await deliver(comment, "d-1")).json()).toEqual({ status: "ignored" });
      expect((await deliver(issueUpdated("OPS-1"), "d-2")).json()).toEqual({ status: "ignored" });
      expect((await deliver(comment, "d-1")).json()).toEqual({ status: "duplicate" });
      expect(listUnprocessedEvents(db)).toEqual([]);
    });

    it("answers 413 to an oversized body and stores nothing", async () => {
      const response = await deliver({ padding: "x".repeat(JIRA_WEBHOOK_BODY_LIMIT) }, "d-1");
      expect(response.statusCode).toBe(413);
      expect(listUnprocessedEvents(db)).toEqual([]);
    });

    it("answers 500, not accepted, when the delivery cannot be stored", async () => {
      db.exec("DROP TABLE events");
      const response = await deliver(issueUpdated("KAN-7"), "d-1");
      expect(response.statusCode).toBe(500);
    });
  });
});
