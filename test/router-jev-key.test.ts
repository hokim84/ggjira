import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeJiraGateway } from "../src/jira/fake.js";
import { setSecretsFileValue } from "../src/router/config-store.js";
import { RouterDaemon } from "../src/router/daemon.js";
import { listAudit } from "../src/router/db/audit.js";
import { openRouterDb } from "../src/router/db/connection.js";
import { parseEnvFile } from "../src/router/secrets.js";
import {
  buildRouterConfig,
  issueDescription,
  ManualClock,
  REQUEST_STATUS,
  workerPolicy,
} from "./helpers/router-fixtures.js";

const ADMIN_TOKEN = "admin-token-at-least-16-chars";
const KEY = "ts_live_abc123DEF456";

describe("setSecretsFileValue (ADR 0031)", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ggjira-secrets-"));
    file = path.join(dir, "router.env");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("adds, replaces and removes one key, keeping every other line, owner-only", () => {
    writeFileSync(file, "# comment\nJIRA_EMAIL=a@b.c\nGITHUB_TOKEN=gh\n", { mode: 0o644 });

    setSecretsFileValue(file, "TYPESAFE_API_KEY", "first-key-1");
    setSecretsFileValue(file, "TYPESAFE_API_KEY", "second-key-2");
    expect(readFileSync(file, "utf-8")).toBe(
      "# comment\nJIRA_EMAIL=a@b.c\nGITHUB_TOKEN=gh\nTYPESAFE_API_KEY=second-key-2\n",
    );
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);

    setSecretsFileValue(file, "TYPESAFE_API_KEY", null);
    expect(parseEnvFile(readFileSync(file, "utf-8"))).toEqual({
      JIRA_EMAIL: "a@b.c",
      GITHUB_TOKEN: "gh",
    });
  });

  it("creates the file when it does not exist", () => {
    setSecretsFileValue(file, "TYPESAFE_API_KEY", "new-key-123");
    expect(parseEnvFile(readFileSync(file, "utf-8")).TYPESAFE_API_KEY).toBe("new-key-123");
  });
});

describe("Jev API key from the web UI (ADR 0031)", () => {
  let dir: string;
  let secretsPath: string;
  let configPath: string;
  let db: Database.Database;
  let jira: FakeJiraGateway;
  let clock: ManualClock;
  let daemons: RouterDaemon[];
  let jevCalls: Array<Record<string, string>>;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ggjira-jev-key-"));
    secretsPath = path.join(dir, "router.env");
    configPath = path.join(dir, "router.config.json");
    writeFileSync(secretsPath, "GGJIRA_ADMIN_TOKEN=x\n", { mode: 0o600 });
    const config = buildRouterConfig({ workers: [workerPolicy({ workerId: "worker-1" })] });
    writeFileSync(configPath, JSON.stringify(config));
    db = openRouterDb(path.join(dir, "router.sqlite3"));
    jira = new FakeJiraGateway();
    jira.setSelf({ accountId: "router-bot", displayName: "Router", emailAddress: null });
    clock = new ManualClock();
    daemons = [];
    jevCalls = [];
  });

  afterEach(async () => {
    for (const daemon of daemons) await daemon.stop();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function build(opts: { apiKey?: string; fromEnvironment?: boolean } = {}): RouterDaemon {
    const daemon = new RouterDaemon({
      db,
      jira,
      config: buildRouterConfig({ workers: [workerPolicy({ workerId: "worker-1" })] }),
      webhookSecret: "webhook-secret-at-least-16-chars",
      adminToken: ADMIN_TOKEN,
      siteId: "site-1",
      configPath,
      now: clock.now,
      nowMs: () => Date.parse(clock.now()),
      jev: {
        apiKey: opts.apiKey,
        secretsPath,
        fromEnvironment: opts.fromEnvironment ?? false,
        fetch: async (_url, init) => {
          jevCalls.push(init.headers as Record<string, string>);
          return new Response(
            JSON.stringify({
              model: "jev-1.13.0",
              answers: {
                modelTier: { type: "choice", choice: "small", probabilities: {}, confidence: 0.9 },
              },
              usage: {},
            }),
          );
        },
      },
    });
    daemons.push(daemon);
    return daemon;
  }

  function call(daemon: RouterDaemon, method: "GET" | "PUT", url: string, body?: unknown) {
    return daemon.app.inject({
      method,
      url: `/api/v1/admin${url}`,
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        "x-ggjira-actor": "tester",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
  }

  it("saves the key to the secrets file, applies it at once, and never returns it", async () => {
    jira.seedIssue({
      key: "KAN-1",
      summary: "Implement KAN-1",
      statusName: REQUEST_STATUS,
      projectKey: "KAN",
      assigneeAccountId: "user-1",
      description: issueDescription(),
    });
    const daemon = build();
    await daemon.reconcileNow();
    expect(await daemon.assessTick()).toBeUndefined();

    const saved = await call(daemon, "PUT", "/secrets/jev", { apiKey: KEY });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ apiKey: true, source: "file", editable: true });
    expect(saved.body).not.toContain(KEY);
    expect(parseEnvFile(readFileSync(secretsPath, "utf-8"))).toEqual({
      GGJIRA_ADMIN_TOKEN: "x",
      TYPESAFE_API_KEY: KEY,
    });

    // No restart: the next assess pass uses the new key.
    const pass = await daemon.assessTick();
    expect(pass?.failed).toEqual([]);
    expect(pass?.assessed).toHaveLength(1);
    expect(jevCalls[0]?.authorization).toBe(`Bearer ${KEY}`);

    const configView = await call(daemon, "GET", "/config");
    expect(configView.json().jev).toEqual({ apiKey: true, source: "file", editable: true });
    expect(configView.body).not.toContain(KEY);

    const audit = listAudit(db, "TYPESAFE_API_KEY");
    expect(audit.map((entry) => entry.action)).toEqual(["secret.jev.set"]);
    expect(JSON.stringify(audit)).not.toContain(KEY);

    const removed = await call(daemon, "PUT", "/secrets/jev", { apiKey: null });
    expect(removed.json()).toEqual({ apiKey: false, source: null, editable: true });
    expect(parseEnvFile(readFileSync(secretsPath, "utf-8")).TYPESAFE_API_KEY).toBeUndefined();
    expect(await daemon.assessTick()).toBeUndefined();
  });

  it("refuses keys that could break the secrets file", async () => {
    const daemon = build();
    for (const apiKey of [
      "short",
      "has space-in-it",
      "line\nGGJIRA_ADMIN_TOKEN=evil",
      'quo"ted-key',
    ]) {
      const response = await call(daemon, "PUT", "/secrets/jev", { apiKey });
      expect(response.statusCode).toBe(400);
    }
    expect(readFileSync(secretsPath, "utf-8")).toBe("GGJIRA_ADMIN_TOKEN=x\n");
  });

  it("refuses to change a key that comes from the environment", async () => {
    const daemon = build({ apiKey: "from-env-key", fromEnvironment: true });
    const config = await call(daemon, "GET", "/config");
    expect(config.json().jev).toEqual({ apiKey: true, source: "environment", editable: false });

    const response = await call(daemon, "PUT", "/secrets/jev", { apiKey: KEY });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("set_by_environment");
    expect(readFileSync(secretsPath, "utf-8")).toBe("GGJIRA_ADMIN_TOKEN=x\n");
  });
});
