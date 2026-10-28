import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { routerConfigTemplate } from "../src/router/config-store.js";
import { loadRouterConfig } from "../src/router/config.js";
import { RouterConfigSchema } from "../src/router/config.js";
import { resolveWorkerConfig } from "../src/worker-runtime/config.js";

const ROOT = path.resolve(__dirname, "..");

/** The shipped examples and templates are what operators copy first; they must stay loadable. */
describe("example configs", () => {
  it("deploy/router.config.example.json is a valid container config", () => {
    const config = loadRouterConfig(path.join(ROOT, "deploy/router.config.example.json"));
    expect(config.db.path).toBe("/data/router.sqlite3");
    expect(config.http.host).toBe("0.0.0.0");
  });

  it("worker.config.example.json is valid and clones into the worker home", () => {
    const raw = JSON.parse(readFileSync(path.join(ROOT, "worker.config.example.json"), "utf8"));
    const home = path.resolve("/srv/ggjira-worker");
    expect(resolveWorkerConfig(raw, home).repositories[0]?.path).toBe(
      path.join(home, "repositories", "main-repo", "repo"),
    );
  });

  it("the `router setup` template is valid", () => {
    expect(RouterConfigSchema.safeParse(routerConfigTemplate()).success).toBe(true);
  });
});
