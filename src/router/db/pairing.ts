import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";

/** docs/router-service-implementation-plan.md §4 "관리 CLI": "pairing code는 관리자 생성, 10분 유효,
 *  한 번만 사용 가능하게 한다". */
export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;

export interface PairingCodeRow {
  code: string;
  workerId: string | null;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
}

export interface CreatePairingCodeInput {
  workerId: string;
  /** ISO timestamp. Caller-supplied so tests can use a fake clock. */
  now: string;
  ttlMs?: number;
  /** Test hook; defaults to 12 random bytes as base64url. */
  genCode?: () => string;
}

/** Why `consumePairingCode` refused a code. Deliberately not exposed to the registering worker
 *  beyond a single generic 401 (an attacker learns nothing about which codes exist). */
export type PairingCodeRejection = "unknown" | "expired" | "used" | "unbound";

export class PairingCodeRejectedError extends Error {
  constructor(readonly reason: PairingCodeRejection) {
    super(`Pairing code rejected: ${reason}`);
    this.name = "PairingCodeRejectedError";
  }
}

function toPairingCodeRow(row: Record<string, unknown>): PairingCodeRow {
  return {
    code: row.code as string,
    workerId: (row.worker_id as string | null) ?? null,
    createdAt: row.created_at as string,
    expiresAt: row.expires_at as string,
    usedAt: (row.used_at as string | null) ?? null,
  };
}

export function createPairingCode(
  db: Database.Database,
  input: CreatePairingCodeInput,
): PairingCodeRow {
  const code = input.genCode ? input.genCode() : randomBytes(12).toString("base64url");
  const expiresAt = new Date(
    Date.parse(input.now) + (input.ttlMs ?? PAIRING_CODE_TTL_MS),
  ).toISOString();
  db.prepare(
    "INSERT INTO pairing_codes (code, worker_id, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, NULL)",
  ).run(code, input.workerId, input.now, expiresAt);
  return { code, workerId: input.workerId, createdAt: input.now, expiresAt, usedAt: null };
}

export function getPairingCode(db: Database.Database, code: string): PairingCodeRow | undefined {
  const row = db.prepare("SELECT * FROM pairing_codes WHERE code = ?").get(code) as
    | Record<string, unknown>
    | undefined;
  return row ? toPairingCodeRow(row) : undefined;
}

/**
 * Marks a code used and returns the workerId it was minted for. The `used_at IS NULL` guard in
 * the UPDATE is what makes the code single-use even if two registrations race: only one UPDATE
 * can match. Call inside the same transaction that issues the worker's token.
 */
export function consumePairingCode(db: Database.Database, code: string, now: string): string {
  const row = getPairingCode(db, code);
  if (!row) throw new PairingCodeRejectedError("unknown");
  if (row.usedAt) throw new PairingCodeRejectedError("used");
  if (Date.parse(row.expiresAt) <= Date.parse(now)) throw new PairingCodeRejectedError("expired");
  if (!row.workerId) throw new PairingCodeRejectedError("unbound");

  const changes = db
    .prepare("UPDATE pairing_codes SET used_at = ? WHERE code = ? AND used_at IS NULL")
    .run(now, code).changes;
  if (changes !== 1) throw new PairingCodeRejectedError("used");
  return row.workerId;
}
