/**
 * Fase 7A — Snapshot inmutable del proyecto para despliegue.
 *
 * - Cada deployment construye Docker EXCLUSIVAMENTE desde
 *   `$DATA_DIR/deploy-snapshots/<deploymentId>/`. Nunca desde el directorio
 *   mutable del proyecto.
 * - Copia segura: se RECHAZA cualquier symlink (fail closed); no se sigue
 *   ninguno, dentro o fuera del proyecto.
 * - Exclusiones fijas: `.git/`, `node_modules/`, `dist/`, `backups/`,
 *   `data/`, `.env`, `.env.*`, `*.db*`, `*.log`.
 * - Manifiesto ordenado `ruta + tamaño + SHA-256` + hash global
 *   (fingerprint). El fingerprint se re-verifica inmediatamente antes del
 *   `docker build` (TOCTOU).
 * - `.dockerignore` controlado por AppForge con las mismas exclusiones.
 */

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,120}$/;
const MAX_FILE_BYTES = 200 * 1024 * 1024;

const EXCLUDED_DIRS = new Set(['.git', 'node_modules', 'dist', 'backups', 'data']);

export class SnapshotError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SnapshotError';
    this.code = code;
  }
}

export interface SnapshotManifestEntry {
  path: string; // relativa POSIX, ordenada
  size: number;
  sha256: string;
}

export interface SnapshotResult {
  dir: string;
  entries: SnapshotManifestEntry[];
  /** SHA-256 del manifiesto canónico. */
  fingerprint: string;
}

function assertSafeDeploymentId(deploymentId: string): void {
  if (typeof deploymentId !== 'string' || !SAFE_ID.test(deploymentId)) {
    throw new SnapshotError('INVALID_DEPLOYMENT_ID', 'deploymentId must be an internally-derived identifier');
  }
}

function isExcludedDir(name: string): boolean {
  return EXCLUDED_DIRS.has(name);
}

function isExcludedFile(relPosix: string): boolean {
  const base = relPosix.split('/').pop() ?? '';
  if (base === '.env' || base.startsWith('.env.')) return true;
  if (base.endsWith('.log')) return true;
  if (/\.db(-wal|-shm|-journal)?$/.test(base)) return true;
  return false;
}

/** Contenido fijo del .dockerignore controlado por AppForge. */
export const APPFORGE_DOCKERIGNORE = `# Generado por AppForge — no modificar (Fase 7A).
.git/
node_modules/
dist/
backups/
data/
.env
.env.*
*.db
*.db-wal
*.db-shm
*.db-journal
*.log
`;

function canonicalManifestText(entries: SnapshotManifestEntry[]): string {
  return entries.map((e) => `${e.path}\0${e.size}\0${e.sha256}`).join('\n');
}

export function fingerprintOfEntries(entries: SnapshotManifestEntry[]): string {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return createHash('sha256').update(canonicalManifestText(sorted), 'utf8').digest('hex');
}

/**
 * Crea el snapshot inmutable. Falla (fail closed) ante symlinks, rutas que
 * escapan, ficheros gigantes o un destino ya existente.
 */
