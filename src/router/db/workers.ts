import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

export interface WorkerRow {
  id: string;
  name: string;
  enabled: boolean;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  reportedCapabilities: string[];
  reportedRepositoryIds: string[];
  lastHeartbeatAt: string | null;
  lastAssignedAt: string | null;
  currentSessionId: string | null;
}

/** Router stores only this hash, never the token itself (§4 "발급된 워커 token은 hash만 Router에
 *  저장하고 로그에 노출하지 않는다"). Tokens are 32 random bytes, so a plain SHA-256 (no salt,
 *  no KDF) is enough — there's nothing low-entropy to brute-force. */
export function hashWorkerToken(token: string): string {
  return createHash("sha256").update(token, "utf-8").digest("hex");
}

function toWorkerRow(row: Record<string, unknown>): WorkerRow {
  return {
    id: row.id as string,
    name: row.name as string,
    enabled: (row.enabled as number) === 1,
    createdAt: row.created_at as string,
    lastSeenAt: (row.last_seen_at as string | null) ?? null,
    revokedAt: (row.revoked_at as string | null) ?? null,
    reportedCapabilities: JSON.parse(row.reported_capabilities as string) as string[],
    reportedRepositoryIds: JSON.parse(row.reported_repository_ids as string) as string[],
    lastHeartbeatAt: (row.last_heartbeat_at as string | null) ?? null,
    lastAssignedAt: (row.last_assigned_at as string | null) ?? null,
    currentSessionId: (row.current_session_id as string | null) ?? null,
  };
}

export interface RegisterWorkerInput {
  workerId: string;
  name: string;
  tokenHash: string;
  now: string;
}

/**
 * Creates the worker row, or — for a re-pair of an existing workerId — replaces its token hash,
 * clears any revocation, and drops its current session so the old token/session can no longer
 * act. Re-pairing needs a fresh admin-minted code, so it is an explicit admin decision.
 */
export function registerWorker(db: Database.Database, input: RegisterWorkerInput): WorkerRow {
  db.prepare(
    `INSERT INTO workers (id, name, token_hash, enabled, created_at, last_seen_at, revoked_at)
     VALUES (?, ?, ?, 1, ?, ?, NULL)
     ON CONFLICT (id) DO UPDATE SET
       name = excluded.name,
       token_hash = excluded.token_hash,
       revoked_at = NULL,
       current_session_id = NULL,
       last_seen_at = excluded.last_seen_at`,
  ).run(input.workerId, input.name, input.tokenHash, input.now, input.now);
  db.prepare(
    "UPDATE worker_sessions SET superseded_at = ? WHERE worker_id = ? AND superseded_at IS NULL",
  ).run(input.now, input.workerId);

  const worker = getWorker(db, input.workerId);
  if (!worker) throw new Error(`registerWorker: row for ${input.workerId} not found after upsert`);
  return worker;
}

export function getWorker(db: Database.Database, workerId: string): WorkerRow | undefined {
  const row = db.prepare("SELECT * FROM workers WHERE id = ?").get(workerId) as
    | Record<string, unknown>
    | undefined;
  return row ? toWorkerRow(row) : undefined;
}

/** Looks a worker up by the hash of the bearer token it presented. Returns revoked workers too —
 *  the caller decides how to reject them. */
export function findWorkerByTokenHash(
  db: Database.Database,
  tokenHash: string,
): WorkerRow | undefined {
  const row = db.prepare("SELECT * FROM workers WHERE token_hash = ?").get(tokenHash) as
    | Record<string, unknown>
    | undefined;
  return row ? toWorkerRow(row) : undefined;
}

export function listWorkers(db: Database.Database): WorkerRow[] {
  const rows = db.prepare("SELECT * FROM workers ORDER BY id ASC").all() as Record<
    string,
    unknown
  >[];
  return rows.map(toWorkerRow);
}

/** Opens a new session for the worker, superseding every earlier one in the same transaction. */
export function startWorkerSession(
  db: Database.Database,
  input: { sessionId: string; workerId: string; now: string },
): void {
  const run = db.transaction(() => {
    db.prepare(
      "UPDATE worker_sessions SET superseded_at = ? WHERE worker_id = ? AND superseded_at IS NULL",
    ).run(input.now, input.workerId);
    db.prepare(
      "INSERT INTO worker_sessions (id, worker_id, created_at, superseded_at) VALUES (?, ?, ?, NULL)",
    ).run(input.sessionId, input.workerId, input.now);
    db.prepare("UPDATE workers SET current_session_id = ?, last_seen_at = ? WHERE id = ?").run(
      input.sessionId,
      input.now,
      input.workerId,
    );
  });
  run();
}

export function recordWorkerHeartbeat(
  db: Database.Database,
  input: { workerId: string; capabilities: string[]; repositoryIds: string[]; now: string },
): void {
  db.prepare(
    `UPDATE workers SET
       reported_capabilities = ?, reported_repository_ids = ?,
       last_heartbeat_at = ?, last_seen_at = ?
     WHERE id = ?`,
  ).run(
    JSON.stringify(input.capabilities),
    JSON.stringify(input.repositoryIds),
    input.now,
    input.now,
    input.workerId,
  );
}

/** Refreshes liveness without changing reported availability — a worker blocked in a 25s
 *  `jobs/next` long poll can't send its 5s general heartbeat, but the poll itself proves it is
 *  alive. No-op for a worker that has never heartbeated (it has no availability to refresh). */
export function touchWorkerHeartbeat(db: Database.Database, workerId: string, now: string): void {
  db.prepare(
    "UPDATE workers SET last_heartbeat_at = ?, last_seen_at = ? WHERE id = ? AND last_heartbeat_at IS NOT NULL",
  ).run(now, now, workerId);
}

export function markWorkerAssigned(db: Database.Database, workerId: string, now: string): void {
  db.prepare("UPDATE workers SET last_assigned_at = ? WHERE id = ?").run(now, workerId);
}

/** Credential revocation: the token stops authenticating immediately, and the worker's session is
 *  dropped. Cancelling its active attempt is the caller's job (§4 "credential 폐기는 활성 실행에도
 *  취소를 요청한다"). */
export function revokeWorker(db: Database.Database, workerId: string, now: string): void {
  const run = db.transaction(() => {
    db.prepare("UPDATE workers SET revoked_at = ?, current_session_id = NULL WHERE id = ?").run(
      now,
      workerId,
    );
    db.prepare(
      "UPDATE worker_sessions SET superseded_at = ? WHERE worker_id = ? AND superseded_at IS NULL",
    ).run(now, workerId);
  });
  run();
}

export function setWorkerEnabled(db: Database.Database, workerId: string, enabled: boolean): void {
  db.prepare("UPDATE workers SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, workerId);
}
