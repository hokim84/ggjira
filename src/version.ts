/**
 * GGJIRA's own version, written to Workspace Configuration / Agent Profile
 * registration data in Jira. Kept as a small constant rather than read from
 * package.json at runtime (which would need JSON-module import support and
 * a stable relative path from both `tsx src/cli.ts` and the built
 * `dist/cli.js`). Bump alongside package.json's "version" field.
 */
export const GGJIRA_VERSION = "0.1.0";
