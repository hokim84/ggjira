import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "../src");

/** Relative `import ... from "./x.js"` / `export ... from` specifiers, type-only included (a type
 *  import is still a design dependency worth flagging). */
function relativeImports(file: string): string[] {
  const source = readFileSync(file, "utf-8");
  const specifiers = [...source.matchAll(/(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g)].map(
    (match) => match[1] ?? "",
  );
  return specifiers;
}

function resolveTs(fromFile: string, specifier: string): string {
  return path.resolve(path.dirname(fromFile), specifier).replace(/\.js$/, ".ts");
}

/** Every module reachable from the given entry files, following relative imports only. */
function reachableModules(entries: string[]): { modules: Set<string>; bareImports: Set<string> } {
  const modules = new Set<string>();
  const bareImports = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (modules.has(file)) continue;
    modules.add(file);
    for (const specifier of relativeImports(file)) {
      if (specifier.startsWith(".")) queue.push(resolveTs(file, specifier));
      else bareImports.add(specifier);
    }
  }
  return { modules, bareImports };
}

/**
 * docs/router-service-implementation-plan.md §5 필수 테스트: "Worker 실행 경로에 Jira client·
 * credential·직접 네트워크 호출 의존성이 없음을 검사한다". Walks the static import graph of
 * `src/worker-runtime/` and fails if it reaches Jira, Router-side secrets/DB, or any network
 * module other than the global `fetch` the Router client uses.
 */
describe("worker runtime dependency boundary", () => {
  const runtimeDir = path.join(SRC, "worker-runtime");
  const entries = [
    ...readdirSync(runtimeDir)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => path.join(runtimeDir, name)),
    // The runner takes providers by injection; the provider factory is what the worker entry
    // point wires in, so the CLI providers (and their process spawning) are checked too.
    path.join(SRC, "worker", "factory.ts"),
  ];
  const { modules, bareImports } = reachableModules(entries);
  const relative = [...modules].map((file) => path.relative(SRC, file).replaceAll("\\", "/"));

  it("never reaches the Jira layer", () => {
    expect(relative.filter((file) => file.startsWith("jira/"))).toEqual([]);
  });

  it("never reaches Router internals (secrets, DB, scheduler)", () => {
    expect(relative.filter((file) => file.startsWith("router/"))).toEqual([]);
  });

  it("never reaches the legacy Jira-polling agent/poller/reporter/profile paths", () => {
    const legacy = ["agent/", "poller/", "reporter/", "profile/", "job/", "setup/"];
    expect(relative.filter((file) => legacy.some((prefix) => file.startsWith(prefix)))).toEqual([]);
  });

  it("uses no network module besides the global fetch", () => {
    const network = [
      "node:http",
      "node:https",
      "node:net",
      "node:tls",
      "node:dgram",
      "http",
      "https",
      "undici",
    ];
    expect([...bareImports].filter((specifier) => network.includes(specifier))).toEqual([]);
  });

  it("actually walked the runtime (guards against a vacuous pass)", () => {
    expect(relative).toEqual(
      expect.arrayContaining(["worker-runtime/runner.ts", "worker/spawn.ts", "contracts/api.ts"]),
    );
  });
});
