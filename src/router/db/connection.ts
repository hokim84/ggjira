import { backup, DatabaseSync } from "node:sqlite";
import { runMigrations } from "./migrate.js";

/**
 * Router's SQLite store on Node's built-in `node:sqlite` (ADR 0063: no native module to build at
 * install time). Writes go through `db.transaction(...)` and must not await network calls inside
 * one (docs/router-service-implementation-plan.md §3 "네트워크 호출을 DB 트랜잭션 안에서 기다리지
 * 않는다").
 */
export class RouterDatabase extends DatabaseSync {
  private savepoints = 0;

  /** Wraps `fn` so each call runs in one transaction: committed when it returns, rolled back when
   *  it throws. A call made inside another transaction becomes a savepoint of that one. */
  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return (...args: A): R => {
      if (!this.isTransaction) {
        this.exec("BEGIN");
        try {
          const result = fn(...args);
          this.exec("COMMIT");
          return result;
        } catch (error) {
          if (this.isTransaction) this.exec("ROLLBACK");
          throw error;
        }
      }
      const name = `ggjira_sp_${++this.savepoints}`;
      this.exec(`SAVEPOINT ${name}`);
      try {
        const result = fn(...args);
        this.exec(`RELEASE ${name}`);
        return result;
      } catch (error) {
        this.exec(`ROLLBACK TO ${name}`);
        this.exec(`RELEASE ${name}`);
        throw error;
      } finally {
        this.savepoints--;
      }
    };
  }

  /** `PRAGMA <name>`'s single value, e.g. `pragmaValue("foreign_keys")` → 1. */
  pragmaValue(name: string): unknown {
    const row = this.prepare(`PRAGMA ${name}`).get();
    return row === undefined ? undefined : Object.values(row)[0];
  }

  /** Every row `PRAGMA <name>` returns, e.g. `pragmaRows("foreign_key_check")`. */
  pragmaRows(name: string): Record<string, unknown>[] {
    return this.prepare(`PRAGMA ${name}`).all();
  }

  /** An online, consistent copy of the store at `target` via SQLite's backup API. */
  async backupTo(target: string): Promise<void> {
    await backup(this, target);
  }
}

/**
 * Opens (creating if needed) Router's SQLite store with WAL and foreign keys
 * enabled and every pending migration applied (docs/router-service-implementation-plan.md §3
 * "WAL·외래키를 활성화하고 배정은 트랜잭션으로 처리한다").
 */
export function openRouterDb(path: string): RouterDatabase {
  const db = new RouterDatabase(path, { timeout: 5000 });
  db.exec("PRAGMA journal_mode = WAL");
  // better-sqlite3's build default under WAL: no fsync per commit, still safe if the process dies.
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  return db;
}

/** Opens an existing store only to read it, without migrating — for CLI commands that look at
 *  a store a running Router owns. Throws when the file does not exist. */
export function openRouterDbReadOnly(path: string): RouterDatabase {
  return new RouterDatabase(path, { readOnly: true, timeout: 5000 });
}
