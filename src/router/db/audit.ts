import type Database from "better-sqlite3";

export interface AuditEntry {
  id: number;
  at: string;
  actor: string | null;
  action: string;
  subject: string | null;
  detail: unknown;
}

/** Appends to the `audit_log` table (§3 "감사 기록"): who confirmed a stop, retried a job or a
 *  report, and when. Append-only; nothing reads it back to make decisions. */
export function appendAudit(
  db: Database.Database,
  entry: { at: string; actor: string; action: string; subject: string; detail?: unknown },
): void {
  db.prepare(
    "INSERT INTO audit_log (at, actor, action, subject, detail) VALUES (?, ?, ?, ?, ?)",
  ).run(
    entry.at,
    entry.actor,
    entry.action,
    entry.subject,
    entry.detail === undefined ? null : JSON.stringify(entry.detail),
  );
}

export function listAudit(db: Database.Database, subject?: string): AuditEntry[] {
  const rows = (
    subject
      ? db.prepare("SELECT * FROM audit_log WHERE subject = ? ORDER BY id ASC").all(subject)
      : db.prepare("SELECT * FROM audit_log ORDER BY id ASC").all()
  ) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: row.id as number,
    at: row.at as string,
    actor: (row.actor as string | null) ?? null,
    action: row.action as string,
    subject: (row.subject as string | null) ?? null,
    detail: row.detail ? JSON.parse(row.detail as string) : null,
  }));
}
