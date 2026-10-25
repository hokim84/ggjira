import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AI_ROLES } from "../src/contracts/prompts.js";
import { buildPmSystemPrompt } from "../src/pm/prompt.js";
import { RouterConfigSchema } from "../src/router/config.js";
import { getActiveAttemptForWorker } from "../src/router/db/attempts.js";
import { listAudit } from "../src/router/db/audit.js";
import { getJob } from "../src/router/db/jobs.js";
import { buildJobEnvelope } from "../src/router/envelope.js";
import { buildFciExplanationPrompt } from "../src/worker/fci-prompt.js";
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
    const { roles } = response.json();
    expect(roles.map((role: { systemPrompt: string }) => role.systemPrompt)).toEqual([
      buildPmSystemPrompt(),
      buildImplementSystemPrompt(),
      buildFciExplanationPrompt(),
    ]);
    expect(roles.map((role: { title: string }) => role.title)).toEqual([
      "플랜",
      "구현",
      "기술부채 변화 설명",
    ]);
    expect(roles[0].examplePrompt).toContain("EXAMPLE-1");
    expect(roles[0].outputSchema).toHaveProperty("properties");
    expect(roles[1].outputSchema).toHaveProperty("properties");
    expect(roles[2].outputSchema).toHaveProperty("properties");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json().editable).toBe(false);
    expect(
      (await router.adminCall("PUT", "/prompts/planning", { additionalInstructions: "edit" }))
        .statusCode,
    ).toBe(409);
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

describe("role additional instructions", () => {
  let dir: string;
  let configPath: string;
  let router: RouterHarness;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ggjira-role-prompts-"));
    configPath = path.join(dir, "router.config.json");
    router = new RouterHarness({ configPath });
    writeFileSync(configPath, JSON.stringify(router.config));
  });
  afterEach(async () => {
    await router.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists each role, preserves unrelated config and serves defaults after clearing", async () => {
    for (const role of AI_ROLES) {
      const response = await router.adminCall("PUT", `/prompts/${role}`, {
        additionalInstructions: `Extra ${role}`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().editable).toBe(true);
      expect(
        response.json().roles.find((r: { id: string }) => r.id === role).effectiveSystemPrompt,
      ).toContain(`Extra ${role}`);
    }
    const raw = JSON.parse(readFileSync(configPath, "utf8"));
    expect(raw.workspaces).toEqual(router.config.workspaces);
    for (const role of AI_ROLES)
      expect(raw.prompts[role].additionalInstructions).toBe(`Extra ${role}`);
    expect(
      listAudit(router.db, "fci_analysis").some((entry) => entry.action === "prompt.updated"),
    ).toBe(true);
    await router.close();
    router = new RouterHarness({ configPath, config: RouterConfigSchema.parse(raw) });
    const loaded = (await router.adminCall("GET", "/prompts")).json().roles;
    expect(loaded[2].additionalInstructions).toBe("Extra fci_analysis");
    // General config edits preserve all three prompt settings.
    expect(
      (await router.adminCall("PUT", "/config", { ...raw, execution: { timeoutMs: 120000 } }))
        .statusCode,
    ).toBe(200);
    const reset = await router.adminCall("PUT", "/prompts/implementation", {
      additionalInstructions: "",
    });
    const roles = reset.json().roles;
    expect(roles[1].effectiveSystemPrompt).toBe(buildImplementSystemPrompt());
    expect(roles[0].additionalInstructions).toBe("Extra planning");
    expect(roles[2].additionalInstructions).toBe("Extra fci_analysis");
  });

  it("uses the catalog's role instructions in envelopes and freezes an issued attempt", async () => {
    await router.seedQueuedJob();
    const worker = await router.connectWorker("worker-1");
    const first = await router.next(worker, "initial");
    expect(first.statusCode).toBe(200);
    for (const role of AI_ROLES) {
      expect(
        (
          await router.adminCall("PUT", `/prompts/${role}`, {
            additionalInstructions: `Extra ${role}`,
          })
        ).statusCode,
      ).toBe(200);
    }
    const replay = await router.next(worker, "initial");
    expect(replay.json().systemPrompt).toBe(first.json().systemPrompt);
    const attempt = getActiveAttemptForWorker(router.db, worker.workerId);
    const job = attempt && getJob(router.db, attempt.jobId);
    if (!attempt || !job) throw new Error("missing leased job");
    const config = RouterConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf8")));
    const catalog = (await router.adminCall("GET", "/prompts")).json().roles;
    for (const kind of ["planning", "implementation"] as const) {
      const envelope = buildJobEnvelope(router.db, config, { ...job, kind }, attempt);
      expect(envelope.systemPrompt).toBe(
        catalog.find((role: { id: string }) => role.id === kind).effectiveSystemPrompt,
      );
      expect(envelope.systemPrompt).toContain(`Extra ${kind}`);
    }
    expect(
      buildJobEnvelope(router.db, config, { ...job, kind: "integration_check" }, attempt)
        .systemPrompt,
    ).not.toContain("Extra");
    await router.seedQueuedJob("KAN-2");
    const secondWorker = await router.connectWorker("worker-2");
    const second = await router.next(secondWorker, "new");
    expect(second.statusCode).toBe(200);
    expect(second.json().systemPrompt).toContain("Extra implementation");
    await router.restart();
    expect((await router.next(secondWorker, "new")).json().systemPrompt).toBe(
      second.json().systemPrompt,
    );
  });

  it("rejects unauthenticated, unknown, oversized and malformed edits without writing", async () => {
    const before = readFileSync(configPath, "utf8");
    expect(
      (
        await router.app.inject({
          method: "PUT",
          url: "/api/v1/admin/prompts/planning",
          payload: { additionalInstructions: "edit" },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await router.adminCall("PUT", "/prompts/agent", { additionalInstructions: "edit" }))
        .statusCode,
    ).toBe(400);
    for (const body of [
      {},
      { additionalInstructions: 1 },
      { additionalInstructions: "a".repeat(20001) },
      { additionalInstructions: "x", systemPrompt: "override" },
    ]) {
      expect((await router.adminCall("PUT", "/prompts/planning", body)).statusCode).toBe(400);
    }
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  it("loads configVersion 6 without prompt settings using empty additions", () => {
    const { prompts: _prompts, ...old } = router.config;
    const parsed = RouterConfigSchema.parse(old);
    expect(Object.values(parsed.prompts).every((role) => role.additionalInstructions === "")).toBe(
      true,
    );
  });
});
