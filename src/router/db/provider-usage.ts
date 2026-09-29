import type Database from "better-sqlite3";
import { type ProviderUsage, ProviderUsageSchema } from "../../contracts/api.js";

/** Replaces what Router knows of each reported provider's usage for this worker (ADR 0028). */
export function saveProviderUsage(
  db: Database.Database,
  input: { workerId: string; usage: ProviderUsage[]; now: string },
): void {
  const upsert = db.prepare(
    `INSERT INTO worker_provider_usage (worker_id, provider_id, usage_json, reported_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (worker_id, provider_id) DO UPDATE SET
       usage_json = excluded.usage_json,
       reported_at = excluded.reported_at`,
  );
  const run = db.transaction(() => {
    for (const entry of input.usage) {
      upsert.run(input.workerId, entry.providerId, JSON.stringify(entry), input.now);
    }
  });
  run();
}

/** Every worker's latest usage per provider, keyed by workerId. Rows that no longer parse (a
 *  future shape read by an older Router) are skipped. */
export function listProviderUsage(db: Database.Database): Map<string, ProviderUsage[]> {
  const rows = db
    .prepare(
      "SELECT worker_id, usage_json FROM worker_provider_usage ORDER BY worker_id, provider_id",
    )
    .all() as Array<{ worker_id: string; usage_json: string }>;
  const byWorker = new Map<string, ProviderUsage[]>();
  for (const row of rows) {
    const parsed = ProviderUsageSchema.safeParse(JSON.parse(row.usage_json));
    if (!parsed.success) continue;
    const list = byWorker.get(row.worker_id) ?? [];
    list.push(parsed.data);
    byWorker.set(row.worker_id, list);
  }
  return byWorker;
}
