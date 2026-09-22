import type Database from "better-sqlite3";
import Fastify, { type FastifyInstance } from "fastify";
import { ingestJiraWebhookEvent, verifyJiraWebhookSignature } from "./webhook.js";

const SIGNATURE_HEADER = "x-hub-signature";
const DELIVERY_ID_HEADER = "x-atlassian-webhook-identifier";

export interface RouterServerDeps {
  db: Database.Database;
  webhookSecret: string;
  /** Identifies the single Jira site this Router instance serves
   *  (docs/router-service-implementation-plan.md §3 "첫 버전은 Jira 사이트 하나를 지원"),
   *  paired with the delivery id for dedup rather than trusted from the webhook payload. */
  siteId: string;
  now?: () => string;
}

/**
 * Minimal Fastify app for stage 2: signature-verified webhook ingestion and a
 * liveness probe. Stage 3 adds `/api/v1/*` worker routes to this same instance
 * (docs/router-service-implementation-plan.md §4 "구현 단계").
 */
export function buildRouterServer(deps: RouterServerDeps): FastifyInstance {
  const now = deps.now ?? (() => new Date().toISOString());
  const app = Fastify();

  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) => {
    const buffer = body as Buffer;
    try {
      const parsed = buffer.length > 0 ? JSON.parse(buffer.toString("utf-8")) : {};
      done(null, { raw: buffer, parsed });
    } catch (error) {
      done(error as Error, undefined);
    }
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.post("/webhooks/jira", async (request, reply) => {
    const { raw, parsed } = request.body as { raw: Buffer; parsed: unknown };
    const signatureHeader = request.headers[SIGNATURE_HEADER];
    const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
    if (!verifyJiraWebhookSignature(raw, signature, deps.webhookSecret)) {
      return reply.code(401).send({ error: "invalid signature" });
    }

    const deliveryIdHeader = request.headers[DELIVERY_ID_HEADER];
    const webhookDeliveryId = Array.isArray(deliveryIdHeader)
      ? deliveryIdHeader[0]
      : deliveryIdHeader;
    if (!webhookDeliveryId) {
      return reply.code(400).send({ error: `missing ${DELIVERY_ID_HEADER} header` });
    }

    const result = ingestJiraWebhookEvent(deps.db, {
      siteId: deps.siteId,
      webhookDeliveryId,
      payload: parsed,
      now: now(),
    });
    return reply.code(202).send({ status: result });
  });

  return app;
}
