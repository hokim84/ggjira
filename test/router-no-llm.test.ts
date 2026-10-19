import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "../src");

function relativeImports(file: string): string[] {
  const source = readFileSync(file, "utf-8");
  return [...source.matchAll(/(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g)]
    .map((match) => match[1] ?? "")
    .filter((specifier) => specifier.startsWith("."));
}

function reachable(entries: string[]): string[] {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of relativeImports(file)) {
      queue.push(path.resolve(path.dirname(file), specifier).replace(/\.js$/, ".ts"));
    }
  }
  return [...seen].map((file) => path.relative(SRC, file).replaceAll("\\", "/"));
}

/**
 * T23 (M4-09/11/12): reporting, the review gate, attention items, the opt-in API and the usage
 * records are plain code. None of them can reach a model call — the Jev client (ADR 0030) or a
 * worker provider.
 */
describe("M4 bookkeeping makes no model calls", () => {
  const entries = [
    "router/report-journal.ts",
    "router/report-processor.ts",
    "router/review-gate.ts",
    "router/attention.ts",
    "router/issue-opt-in.ts",
    "router/github.ts",
    "router/db/execution-records.ts",
    "router/db/attention.ts",
    "router/db/review-targets.ts",
  ].map((file) => path.join(SRC, file));

  it("never reaches Jev or a worker provider", () => {
    const modules = reachable(entries);
    expect(modules.filter((file) => /jev|assessment|^worker\//.test(file))).toEqual([]);
  });
});
