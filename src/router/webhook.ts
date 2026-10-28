import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { RouterDatabase } from "./db/connection.js";
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

/**
 * What Router keeps of a Jira webhook (ADR 0038). A webhook is only a "something changed" signal —
 * every decision re-reads the issue from Jira — so the issue body, comments and user details in the
 * payload are never stored.
 */
export interface JiraWebhookSummary {
  webhookEvent: string | null;
  issueKey: string | null;
  projectKey: string | null;
  /** Field names from the payload's changelog (e.g. "status", "labels"). */
  changedFields: string[];
}

function stringAt(value: unknown, ...keys: string[]): string | null {
  let current = value;
  for (const key of keys) {
    if (typeof current !== "object" || current === null) return null;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" ? current : null;
}

export function summarizeJiraWebhook(payload: unknown): JiraWebhookSummary {
  const items = (payload as { changelog?: { items?: unknown } } | null)?.changelog?.items;
  const issueKey = stringAt(payload, "issue", "key");
  return {
    webhookEvent: stringAt(payload, "webhookEvent"),
    issueKey,
    projectKey:
      stringAt(payload, "issue", "fields", "project", "key") ??
      issueKey?.match(/^([A-Z][A-Z0-9_]*)-\d+$/)?.[1] ??
      null,
    changedFields: Array.isArray(items)
      ? [
          ...new Set(
            items
              .map((item) => stringAt(item, "field"))
              .filter((field): field is string => field !== null),
          ),
        ]
      : [],
  };
}

/**
 * Workspace comments can answer a planning question or request a retry (ADR 0050).
 * They only wake a fresh Jira read; the durable request record deduplicates execution.
 */
export function isRelevantJiraWebhook(
  summary: JiraWebhookSummary,
  isWorkspaceProject: (projectKey: string) => boolean,
): boolean {
  return summary.projectKey === null || isWorkspaceProject(summary.projectKey);
}

export interface IngestJiraWebhookEventInput {
  siteId: string;
  webhookDeliveryId: string;
  payload: unknown;
  /** ISO timestamp. Caller-supplied so tests can use a fake clock. */
  now: string;
  /** Recorded as already processed: kept for dedup and diagnosis, but wakes no reconcile. */
  ignored?: boolean;
}

export type IngestJiraWebhookEventResult = "accepted" | "duplicate" | "ignored";

/**
 * Persists an already-signature-verified webhook delivery, deduplicated by
 * (siteId, webhookDeliveryId) so the same delivery received once, twice, or
 * out of order (Jira redelivers on timeout) only ever occupies one row
 * (§2 "동일 웹훅 반복·역순 수신... 중복 작업이 생기지 않는다"). Jira access and
 * dispatch decisions happen later, off this event (`src/router/scheduler.ts`) —
 * this function's only job is idempotent persistence.
 */
export function ingestJiraWebhookEvent(
  db: RouterDatabase,
  input: IngestJiraWebhookEventInput,
): IngestJiraWebhookEventResult {
  try {
    recordEvent(db, {
      id: randomUUID(),
      siteId: input.siteId,
      webhookDeliveryId: input.webhookDeliveryId,
      payload: input.payload,
      now: input.now,
      ...(input.ignored ? { processedAt: input.now } : {}),
    });
    return input.ignored ? "ignored" : "accepted";
  } catch (error) {
    if (error instanceof DuplicateEventError) return "duplicate";
    throw error;
  }
}
