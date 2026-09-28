import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listAudit } from "../src/router/db/audit.js";
import { RouterHarness } from "./helpers/router-harness.js";

describe("admin config and check API (web UI)", () => {
  let dir: string;
  let configPath: string;
  let router: RouterHarness;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ggjira-admin-config-"));
    configPath = path.join(dir, "router.config.json");
    router = new RouterHarness({ configPath });
    writeFileSync(configPath, JSON.stringify(router.config, null, 2));
  });

  afterEach(async () => {
    await router.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("requires the admin token", async () => {
    const response = await router.app.inject({ method: "GET", url: "/api/v1/admin/config" });
    expect(response.statusCode).toBe(401);
  });

  it("returns the file as written, in sync with the running config", async () => {
    const response = await router.adminCall("GET", "/config");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      path: configPath,
      restartRequired: false,
      restartFields: [],
      pendingApply: false,
      problem: null,
      file: expect.objectContaining({ configVersion: 5 }),
    });
  });

  it("rejects an invalid config with field paths and leaves the file alone", async () => {
    const before = readFileSync(configPath, "utf-8");
    const broken = {
      ...router.config,
      workspaces: [{ ...router.config.workspaces[0], repositoryId: "nope" }],
    };
    const response = await router.adminCall("PUT", "/config", broken);
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: string; issues: Array<{ path: string }> };
    expect(body.error).toBe("invalid_config");
    expect(body.issues.map((issue) => issue.path)).toContain("workspaces.0.repositoryId");
    expect(readFileSync(configPath, "utf-8")).toBe(before);
  });

  it("saves and applies at once: a newly added worker can pair without a restart", async () => {
    const before = await router.adminCall("POST", "/pairing-codes", { workerId: "worker-3" });
    expect(before.statusCode).toBe(404);

    const updated = {
      ...router.config,
      workers: [
        ...router.config.workers,
        {
          workerId: "worker-3",
          allowedRepositoryIds: router.config.workers[0]?.allowedRepositoryIds,
        },
      ],
    };
    const response = await router.adminCall("PUT", "/config", updated);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      restartRequired: false,
      pendingApply: false,
      appliedWithout: [],
    });
    expect(existsSync(`${configPath}.bak`)).toBe(true);
    expect(listAudit(router.db, "router-config").map((entry) => entry.action)).toEqual([
      "config.updated",
    ]);

    const pair = await router.adminCall("POST", "/pairing-codes", { workerId: "worker-3" });
    expect(pair.statusCode).toBe(201);
    const { workers } = (await router.adminCall("GET", "/workers")).json() as {
      workers: Array<{ workerId: string }>;
    };
    expect(workers.map((worker) => worker.workerId)).toContain("worker-3");
  });

  it("applies the rest but flags connection settings that need a restart", async () => {
    const response = await router.adminCall("PUT", "/config", {
      ...router.config,
      http: { host: "127.0.0.1", port: 9999 },
      reporting: { failureLabel: "ai-failed" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      restartRequired: true,
      restartFields: ["http"],
      appliedWithout: ["http"],
      pendingApply: false,
    });
  });

  it("applies a hand-edited file on request", async () => {
    const edited = { ...router.config, workers: [router.config.workers[0]] };
    writeFileSync(configPath, JSON.stringify(edited));
    expect((await router.adminCall("GET", "/config")).json()).toMatchObject({
      pendingApply: true,
    });

    const applied = await router.adminCall("POST", "/config/apply");
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toMatchObject({ pendingApply: false });
    expect(listAudit(router.db, "router-config").map((entry) => entry.action)).toEqual([
      "config.applied",
    ]);
    expect(
      (await router.adminCall("POST", "/pairing-codes", { workerId: "worker-2" })).statusCode,
    ).toBe(404);
  });

  it("refuses to apply a file that is invalid", async () => {
    writeFileSync(configPath, JSON.stringify({ configVersion: 5 }));
    const response = await router.adminCall("POST", "/config/apply");
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "invalid_config" });
  });

  it("reports a broken file on disk instead of failing", async () => {
    writeFileSync(configPath, "{ not json");
    const response = await router.adminCall("GET", "/config");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ file: null, pendingApply: false });
    expect((response.json() as { problem: string }).problem).toContain("not valid JSON");
  });

  it("runs router check against the saved config through the Router's Jira gateway", async () => {
    const response = await router.adminCall("POST", "/check", {});
    expect(response.statusCode).toBe(200);
    const { items } = response.json() as { items: Array<{ level: string; message: string }> };
    expect(items[0]).toMatchObject({
      level: "ok",
      message: expect.stringContaining("authentication works"),
    });
  });

  it("answers 409 when the Router has no config file", async () => {
    const bare = new RouterHarness();
    try {
      const response = await bare.adminCall("GET", "/config");
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: "config_unavailable" });
    } finally {
      await bare.close();
    }
  });
});
