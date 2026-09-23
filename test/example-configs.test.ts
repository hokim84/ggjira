import path from "node:path";
import { describe, expect, it } from "vitest";
import { routerConfigTemplate } from "../src/router/cli.js";
import { loadRouterConfig } from "../src/router/config.js";
import { RouterConfigSchema } from "../src/router/config.js";
import { loadWorkerConfig } from "../src/worker-runtime/config.js";

const ROOT = path.resolve(__dirname, "..");

/** The shipped examples and templates are what operators copy first; they must stay loadable. */
describe("example configs", () => {
  it("deploy/router.config.example.json is a valid container config", () => {
    const config = loadRouterConfig(path.join(ROOT, "deploy/router.config.example.json"));
    expect(config.db.path).toBe("/data/router.sqlite3");
    expect(config.http.host).toBe("0.0.0.0");
  });

  it("worker.config.example.json is valid", () => {
    expect(loadWorkerConfig(path.join(ROOT, "worker.config.example.json")).dataDir).toBe(
      "data/worker",
    );
  });

  it("the `router setup` template is valid", () => {
    expect(RouterConfigSchema.safeParse(routerConfigTemplate()).success).toBe(true);
  });
});
