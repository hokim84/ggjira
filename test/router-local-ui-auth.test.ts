import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "../src/contracts/protocol.js";
import { buildRouterServer } from "../src/router/server.js";
import { ADMIN_TOKEN, RouterHarness } from "./helpers/router-harness.js";

describe("temporary loopback web UI access", () => {
  let router: RouterHarness;
  let app: FastifyInstance;
  beforeEach(() => {
    router = new RouterHarness();
    app = buildRouterServer({
      db: router.db,
      webhookSecret: "test-webhook-secret-123456",
      siteId: "test",
      adminToken: ADMIN_TOKEN,
      adminService: router.admin,
      workerService: router.service,
      localUiWithoutToken: true,
    });
  });
  afterEach(async () => {
    await app.close();
    await router.close();
  });
  const headers = {
    host: "127.0.0.1:8787",
    "x-ggjira-local-ui": "1",
    origin: "http://127.0.0.1:8787",
    "sec-fetch-site": "same-origin",
  };
  it("keeps default admin authentication and ordinary API calls protected", async () => {
    expect(
      (
        await router.app.inject({
          method: "GET",
          url: "/api/v1/admin/status",
          headers,
          remoteAddress: "127.0.0.1",
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/admin/status",
          headers: { host: headers.host },
          remoteAddress: "127.0.0.1",
        })
      ).statusCode,
    ).toBe(401);
    expect((await router.app.inject({ method: "GET", url: "/health" })).json()).not.toHaveProperty(
      "localUiWithoutToken",
    );
  });
  it("permits explicit same-origin loopback reads and writes without exposing the token", async () => {
    const health = await app.inject({
      method: "GET",
      url: "/health",
      headers,
      remoteAddress: "127.0.0.1",
    });
    expect(health.json().localUiWithoutToken).toBe(true);
    expect(health.body).not.toContain(ADMIN_TOKEN);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/admin/status",
          headers,
          remoteAddress: "127.0.0.1",
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/admin/pairing-codes",
          headers,
          remoteAddress: "127.0.0.1",
          payload: { protocolVersion: PROTOCOL_VERSION, workerId: "worker-1" },
        })
      ).statusCode,
    ).toBe(201);
  });
  it.each([
    { remoteAddress: "192.168.1.5", headers },
    {
      remoteAddress: "127.0.0.1",
      headers: { ...headers, host: "evil.example", origin: "http://evil.example" },
    },
    { remoteAddress: "127.0.0.1", headers: { ...headers, origin: "http://evil.example" } },
    { remoteAddress: "127.0.0.1", headers: { ...headers, "sec-fetch-site": "cross-site" } },
    { remoteAddress: "192.168.1.5", headers: { ...headers, "x-forwarded-for": "127.0.0.1" } },
  ])("rejects remote, forged-host, cross-origin and forwarded requests: %j", async (input) => {
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/admin/status", ...input })).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: "GET", url: "/health", ...input })).json(),
    ).not.toHaveProperty("localUiWithoutToken");
  });
  it("retains token auth for remote administrators and Worker auth for local clients", async () => {
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/admin/status",
          remoteAddress: "192.168.1.5",
          headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/jobs/next",
          headers,
          remoteAddress: "127.0.0.1",
          payload: {
            protocolVersion: PROTOCOL_VERSION,
            workerId: "worker-1",
            sessionId: "x",
            requestId: "x",
          },
        })
      ).statusCode,
    ).toBe(401);
  });
});
