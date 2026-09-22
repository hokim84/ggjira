import Database from "better-sqlite3";
import { runMigrations } from "./migrate.js";

/**
 * Opens (creating if needed) Router's SQLite store with WAL and foreign keys
 * enabled and every pending migration applied (docs/router-service-implementation-plan.md §3
 * "WAL·외래키를 활성화하고 배정은 트랜잭션으로 처리한다"). Callers do writes through
 * `db.transaction(...)` and must not await network calls inside one (§3
 * "네트워크 호출을 DB 트랜잭션 안에서 기다리지 않는다").
 */
export function openRouterDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}