export function createSnapshot(opts: {
  projectDir: string;
  snapshotsRoot: string;
  deploymentId: string;
}): SnapshotResult {
  const { projectDir, snapshotsRoot, deploymentId } = opts;
  assertSafeDeploymentId(deploymentId);
  const projectRoot = path.resolve(projectDir);
  const destRoot = path.resolve(snapshotsRoot, deploymentId);
  if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
    throw new SnapshotError('PROJECT_NOT_FOUND', `project dir not found: ${projectRoot}`);
  }
  if (fs.existsSync(destRoot)) {
    throw new SnapshotError('SNAPSHOT_EXISTS', 'snapshot already exists; refusing to overwrite');
  }
  fs.mkdirSync(destRoot, { recursive: true });

  const entries: SnapshotManifestEntry[] = [];
  const walk = (dir: string): void => {
    const names = fs.readdirSync(dir).sort();
    for (const name of names) {
      if (name.includes('\0')) {
        throw new SnapshotError('INVALID_NAME', 'file name contains a null byte');
      }
      const abs = path.join(dir, name);
      const rel = path.relative(projectRoot, abs);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new SnapshotError('PATH_ESCAPE', `path escapes project root: ${name}`);
      }
      let st: fs.Stats;
      try {
        st = fs.lstatSync(abs);
      } catch (e) {
        throw new SnapshotError('STAT_FAILED', `cannot stat ${rel}: ${(e as Error).message}`);
      }
      // Fail closed: ningún symlink, ni siquiera interno.
      if (st.isSymbolicLink()) {
        throw new SnapshotError('SYMLINK_REJECTED', `symlinks are not allowed in deploy snapshots: ${rel}`);
      }
      const relPosix = rel.split(path.sep).join('/');
      if (st.isDirectory()) {
        if (isExcludedDir(name)) continue;
        fs.mkdirSync(path.join(destRoot, rel), { recursive: true });
        walk(abs);
      } else if (st.isFile()) {
        if (isExcludedFile(relPosix)) continue;
        if (st.size > MAX_FILE_BYTES) {
          throw new SnapshotError('FILE_TOO_LARGE', `file exceeds snapshot limit: ${rel}`);
        }
        const data = fs.readFileSync(abs);
        const sha256 = createHash('sha256').update(data).digest('hex');
        fs.copyFileSync(abs, path.join(destRoot, rel));
        entries.push({ path: relPosix, size: data.length, sha256 });
      }
      // Otros tipos (sockets, fifos, dispositivos): se ignoran en silencio.
    }
  };
  try {
    walk(projectRoot);
  } catch (e) {
    // Limpieza: no dejar snapshots a medias.
    fs.rmSync(destRoot, { recursive: true, force: true });
    throw e;
  }

  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const fingerprint = fingerprintOfEntries(entries);
  fs.writeFileSync(
    path.join(destRoot, '.appforge-manifest.json'),
    JSON.stringify({ deploymentId, fingerprint, entries }, null, 2),
  );
  fs.writeFileSync(path.join(destRoot, '.dockerignore'), APPFORGE_DOCKERIGNORE);
  return { dir: destRoot, entries, fingerprint };
}

/**
 * Re-verifica un snapshot existente: recalcula el hash del contenido real y
 * lo compara con el manifiesto. Lanza `SnapshotError` ante cualquier
 * divergencia (TOCTOU). Debe llamarse inmediatamente antes del `docker build`.
 */
export function verifySnapshot(dir: string): string {
  const manifestPath = path.join(dir, '.appforge-manifest.json');
  let manifest: { fingerprint: string; entries: SnapshotManifestEntry[] };
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    throw new SnapshotError('MANIFEST_MISSING', 'snapshot manifest not found or invalid');
  }
  const seen = new Set<string>();
  for (const e of manifest.entries) {
    if (typeof e.path !== 'string' || e.path.includes('..') || path.isAbsolute(e.path)) {
      throw new SnapshotError('MANIFEST_INVALID', `bad manifest entry: ${String(e.path)}`);
    }
    seen.add(e.path);
    const abs = path.join(dir, e.path);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(abs);
    } catch {
      throw new SnapshotError('SNAPSHOT_TAMPERED', `snapshot file missing: ${e.path}`);
    }
    if (!st.isFile() || st.isSymbolicLink()) {
      throw new SnapshotError('SNAPSHOT_TAMPERED', `snapshot file replaced: ${e.path}`);
    }
    const data = fs.readFileSync(abs);
    const sha256 = createHash('sha256').update(data).digest('hex');
    if (data.length !== e.size || sha256 !== e.sha256) {
      throw new SnapshotError('SNAPSHOT_TAMPERED', `snapshot file changed: ${e.path}`);
    }
  }
  // Detecta ficheros añadidos tras el manifiesto (excepto los generados).
  const walkCheck = (d: string): void => {
    for (const name of fs.readdirSync(d)) {
      if (name === '.appforge-manifest.json' || name === '.dockerignore') continue;
      const abs = path.join(d, name);
      const rel = path.relative(dir, abs).split(path.sep).join('/');
      const st = fs.lstatSync(abs);
      if (st.isDirectory()) walkCheck(abs);
      else if (!seen.has(rel)) {
        throw new SnapshotError('SNAPSHOT_TAMPERED', `untracked file in snapshot: ${rel}`);
      }
    }
  };
  walkCheck(dir);
  const fingerprint = fingerprintOfEntries(manifest.entries);
  if (fingerprint !== manifest.fingerprint) {
    throw new SnapshotError('SNAPSHOT_TAMPERED', 'snapshot manifest fingerprint mismatch');
  }
  return fingerprint;
}

/** Identificador aleatorio para backups (formato válido `bk_...`). */
export function newBackupId(): string {
  return `bk_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

export function isValidBackupId(id: string | null | undefined): boolean {
  return typeof id === 'string' && /^bk_[A-Za-z0-9_-]{1,64}$/.test(id);
}
