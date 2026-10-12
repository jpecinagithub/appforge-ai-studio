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
CREATE TABLE IF NOT EXISTS revisions(
  id TEXT PRIMARY KEY, project_id TEXT, label TEXT,
  git_sha TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS deployments(
  id TEXT PRIMARY KEY, project_id TEXT, target TEXT,
  status TEXT, url TEXT, created_at TEXT, logs TEXT);
CREATE TABLE IF NOT EXISTS settings(
  id INTEGER PRIMARY KEY CHECK(id=1), data_json TEXT);
CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_run ON run_events(run_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_project ON messages(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_builds_project ON builds(project_id, started_at);
`;

export function openDb(dataDir: string): Database.Database {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'appforge.db'));
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}
