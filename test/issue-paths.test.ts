import { describe, expect, it } from "vitest";
import { globToRegExp, matchesAnyGlob, normalizeRepoPath } from "../src/issue/paths.js";

describe("allowedPaths globs (ADR 0036)", () => {
  it.each([
    ["src/**", "src/a.ts", true],
    ["src/**", "src/router/deep/a.ts", true],
    ["src/**", "srcx/a.ts", false],
    ["src/**", "test/src/a.ts", false],
    ["src/*.ts", "src/a.ts", true],
    ["src/*.ts", "src/router/a.ts", false],
    ["**/*.md", "README.md", true],
    ["**/*.md", "docs/decisions/0036.md", true],
    ["**/*.md", "docs/a.mdx", false],
    ["*.md", "README.md", true],
    ["*.md", "docs/README.md", false],
    ["test/**/*.test.ts", "test/a.test.ts", true],
    ["test/**/*.test.ts", "test/helpers/a.test.ts", true],
    ["src/?.ts", "src/a.ts", true],
    ["src/?.ts", "src/ab.ts", false],
    ["docs/a+b(1).md", "docs/a+b(1).md", true],
    ["**", "anything/at/all.txt", true],
  ])("%s against %s → %s", (pattern, file, expected) => {
    expect(matchesAnyGlob(file, [pattern])).toBe(expected);
  });

  it("normalizes Windows separators and a leading ./", () => {
    expect(normalizeRepoPath(".\\src\\a.ts")).toBe("src/a.ts");
    expect(matchesAnyGlob("src\\router\\a.ts", ["./src/**"])).toBe(true);
  });

  it("matches nothing with no patterns", () => {
    expect(matchesAnyGlob("src/a.ts", [])).toBe(false);
  });

  it("anchors patterns at both ends", () => {
    expect(globToRegExp("src/a.ts").test("src/a.ts.bak")).toBe(false);
  });
});
