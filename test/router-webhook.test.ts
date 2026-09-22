import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openRouterDb } from "../src/router/db/connection.js";
import { listUnprocessedEvents } from "../src/router/db/events.js";
import { ingestJiraWebhookEvent, verifyJiraWebhookSignature } from "../src/router/webhook.js";

const SECRET = "webhook-secret-at-least-16-chars";

function sign(body: string, secret: string = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("verifyJiraWebhookSignature", () => {
  it("accepts a correctly signed body", () => {
    const body = JSON.stringify({ hello: "world" });
    expect(verifyJiraWebhookSignature(body, sign(body), SECRET)).toBe(true);
  });

  it("rejects a body signed with the wrong secret", () => {
    const body = JSON.stringify({ hello: "world" });
    expect(
      verifyJiraWebhookSignature(body, sign(body, "a-completely-different-secret"), SECRET),
    ).toBe(false);
  });

  it("rejects a tampered body", () => {
    const body = JSON.stringify({ hello: "world" });
    const signature = sign(body);
    expect(
      verifyJiraWebhookSignature(JSON.stringify({ hello: "mallory" }), signature, SECRET),
    ).toBe(false);
  });

  it("rejects a missing signature header", () => {
    expect(verifyJiraWebhookSignature("{}", undefined, SECRET)).toBe(false);
  });

  it("rejects a header without the sha256= prefix", () => {
    const body = "{}";
    const raw = createHmac("sha256", SECRET).update(body).digest("hex");
    expect(verifyJiraWebhookSignature(body, raw, SECRET)).toBe(false);
  });
});

describe("ingestJiraWebhookEvent", () => {
  let dataDir: string;
  let db: Database.Database;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "ggjira-router-webhook-test-"));
    db = openRouterDb(path.join(dataDir, "router.sqlite3"));
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("accepts a new delivery and persists it", () => {
    const result = ingestJiraWebhookEvent(db, {
      siteId: "site-1",
      webhookDeliveryId: "delivery-1",
      payload: { webhookEvent: "jira:issue_updated" },
      now: "2026-01-01T00:00:00.000Z",
    });
    expect(result).toBe("accepted");
    expect(listUnprocessedEvents(db)).toHaveLength(1);
  });

  it("treats the same delivery received twice as a duplicate, without creating a second row", () => {
    const input = {
      siteId: "site-1",
      webhookDeliveryId: "delivery-1",
      payload: { webhookEvent: "jira:issue_updated" },
      now: "2026-01-01T00:00:00.000Z",
    };
    expect(ingestJiraWebhookEvent(db, input)).toBe("accepted");
    expect(ingestJiraWebhookEvent(db, { ...input, now: "2026-01-01T00:05:00.000Z" })).toBe(
      "duplicate",
    );
    expect(listUnprocessedEvents(db)).toHaveLength(1);
  });

  it("treats the same delivery received out of order (reverse) the same as forward order", () => {
    const first = {
      siteId: "site-1",
      webhookDeliveryId: "delivery-1",
      payload: { seq: 1 },
      now: "2026-01-01T00:00:00.000Z",
    };
    const second = {
      siteId: "site-1",
      webhookDeliveryId: "delivery-2",
      payload: { seq: 2 },
      now: "2026-01-01T00:01:00.000Z",
    };
    // Reverse delivery order: second arrives before first.
    expect(ingestJiraWebhookEvent(db, second)).toBe("accepted");
    expect(ingestJiraWebhookEvent(db, first)).toBe("accepted");
    expect(ingestJiraWebhookEvent(db, second)).toBe("duplicate");
    expect(ingestJiraWebhookEvent(db, first)).toBe("duplicate");
    expect(listUnprocessedEvents(db)).toHaveLength(2);
  });

  it("does not dedupe the same delivery id across different Jira sites", () => {
    const input = {
      webhookDeliveryId: "delivery-1",
      payload: {},
      now: "2026-01-01T00:00:00.000Z",
    };
    expect(ingestJiraWebhookEvent(db, { ...input, siteId: "site-1" })).toBe("accepted");
    expect(ingestJiraWebhookEvent(db, { ...input, siteId: "site-2" })).toBe("accepted");
    expect(listUnprocessedEvents(db)).toHaveLength(2);
  });
});
