import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Typed single-row query. Params are SQLInputValue (no `unknown`). */
export function queryOne<T>(
  db: DatabaseSync,
  sql: string,
  ...params: SQLInputValue[]
): T | undefined {
  return db.prepare(sql).get(...params) as unknown as T | undefined;
}

/** Typed multi-row query. */
export function queryAll<T>(
  db: DatabaseSync,
  sql: string,
  ...params: SQLInputValue[]
): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

/** Project root: <root>/backend/{src|dist}/db -> <root>. Works in dev and built. */
export function projectRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', '..');
}

export function migrationsDir(): string {
  return process.env.MIGRATIONS_DIR ?? join(projectRoot(), 'migrations');
}

export function frontendDistDir(): string {
  return join(projectRoot(), 'frontend', 'dist');
}

/** Open the app database with the mandated pragmas. */
export function openDatabase(dbPath: string): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  return db;
}

export interface MigrationResult {
  version: number;
  name: string;
  applied: boolean;
}

/**
 * Apply pending migrations in lexicographic order, each in its own
 * transaction. Idempotent: already-applied versions are skipped after a
 * checksum verification. A changed checksum is a hard error, never a
 * silent skip.
 */
export function runMigrations(
  db: DatabaseSync,
  dir: string = migrationsDir(),
  log: (msg: string) => void = () => {},
): MigrationResult[] {
  db.exec(
    `CREATE TABLE IF NOT EXISTS migrations(
       version INTEGER PRIMARY KEY,
       name TEXT NOT NULL,
       checksum TEXT NOT NULL,
       applied_at TEXT NOT NULL)`,
  );
  const files = readdirSync(dir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();
  const results: MigrationResult[] = [];
  for (const file of files) {
    const version = parseInt(file.split('_')[0]!, 10);
    const sql = readFileSync(join(dir, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const row = db
      .prepare('SELECT checksum FROM migrations WHERE version = ?')
      .get(version) as { checksum: string } | undefined;
    if (row) {
      if (row.checksum !== checksum) {
        throw new Error(
          `MIGRATION_CHECKSUM_MISMATCH: ${file} changed after being applied`,
        );
      }
      results.push({ version, name: file, applied: false });
      continue;
    }
    log(`applying migration ${file}`);
    db.exec('BEGIN;');
    try {
      db.exec(sql);
      db.prepare(
        'INSERT INTO migrations(version, name, checksum, applied_at) VALUES(?, ?, ?, ?)',
      ).run(version, file, checksum, new Date().toISOString());
      db.exec('COMMIT;');
    } catch (err) {
      try {
        db.exec('ROLLBACK;');
      } catch {
        /* already rolled back */
      }
      throw err;
    }
    results.push({ version, name: file, applied: true });
  }
  return results;
}
