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

  it("returns the file as written and no restart when it matches the running config", async () => {
    const response = await router.adminCall("GET", "/config");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      path: configPath,
      restartRequired: false,
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

  it("saves a valid config, keeps a .bak, audits it, and flags a restart", async () => {
    const updated = {
      ...router.config,
      reporting: { failureLabel: "ai-failed" },
    };
    const response = await router.adminCall("PUT", "/config", updated);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ restartRequired: true, problem: null });
    expect(JSON.parse(readFileSync(configPath, "utf-8")).reporting.failureLabel).toBe("ai-failed");
    expect(existsSync(`${configPath}.bak`)).toBe(true);
    expect(listAudit(router.db, "router-config").map((entry) => entry.action)).toEqual([
      "config.updated",
    ]);
    expect((await router.adminCall("GET", "/config")).json()).toMatchObject({
      restartRequired: true,
    });
  });

  it("reports a broken file on disk instead of failing", async () => {
    writeFileSync(configPath, "{ not json");
    const response = await router.adminCall("GET", "/config");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ file: null, restartRequired: true });
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
