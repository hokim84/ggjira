/**
 * A small glob matcher for a contract's `allowedPaths` (ADR 0036): repository-relative paths with
 * `/` separators, where `**` spans directories, `*` stays within one path segment and `?` is one
 * character. Patterns are anchored at the repository root — `*.md` is a top-level file only, and
 * a leading `**` plus `/*.md` is any Markdown file. Hand-rolled rather than `path.matchesGlob`,
 * which is still experimental (and warns) on the Node versions GGJIRA supports.
 */

/** `./a\\b` → `a/b`: the form both git and the patterns use. */
export function normalizeRepoPath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

export function globToRegExp(pattern: string): RegExp {
  const glob = normalizeRepoPath(pattern);
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i] as string;
    if (char === "*") {
      if (glob[i + 1] === "*") {
        const atSegmentStart = i === 0 || glob[i - 1] === "/";
        const followedBySlash = glob[i + 2] === "/";
        if (atSegmentStart && followedBySlash) {
          // `**/` — zero or more whole directories.
          source += "(?:[^/]+/)*";
          i += 2;
        } else if (atSegmentStart && i + 2 === glob.length) {
          // A trailing `**` — everything below (a bare `**` matches every path).
          source += ".*";
          i += 1;
        } else {
          source += ".*";
          i += 1;
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeRegExp(char);
    }
  }
  return new RegExp(`^${source}$`);
}

/** Whether `filePath` is covered by at least one pattern. An empty pattern list matches nothing;
 *  callers treat "no allowed paths" as "not checked" before calling this. */
export function matchesAnyGlob(filePath: string, patterns: readonly string[]): boolean {
  const normalized = normalizeRepoPath(filePath);
  return patterns.some((pattern) => globToRegExp(pattern).test(normalized));
}
