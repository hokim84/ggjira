/** True for a SQLite `UNIQUE` constraint violation from better-sqlite3 (a partial
 *  unique index in `schema.ts` rejecting an insert), false for anything else. */
export function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}
