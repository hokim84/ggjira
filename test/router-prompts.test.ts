import { expect, it } from "vitest";
import { buildPmSystemPrompt } from "../src/pm/prompt.js";
import { buildImplementSystemPrompt } from "../src/worker/prompt.js";

import { ADMIN_TOKEN, RouterHarness } from "./helpers/router-harness.js";

it("serves current built-in prompts only to an authenticated administrator", async () => {
  const router = new RouterHarness();
  const app = router.app;
  try {
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/prompts" })).statusCode).toBe(
      401,
    );
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/admin/prompts",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
    const { agents } = response.json();
    expect(agents.map((agent: { systemPrompt: string }) => agent.systemPrompt)).toEqual([
      buildPmSystemPrompt(),
      buildImplementSystemPrompt(),
    ]);
    expect(agents[0].examplePrompt).toContain("EXAMPLE-1");
    expect(agents[0].outputSchema).toHaveProperty("properties");
    expect(agents[1].outputSchema).toHaveProperty("properties");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v1/admin/prompts",
          headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
  } finally {
    await router.close();
  }
});
