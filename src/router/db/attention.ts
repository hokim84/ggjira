import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

/**
 * What a human has to look at, grouped by incident (migration 12, M4-09, ADR 0041). Recording and
 * resolving here is bookkeeping only: the scheduler never reads it, so resolving an item never
 * starts or approves anything.
 */

export type AttentionKind =
  | "failed"
  | "decision_needed"
  | "scope_deviation"
  | "review_required"
  | "readiness_hold"
  | "report_blocked"
  | "plan_approval_refused";

export type AttentionSeverity = "immediate" | "standard";

export interface AttentionItemRow {
  id: string;
  incidentKey: string;
  issueKey: string;
  approvalId: string | null;
  kind: AttentionKind;
  cause: string;
  severity: AttentionSeverity;
  /** Why it was classified this way, in a sentence. */
  reason: string;
  evidence: unknown;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrences: number;
  status: "open" | "resolved";
  resolvedAt: string | null;
  resolution: string | null;
  /** The resolved occurrence of the same incident this one recurs after. */
  previousId: string | null;
}

/**
 * - `new`: first time this incident is seen.
 * - `recurred`: it was resolved before and is back (a new row linked to the old one).
 * - `changed`: still open, but with new evidence or a different severity — worth telling once.
 * - `repeated`: still open and nothing new — counted, not announced again.
 */
export type AttentionOutcome = "new" | "recurred" | "changed" | "repeated";

function toRow(row: Record<string, unknown>): AttentionItemRow {
  return {
    id: row.id as string,
    incidentKey: row.incident_key as string,
    issueKey: row.issue_key as string,
    approvalId: (row.approval_id as string | null) ?? null,
    kind: row.kind as AttentionKind,
    cause: row.cause as string,
    severity: row.severity as AttentionSeverity,
    reason: row.reason as string,
    evidence: row.evidence ? JSON.parse(row.evidence as string) : null,
    firstSeenAt: row.first_seen_at as string,
    lastSeenAt: row.last_seen_at as string,
    occurrences: row.occurrences as number,
    status: row.status as AttentionItemRow["status"],
    resolvedAt: (row.resolved_at as string | null) ?? null,
    resolution: (row.resolution as string | null) ?? null,
    previousId: (row.previous_id as string | null) ?? null,
  };
}

export function attentionIncidentKey(issueKey: string, kind: AttentionKind, cause: string): string {
  return createHash("sha256").update([issueKey, kind, cause].join("|")).digest("hex").slice(0, 32);
}

/** Collapses what differs between two tellings of the same cause (ids, numbers, whitespace). */
export function normalizeCause(text: string): string {
  return text
    .toLowerCase()
    .replace(/[0-9a-f]{8,}/g, "#")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

export function recordAttention(
  db: Database.Database,
  input: {
    issueKey: string;
    approvalId: string | null;
    kind: AttentionKind;
    cause: string;
    severity: AttentionSeverity;
    reason: string;
    evidence?: unknown;
    now: string;
  },
): { item: AttentionItemRow; outcome: AttentionOutcome } {
  const incidentKey = attentionIncidentKey(input.issueKey, input.kind, input.cause);
  const evidence = input.evidence === undefined ? null : JSON.stringify(input.evidence);
  const run = db.transaction((): { item: AttentionItemRow; outcome: AttentionOutcome } => {
    const open = db
      .prepare("SELECT * FROM attention_items WHERE incident_key = ? AND status = 'open'")
      .get(incidentKey) as Record<string, unknown> | undefined;
    if (open) {
      const changed = (open.evidence ?? null) !== evidence || open.severity !== input.severity;
      db.prepare(
        `UPDATE attention_items SET occurrences = occurrences + 1, last_seen_at = ?, evidence = ?,
           severity = ?, reason = ?, approval_id = ? WHERE id = ?`,
      ).run(input.now, evidence, input.severity, input.reason, input.approvalId, open.id);
      return {
        item: getAttentionItem(db, open.id as string) as AttentionItemRow,
        outcome: changed ? "changed" : "repeated",
      };
    }
    const previous = db
      .prepare(
        "SELECT id FROM attention_items WHERE incident_key = ? ORDER BY last_seen_at DESC, rowid DESC LIMIT 1",
      )
      .get(incidentKey) as { id: string } | undefined;
    const id = randomUUID();
    db.prepare(
      `INSERT INTO attention_items (
        id, incident_key, issue_key, approval_id, kind, cause, severity, reason, evidence,
        first_seen_at, last_seen_at, occurrences, status, previous_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'open', ?)`,
    ).run(
      id,
      incidentKey,
      input.issueKey,
      input.approvalId,
      input.kind,
      input.cause,
      input.severity,
      input.reason,
      evidence,
      input.now,
      input.now,
      previous?.id ?? null,
    );
    return {
      item: getAttentionItem(db, id) as AttentionItemRow,
      outcome: previous ? "recurred" : "new",
    };
  });
  return run();
}

/**
 * Resolves the issue's open items of `kinds`, optionally only those recorded under another
 * approval than `exceptApprovalId`. Returns how many were resolved.
 */
export function resolveAttention(
  db: Database.Database,
  input: {
    issueKey: string;
    kinds: readonly AttentionKind[];
    resolution: string;
    now: string;
    exceptApprovalId?: string;
  },
): number {
  if (input.kinds.length === 0) return 0;
  const kinds = input.kinds.map(() => "?").join(", ");
  const approvalClause =
    input.exceptApprovalId === undefined ? "" : " AND (approval_id IS NULL OR approval_id <> ?)";
  const params: unknown[] = [input.now, input.resolution, input.issueKey, ...input.kinds];
  if (input.exceptApprovalId !== undefined) params.push(input.exceptApprovalId);
  return db
    .prepare(
      `UPDATE attention_items SET status = 'resolved', resolved_at = ?, resolution = ?
       WHERE issue_key = ? AND status = 'open' AND kind IN (${kinds})${approvalClause}`,
    )
    .run(...params).changes;
}

export function resolveAttentionItem(
  db: Database.Database,
  id: string,
  resolution: string,
  now: string,
): boolean {
  return (
    db
      .prepare(
        "UPDATE attention_items SET status = 'resolved', resolved_at = ?, resolution = ? WHERE id = ? AND status = 'open'",
      )
      .run(now, resolution, id).changes > 0
  );
}

export function getAttentionItem(db: Database.Database, id: string): AttentionItemRow | undefined {
  const row = db.prepare("SELECT * FROM attention_items WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? toRow(row) : undefined;
}

/** Newest activity first. */
export function listAttentionItems(
  db: Database.Database,
  filter: { status?: "open" | "resolved"; issueKey?: string; kind?: AttentionKind } = {},
): AttentionItemRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.status) {
    clauses.push("status = ?");
    params.push(filter.status);
  }
  if (filter.issueKey) {
    clauses.push("issue_key = ?");
    params.push(filter.issueKey);
  }
  if (filter.kind) {
    clauses.push("kind = ?");
    params.push(filter.kind);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return (
    db
      .prepare(`SELECT * FROM attention_items ${where} ORDER BY last_seen_at DESC, rowid DESC`)
      .all(...params) as Array<Record<string, unknown>>
  ).map(toRow);
}

export function countOpenAttention(db: Database.Database): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM attention_items WHERE status = 'open'").get() as {
      n: number;
    }
  ).n;
}
