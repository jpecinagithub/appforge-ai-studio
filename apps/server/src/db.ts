/**
 * SQLite (WAL mode) for the studio. Schema follows CONTRACT.md §2 exactly.
 * Idempotent: CREATE TABLE IF NOT EXISTS.
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects(
  id TEXT PRIMARY KEY, name TEXT, description TEXT,
  type TEXT DEFAULT 'static', status TEXT DEFAULT 'active',
  model TEXT, created_at TEXT, updated_at TEXT,
  preview_url TEXT, production_url TEXT, config_json TEXT);
CREATE TABLE IF NOT EXISTS messages(
  id TEXT PRIMARY KEY, project_id TEXT, role TEXT, content TEXT,
  created_at TEXT, tokens INTEGER);
CREATE TABLE IF NOT EXISTS runs(
  id TEXT PRIMARY KEY, project_id TEXT, prompt TEXT, status TEXT,
  created_at TEXT, started_at TEXT, finished_at TEXT,
  stats_json TEXT, error TEXT);
CREATE TABLE IF NOT EXISTS run_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, seq INTEGER,
  kind TEXT, payload_json TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS builds(
  id TEXT PRIMARY KEY, project_id TEXT, status TEXT,
  started_at TEXT, finished_at TEXT, duration_ms INTEGER,
  logs TEXT, artifacts_json TEXT, error TEXT);
CREATE TABLE IF NOT EXISTS migrations(
  id TEXT PRIMARY KEY, project_id TEXT, version INTEGER, name TEXT,
  status TEXT, started_at TEXT, finished_at TEXT,
  duration_ms INTEGER, logs TEXT, error TEXT);
CREATE TABLE IF NOT EXISTS revisions(
  id TEXT PRIMARY KEY, project_id TEXT, label TEXT,
  git_sha TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS deployments(
  id TEXT PRIMARY KEY, project_id TEXT, target TEXT,
  status TEXT, url TEXT, created_at TEXT, logs TEXT);
CREATE TABLE IF NOT EXISTS deployment_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, deployment_id TEXT NOT NULL, seq INTEGER NOT NULL,
  phase TEXT NOT NULL, event TEXT NOT NULL, status TEXT,
  started_at TEXT, finished_at TEXT, duration_ms INTEGER,
  output TEXT, error TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS project_runtime(
  project_id TEXT PRIMARY KEY, container_name TEXT, live_image TEXT,
  previous_image TEXT, status TEXT, updated_at TEXT);
-- Fase 6 (revisión Codex): receipts persistidos autoritativos de la puerta
-- de verificación 5A/5B (los seis checks, con fingerprint, seq y fecha).
CREATE TABLE IF NOT EXISTS verification_receipts(
  project_id TEXT NOT NULL, check_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
  seq INTEGER NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, check_key));
CREATE TABLE IF NOT EXISTS settings(
  id INTEGER PRIMARY KEY CHECK(id=1), data_json TEXT);
CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_run ON run_events(run_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_project ON messages(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_builds_project ON builds(project_id, started_at);
CREATE INDEX IF NOT EXISTS idx_migrations_project ON migrations(project_id, started_at);
CREATE INDEX IF NOT EXISTS idx_deployment_events_deployment ON deployment_events(deployment_id, seq);
-- Fase 6: garantía transaccional — como máximo un deployment no terminal
-- por proyecto (el índice parcial convierte la carrera en un error estable).
CREATE UNIQUE INDEX IF NOT EXISTS uq_deployments_active_project
  ON deployments(project_id)
  WHERE status IN ('pending','building','migrating','verifying','promoting');
`;

/** Fase 6: columnas aditivas no destructivas sobre deployments existentes. */
const DEPLOYMENTS_PHASE6_COLUMNS: Array<[string, string]> = [
  ['candidate_id', 'TEXT'],
  ['previous_live_version', 'TEXT'],
  ['backup_id', 'TEXT'],
  ['cancel_requested', 'INTEGER DEFAULT 0'],
  ['started_at', 'TEXT'],
  ['updated_at', 'TEXT'],
  ['finished_at', 'TEXT'],
  ['error', 'TEXT'],
];

function addMissingColumns(db: Database.Database): void {
  const existing = new Set(
    (db.prepare('PRAGMA table_info(deployments)').all() as Array<{ name: string }>).map((c) => c.name),
  );
  for (const [col, ddl] of DEPLOYMENTS_PHASE6_COLUMNS) {
    if (!existing.has(col)) db.exec(`ALTER TABLE deployments ADD COLUMN ${col} ${ddl}`);
  }
}

export function openDb(dataDir: string): Database.Database {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'appforge.db'));
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  addMissingColumns(db);
  return db;
}
