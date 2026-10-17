/**
 * Fase 6 — Receipts persistidos de verificación 5A/5B (revisión Codex).
 *
 * Los receipts en memoria (`ctx.dynamicChecks`) no sobreviven al proceso y
 * no son visibles desde la ruta HTTP. Esta tabla es la fuente AUTORITATIVA
 * para `POST /api/projects/:id/deploy`: el deployment solo se crea si los
 * SEIS checks están vigentes sobre las fuentes actuales y en orden canónico.
 *
 * Cada receipt contiene: check_key, fingerprint de las fuentes en el
 * momento del check, seq (= índice canónico, ver DYNAMIC_CHECK_ORDER) y
 * fecha. Registrar un check borra el propio y sus seguidores canónicos
 * (igual que el gate en memoria); cualquier mutación invalida el primer
 * check afectado y sus seguidores.
 *
 * Solo almacenamiento: la semántica de fingerprints y el gate viven en
 * `dynamicTools.ts` (evita ciclos de importación).
 */

import type Database from 'better-sqlite3';
import type { DynamicCheckKey } from '../dynamicTools.js';
import { nowIso } from '../tools.js';

export interface VerificationReceipt {
  projectId: string;
  checkKey: DynamicCheckKey;
  fingerprint: string;
  seq: number;
  createdAt: string;
}

export function ensureVerificationReceiptsTable(db: Database.Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS verification_receipts(
       project_id TEXT NOT NULL,
       check_key TEXT NOT NULL,
       fingerprint TEXT NOT NULL,
       seq INTEGER NOT NULL,
       created_at TEXT NOT NULL,
       PRIMARY KEY (project_id, check_key))`,
  );
}

/** Inserta o reemplaza el receipt de un check (llamador: `recordDynamicCheck`). */
export function recordVerificationReceipt(
  db: Database.Database,
  projectId: string,
  checkKey: DynamicCheckKey,
  fingerprint: string,
  seq: number,
): void {
  ensureVerificationReceiptsTable(db);
  db.prepare(
    `INSERT INTO verification_receipts(project_id, check_key, fingerprint, seq, created_at)
     VALUES (?,?,?,?,?)
     ON CONFLICT(project_id, check_key) DO UPDATE SET
       fingerprint=excluded.fingerprint, seq=excluded.seq, created_at=excluded.created_at`,
  ).run(projectId, checkKey, fingerprint, seq, nowIso());
}

/** Borra los receipts de los checks indicados (invalidación). */
export function deleteVerificationReceipts(
  db: Database.Database,
  projectId: string,
  checkKeys: readonly DynamicCheckKey[],
): void {
  if (checkKeys.length === 0) return;
  ensureVerificationReceiptsTable(db);
  const placeholders = checkKeys.map(() => '?').join(',');
  db.prepare(
    `DELETE FROM verification_receipts WHERE project_id=? AND check_key IN (${placeholders})`,
  ).run(projectId, ...checkKeys);
}

/** Receipts ordenados por seq (orden canónico de completitud). */
export function listVerificationReceipts(db: Database.Database, projectId: string): VerificationReceipt[] {
  ensureVerificationReceiptsTable(db);
  const rows = db
    .prepare(
      `SELECT project_id, check_key, fingerprint, seq, created_at
       FROM verification_receipts WHERE project_id=? ORDER BY seq ASC`,
    )
    .all(projectId) as Array<{
    project_id: string;
    check_key: string;
    fingerprint: string;
    seq: number;
    created_at: string;
  }>;
  return rows.map((r) => ({
    projectId: r.project_id,
    checkKey: r.check_key as DynamicCheckKey,
    fingerprint: r.fingerprint,
    seq: Number(r.seq),
    createdAt: r.created_at,
  }));
}
