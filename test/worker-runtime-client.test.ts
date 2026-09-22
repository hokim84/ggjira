import { describe, expect, it } from "vitest";
import { type FetchLike, RouterApiError, RouterClient } from "../src/worker-runtime/client.js";

function mockFetch(response: Response): { fetch: FetchLike; calls: Array<[string, RequestInit]> } {
  const calls: Array<[string, RequestInit]> = [];
  return {
    calls,
    fetch: async (input, init) => {
      calls.push([input, init]);
      return response;
    },
  };
}

const lease = { sessionId: "s1", attemptId: "a1", leaseToken: "l1" };

describe("RouterClient", () => {
  it("POSTs JSON to the /api/v1 path with the worker token as a bearer header", async () => {
    const { fetch, calls } = mockFetch(
      new Response(JSON.stringify({ granted: true, leaseExpiresAt: "2026-01-01T00:00:30.000Z" })),
    );
    const client = new RouterClient({
      routerUrl: "https://router.example/",
      workerToken: "tok",
      fetch,
    });

    const answer = await client.start("job/1", lease);

    expect(answer.granted).toBe(true);
    const [url, init] = calls[0] ?? [];
    expect(url).toBe("https://router.example/api/v1/jobs/job%2F1/start");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(JSON.parse(init?.body as string)).toEqual(lease);
  });

  it("sends no authorization header for register", async () => {
    const { fetch, calls } = mockFetch(
      new Response(JSON.stringify({ workerId: "w1", workerToken: "t" })),
    );
    await new RouterClient({ routerUrl: "https://router.example", fetch }).register({
      protocolVersion: 1,
      pairingCode: "code",
      workerName: "w",
    });
    expect((calls[0]?.[1].headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("returns null for a 204 from jobs/next", async () => {
    const { fetch } = mockFetch(new Response(null, { status: 204 }));
    const client = new RouterClient({
      routerUrl: "https://router.example",
      workerToken: "t",
      fetch,
    });
    expect(await client.next({ sessionId: "s", workerId: "w", requestId: "r" })).toBeNull();
  });

  it("surfaces an API error body as a RouterApiError, flagging 409 as a conflict", async () => {
    const { fetch } = mockFetch(
      new Response(JSON.stringify({ error: "stale_lease", message: "nope" }), { status: 409 }),
    );
    const client = new RouterClient({
      routerUrl: "https://router.example",
      workerToken: "t",
      fetch,
    });

    const error = await client.jobHeartbeat("j", lease).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RouterApiError);
    expect((error as RouterApiError).status).toBe(409);
    expect((error as RouterApiError).isConflict).toBe(true);
    expect((error as RouterApiError).body?.error).toBe("stale_lease");
  });

  it("tolerates a non-JSON error body (e.g. a proxy page)", async () => {
    const { fetch } = mockFetch(new Response("<html>bad gateway</html>", { status: 502 }));
    const client = new RouterClient({
      routerUrl: "https://router.example",
      workerToken: "t",
      fetch,
    });

    const error = await client
      .heartbeat({
        sessionId: "s",
        workerId: "w",
        availability: { capabilities: [], repositoryIds: [], busy: false },
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RouterApiError);
    expect((error as RouterApiError).status).toBe(502);
    expect((error as RouterApiError).body).toBeUndefined();
  });

  it("rejects a 2xx response that doesn't match the contract", async () => {
    const { fetch } = mockFetch(new Response(JSON.stringify({ unexpected: true })));
    const client = new RouterClient({
      routerUrl: "https://router.example",
      workerToken: "t",
      fetch,
    });
    await expect(client.start("j", lease)).rejects.toThrow();
  });
});
