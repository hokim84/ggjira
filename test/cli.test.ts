import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/cli-main.js";
import type { CliIo } from "../src/cli-io.js";
import { RouterConfigSchema } from "../src/router/config.js";
import { loadWorkerConfig } from "../src/worker-runtime/config.js";
import { loadWorkerCredential } from "../src/worker-runtime/credential.js";
import { ADMIN_TOKEN, RouterHarness } from "./helpers/router-harness.js";

function captureIo(env: NodeJS.ProcessEnv = {}): CliIo & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    env,
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
  };
}

describe("ggjira CLI", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ggjira-cli-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses removed v4 commands and names the replacement", async () => {
    for (const command of ["run", "once", "setup", "agent:create", "worker:run"]) {
      const io = captureIo();
      expect(await main([command], io)).toBe(2);
      expect(io.stderr.join("\n")).toMatch(
        /was removed .* Use: ggjira (router|worker)|declare the worker/,
      );
    }
  });

  it("prints usage and version", async () => {
    const help = captureIo();
    expect(await main(["--help"], help)).toBe(0);
    expect(help.stdout.join("\n")).toContain("ggjira router <command>");
    expect(help.stdout.join("\n")).toContain("ggjira worker <command>");

    const version = captureIo();
    expect(await main(["--version"], version)).toBe(0);
    expect(version.stdout).toEqual([expect.stringMatching(/^\d+\.\d+\.\d+$/)]);
  });

  it("router setup writes a valid starter config, prints fresh secrets, and won't overwrite", async () => {
    const configPath = path.join(dir, "router.config.json");
    const io = captureIo();
    expect(await main(["router", "setup", "--config", configPath], io)).toBe(0);
    const config = RouterConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf-8")));
    expect(config.configVersion).toBe(5);
    expect(io.stdout.join("\n")).toMatch(/GGJIRA_WEBHOOK_SECRET=\S{32,}/);
    expect(io.stdout.join("\n")).toMatch(/GGJIRA_ADMIN_TOKEN=\S{32,}/);

    const again = captureIo();
    expect(await main(["router", "setup", "--config", configPath], again)).toBe(2);
    expect(again.stderr.join("\n")).toContain("already exists");
  });

  it("router check fails fast on a config that is not v5", async () => {
    const configPath = path.join(dir, "old.json");
    writeFileSync(configPath, JSON.stringify({ configVersion: 4 }));
    const io = captureIo();
    expect(await main(["router", "check", "--config", configPath], io)).toBe(1);
    expect(io.stderr.join("\n")).toContain("failed validation");
  });

  describe("against a running Router", () => {
    let router: RouterHarness;
    let url: string;

    beforeEach(async () => {
      router = new RouterHarness();
      url = await router.app.listen({ host: "127.0.0.1", port: 0 });
    });

    afterEach(async () => {
      await router.close();
    });

    it("admin commands need the admin token", async () => {
      const io = captureIo();
      expect(await main(["router", "workers", "list", "--url", url], io)).toBe(2);
      expect(io.stderr.join("\n")).toContain("GGJIRA_ADMIN_TOKEN");
    });

    it("pairs a worker end to end: router workers pair → worker setup", async () => {
      const env = { GGJIRA_ADMIN_TOKEN: ADMIN_TOKEN };
      const pair = captureIo(env);
      expect(
        await main(["router", "workers", "pair", "worker-1", "--url", url, "--json"], pair),
      ).toBe(0);
      const { pairingCode } = JSON.parse(pair.stdout.join("\n")) as { pairingCode: string };

      const configPath = path.join(dir, "worker.config.json");
      const credentialPath = path.join(dir, "credential.json");
      const setup = captureIo();
      const code = await main(
        [
          "worker",
          "setup",
          "--router",
          url,
          "--pairing-code",
          pairingCode,
          "--config",
          configPath,
          "--credential",
          credentialPath,
        ],
        setup,
      );
      expect(code).toBe(0);
      expect(loadWorkerCredential(credentialPath).workerId).toBe("worker-1");
      expect(loadWorkerConfig(configPath).routerUrl).toBe(url);
      // The token lives only in the credential file, never in the config or the output.
      const { workerToken } = loadWorkerCredential(credentialPath);
      expect(readFileSync(configPath, "utf-8")).not.toContain(workerToken);
      expect(setup.stdout.join("\n")).not.toContain(workerToken);

      const list = captureIo(env);
      expect(await main(["router", "workers", "list", "--url", url], list)).toBe(0);
      expect(list.stdout[0]).toMatch(/^WORKER\s+STATE/);
      expect(list.stdout.some((line) => /^worker-1\s+offline/.test(line))).toBe(true);

      // A second pairing with the same credential path is refused unless --force.
      const again = captureIo();
      expect(
        await main(
          [
            "worker",
            "setup",
            "--pairing-code",
            "x",
            "--config",
            configPath,
            "--credential",
            credentialPath,
          ],
          again,
        ),
      ).toBe(1);
      expect(again.stderr.join("\n")).toContain("already exists");
    });

    it("lists jobs and shows the status summary", async () => {
      await router.seedQueuedJob("KAN-1");
      const env = { GGJIRA_ADMIN_TOKEN: ADMIN_TOKEN };
      const jobs = captureIo(env);
      expect(await main(["router", "jobs", "list", "--url", url], jobs)).toBe(0);
      expect(jobs.stdout.some((line) => line.includes("KAN-1") && line.includes("queued"))).toBe(
        true,
      );

      const status = captureIo(env);
      expect(await main(["router", "status", "--url", url], status)).toBe(0);
      expect(status.stdout.join("\n")).toContain("queued=1");

      const missing = captureIo(env);
      expect(await main(["router", "jobs", "show", "nope", "--url", url], missing)).toBe(1);
      expect(missing.stderr.join("\n")).toContain("404");
    });
  });

  it("worker setup refuses a plain-http Router URL off loopback", async () => {
    const io = captureIo();
    const code = await main(
      [
        "worker",
        "setup",
        "--router",
        "http://router.example.com",
        "--pairing-code",
        "abc",
        "--config",
        path.join(dir, "w.json"),
      ],
      io,
    );
    expect(code).toBe(1);
    expect(io.stderr.join("\n")).toContain("https://");
    expect(existsSync(path.join(dir, "w.json"))).toBe(false);
  });
});
