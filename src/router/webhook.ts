import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import { DuplicateEventError, recordEvent } from "./db/events.js";

const SIGNATURE_PREFIX = "sha256=";

/**
 * Verifies Jira's `X-Hub-Signature` header (docs/router-service-implementation-plan.md
 * §2 "웹훅과 보완 조회" — "요청 원문으로 X-Hub-Signature를 검증한다. SHA-256만 허용하고
 * 상수 시간 비교를 사용한다"). `rawBody` must be the exact bytes Jira signed, not a
 * re-serialized/parsed form.
 */
export function verifyJiraWebhookSignature(
  rawBody: string | Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith(SIGNATURE_PREFIX)) return false;
  const provided = signatureHeader.slice(SIGNATURE_PREFIX.length);
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const providedBuffer = Buffer.from(provided, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  if (providedBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(providedBuffer, expectedBuffer);
}

export interface IngestJiraWebhookEventInput {
  siteId: string;
  webhookDeliveryId: string;
  payload: unknown;
  /** ISO timestamp. Caller-supplied so tests can use a fake clock. */
  now: string;
}

export type IngestJiraWebhookEventResult = "accepted" | "duplicate";

/**
 * Persists an already-signature-verified webhook delivery, deduplicated by
 * (siteId, webhookDeliveryId) so the same delivery received once, twice, or
 * out of order (Jira redelivers on timeout) only ever occupies one row
 * (§2 "동일 웹훅 반복·역순 수신... 중복 작업이 생기지 않는다"). Jira access and
 * dispatch decisions happen later, off this event (`src/router/scheduler.ts`) —
 * this function's only job is idempotent persistence.
 */
export function ingestJiraWebhookEvent(
  db: Database.Database,
  input: IngestJiraWebhookEventInput,
): IngestJiraWebhookEventResult {
  try {
    recordEvent(db, {
      id: randomUUID(),
      siteId: input.siteId,
      webhookDeliveryId: input.webhookDeliveryId,
      payload: input.payload,
      now: input.now,
    });
    return "accepted";
  } catch (error) {
    if (error instanceof DuplicateEventError) return "duplicate";
    throw error;
  }
}
