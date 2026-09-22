import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openRouterDb } from "../src/router/db/connection.js";
import { listUnprocessedEvents } from "../src/router/db/events.js";
import { buildRouterServer } from "../src/router/server.js";

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
    expect(response.json()).toEqual({ status: "ok" });
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
});
