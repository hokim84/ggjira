import path from "node:path";
import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { registerWebUi, resolveUiAsset, WEB_UI_ROOT } from "../src/router/web-ui.js";

describe("web UI static serving", () => {
  const app = Fastify();
  registerWebUi(app);

  afterAll(async () => {
    await app.close();
  });

  it("serves index.html at /ui/ with security headers", async () => {
    const response = await app.inject({ method: "GET", url: "/ui/" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.body).toContain('<script type="module" src="app.js">');
  });

  it("serves module scripts and styles with their content types", async () => {
    const js = await app.inject({ method: "GET", url: "/ui/app.js" });
    expect(js.statusCode).toBe(200);
    expect(js.headers["content-type"]).toContain("text/javascript");
    const css = await app.inject({ method: "GET", url: "/ui/style.css" });
    expect(css.headers["content-type"]).toContain("text/css");
  });

  it("redirects / and /ui to /ui/", async () => {
    for (const url of ["/", "/ui"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe("/ui/");
    }
  });

  it("refuses paths outside the UI directory and unknown files", async () => {
    for (const url of [
      "/ui/../package.json",
      "/ui/%2e%2e/%2e%2e/package.json",
      "/ui/..%2f..%2fpackage.json",
      "/ui/missing.js",
      "/ui/README.md",
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(404);
    }
  });

  it("resolveUiAsset keeps every path inside the root", () => {
    const root = WEB_UI_ROOT;
    expect(resolveUiAsset(root, "")).toBe(path.join(root, "index.html"));
    expect(resolveUiAsset(root, "../../package.json")).toBeUndefined();
    expect(resolveUiAsset(root, "/etc/passwd")).toBeUndefined();
  });
});
