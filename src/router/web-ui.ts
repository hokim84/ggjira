import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply } from "fastify";

/**
 * Serves the build-free web UI (`web/router-ui/`) at `/ui/` (ADR 0023). Resolved from this module
 * so it lands on the repo-root `web/` from both `src/router/` (tsx) and `dist/router/` (build).
 */
export const WEB_UI_ROOT = fileURLToPath(new URL("../../web/router-ui/", import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-cache",
};

/** Resolves a request path inside `root`, or undefined when it would escape it. */
export function resolveUiAsset(root: string, requested: string): string | undefined {
  const relative =
    requested === "" || requested.endsWith("/") ? `${requested}index.html` : requested;
  const resolved = path.resolve(root, relative);
  const base = path.resolve(root);
  return resolved.startsWith(base + path.sep) ? resolved : undefined;
}

async function sendAsset(reply: FastifyReply, root: string, requested: string) {
  const file = resolveUiAsset(root, requested);
  const type = file ? CONTENT_TYPES[path.extname(file)] : undefined;
  if (!file || !type) return reply.code(404).send({ error: "not_found" });
  let body: Buffer;
  try {
    body = await readFile(file);
  } catch {
    return reply.code(404).send({ error: "not_found" });
  }
  return reply.headers(SECURITY_HEADERS).type(type).send(body);
}

export function registerWebUi(app: FastifyInstance, root: string = WEB_UI_ROOT): void {
  app.get("/", async (_request, reply) => reply.redirect("/ui/"));
  app.get("/ui", async (_request, reply) => reply.redirect("/ui/"));
  app.get<{ Params: { "*": string } }>("/ui/*", async (request, reply) =>
    sendAsset(reply, root, request.params["*"]),
  );
}
