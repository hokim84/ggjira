/** SQLite's extended result code for a `UNIQUE` constraint violation. */
const SQLITE_CONSTRAINT_UNIQUE = 2067;

/** True for a SQLite `UNIQUE` constraint violation from node:sqlite (a partial unique index in
 *  `schema.ts` rejecting an insert), false for anything else. */
export function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    "errcode" in error &&
    (error as { errcode?: unknown }).errcode === SQLITE_CONSTRAINT_UNIQUE
  );
}
