import type Database from "better-sqlite3";
import { isUniqueConstraintViolation } from "./errors.js";

export interface EventRow {
  id: string;
  siteId: string;
  webhookDeliveryId: string;
  receivedAt: string;
  processedAt: string | null;
  payload: unknown;
}

export interface RecordEventInput {
  id: string;
  siteId: string;
  webhookDeliveryId: string;
  payload: unknown;
  /** ISO timestamp. Caller-supplied so tests can use a fake clock. */
  now: string;
}

/** Thrown when the same (siteId, webhookDeliveryId) pair was already recorded
 *  (docs/router-service-implementation-plan.md §2 "웹훅과 보완 조회" — enforced by the
 *  `idx_events_delivery` unique index). Jira's own redelivery, or the same delivery
 *  received out of order, both land here. */
export class DuplicateEventError extends Error {
  constructor(
    readonly siteId: string,
    readonly webhookDeliveryId: string,
  ) {
    super(`Webhook delivery ${webhookDeliveryId} for site ${siteId} was already recorded`);
    this.name = "DuplicateEventError";
  }
}

function toEventRow(row: Record<string, unknown>): EventRow {
  return {
    id: row.id as string,
    siteId: row.site_id as string,
    webhookDeliveryId: row.webhook_delivery_id as string,
    receivedAt: row.received_at as string,
    processedAt: (row.processed_at as string | null) ?? null,
    payload: JSON.parse(row.payload as string),
  };
}

export function recordEvent(db: Database.Database, input: RecordEventInput): EventRow {
  try {
    db.prepare(
      `INSERT INTO events (id, site_id, webhook_delivery_id, received_at, processed_at, payload)
       VALUES (?, ?, ?, ?, NULL, ?)`,
    ).run(
      input.id,
      input.siteId,
      input.webhookDeliveryId,
      input.now,
      JSON.stringify(input.payload),
    );
  } catch (error) {
    if (isUniqueConstraintViolation(error)) {
      throw new DuplicateEventError(input.siteId, input.webhookDeliveryId);
    }
    throw error;
  }
  const event = getEvent(db, input.id);
  if (!event)
    throw new Error(`recordEvent: row for ${input.id} not found immediately after insert`);
  return event;
}

export function getEvent(db: Database.Database, id: string): EventRow | undefined {
  const row = db.prepare("SELECT * FROM events WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? toEventRow(row) : undefined;
}

export function listUnprocessedEvents(db: Database.Database): EventRow[] {
  const rows = db
    .prepare("SELECT * FROM events WHERE processed_at IS NULL ORDER BY received_at ASC")
    .all() as Record<string, unknown>[];
  return rows.map(toEventRow);
}

export function markEventProcessed(db: Database.Database, id: string, now: string): void {
  db.prepare("UPDATE events SET processed_at = ? WHERE id = ?").run(now, id);
}
