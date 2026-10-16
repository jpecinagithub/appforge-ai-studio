import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export interface SessionInfo {
  sessionId: string;
  userId: string;
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Create a session row; returns the raw token (only ever shown once). */
export function createSession(
  db: DatabaseSync,
  userId: string,
  ttlDays: number,
): { token: string; expiresAt: string } {
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + ttlDays * 86_400_000,
  ).toISOString();
  db.prepare(
    `INSERT INTO sessions(id, user_id, token_hash, created_at, expires_at, last_seen_at)
     VALUES(?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    userId,
    tokenHash(token),
    now.toISOString(),
    expiresAt,
    now.toISOString(),
  );
  return { token, expiresAt };
}

/** Validate a raw token; touches last_seen_at. Null when missing/expired. */
export function verifySession(
  db: DatabaseSync,
  token: string,
): SessionInfo | null {
  const row = db
    .prepare(
      `SELECT id, user_id FROM sessions
       WHERE token_hash = ? AND expires_at > ?`,
    )
    .get(tokenHash(token), new Date().toISOString()) as
    | { id: string; user_id: string }
    | undefined;
  if (!row) return null;
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(
    new Date().toISOString(),
    row.id,
  );
  return { sessionId: row.id, userId: row.user_id };
}

/** Revoke a session immediately (logout). Idempotent. */
export function revokeSession(db: DatabaseSync, token: string): void {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(
    tokenHash(token),
  );
}
