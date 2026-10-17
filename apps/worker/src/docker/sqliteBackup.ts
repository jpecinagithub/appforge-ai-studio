/**
 * Fase 7A — Backup y restauración SQLite real.
 *
 * - El backup copia `app.db*` desde el volumen del proyecto al
 *   almacenamiento del Studio mediante `docker cp` (operación fija,
 *   orquestada por `dockerDriver.ts`).
 * - Cada backup: SHA-256 por fichero + manifiesto JSON + `PRAGMA quick_check`
 *   con `node:sqlite` (código confiable, nunca código del proyecto).
 * - `backupId` con formato `bk_[A-Za-z0-9_-]{1,64}`; `backupValidated='true'`
 *   solo después de validar todos los pasos.
 * - Primer despliegue: backup validado con `hadDatabase=false`; restaurar
 *   significa devolver el volumen a estado vacío.
 * - Retención: últimas 10 copias, sin borrar backups requeridos por
 *   despliegues activos o por `previous_image`.
 */

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class BackupError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'BackupError';
    this.code = code;
  }
}

const BACKUP_ID_RE = /^bk_[A-Za-z0-9_-]{1,64}$/;

export function isValidBackupId(id: string | null | undefined): boolean {
  return typeof id === 'string' && BACKUP_ID_RE.test(id);
}

export function newBackupId(): string {
  return `bk_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

export interface BackupFileEntry {
  name: string;
  size: number;
  sha256: string;
}

export interface BackupManifest {
  backupId: string;
  projectId: string;
  deploymentId: string;
  createdAt: string;
  hadDatabase: boolean;
  files: BackupFileEntry[];
}

export function sha256File(absPath: string): { size: number; sha256: string } {
  const data = fs.readFileSync(absPath);
  return { size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
}

/**
 * Valida una SQLite con `PRAGMA quick_check` (solo lectura). Lanza
 * `BackupError` si la BD está corrupta o no es una SQLite válida.
 */
export function quickCheck(dbPath: string): void {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare('PRAGMA quick_check').all() as Array<Record<string, unknown>>;
    const bad = rows.filter((r) => String(Object.values(r)[0] ?? '').toLowerCase() !== 'ok');
    if (bad.length > 0) {
      throw new BackupError(
        'QUICK_CHECK_FAILED',
        `PRAGMA quick_check failed: ${JSON.stringify(bad).slice(0, 300)}`,
      );
    }
  } catch (e) {
    if (e instanceof BackupError) throw e;
    throw new BackupError('QUICK_CHECK_FAILED', `PRAGMA quick_check error: ${(e as Error).message.slice(0, 300)}`);
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

/** Directorio del backup: `$DATA_DIR/project-backups/<projectId>/<backupId>/`. */
export function backupDirFor(dataDir: string, projectId: string, backupId: string): string {
  if (!isValidBackupId(backupId)) throw new BackupError('INVALID_BACKUP_ID', 'invalid backupId');
  return path.join(dataDir, 'project-backups', projectId, backupId);
}

export function writeBackupManifest(dir: string, manifest: BackupManifest): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'backup.json'), JSON.stringify(manifest, null, 2));
}

export function readBackupManifest(dir: string): BackupManifest {
  const raw = fs.readFileSync(path.join(dir, 'backup.json'), 'utf8');
  const m = JSON.parse(raw) as BackupManifest;
  if (!isValidBackupId(m.backupId) || !Array.isArray(m.files)) {
    throw new BackupError('MANIFEST_INVALID', 'backup manifest is invalid');
  }
  return m;
}

/**
 * Retención: conserva las últimas 10 copias más los `protectedIds`
 * (backups requeridos por despliegues activos o por `previous_image`).
 * Devuelve la lista de backupIds eliminados.
 */
export function enforceRetention(opts: {
  dataDir: string;
  projectId: string;
  protectedIds?: Set<string>;
  keep?: number;
}): string[] {
  const { dataDir, projectId, protectedIds, keep = 10 } = opts;
  const root = path.join(dataDir, 'project-backups', projectId);
  if (!fs.existsSync(root)) return [];
  const ids = fs
    .readdirSync(root)
    .filter((n) => isValidBackupId(n) && fs.statSync(path.join(root, n)).isDirectory())
    .map((id) => {
      let mtime = 0;
      try {
        mtime = fs.statSync(path.join(root, id, 'backup.json')).mtimeMs;
      } catch {
        mtime = fs.statSync(path.join(root, id)).mtimeMs;
      }
      return { id, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
  const keepSet = new Set<string>();
  for (const { id } of ids.slice(0, keep)) keepSet.add(id);
  for (const id of protectedIds ?? []) keepSet.add(id);
  const removed: string[] = [];
  for (const { id } of ids) {
    if (!keepSet.has(id)) {
      fs.rmSync(path.join(root, id), { recursive: true, force: true });
      removed.push(id);
    }
  }
  return removed;
}
