/**
 * Flexibilidad agéntica (§4.2) — intervention-ladder behaviour not pinned
 * by the older suites:
 *
 *  - Step 2 of the ladder COMPACTS the context: after the second stuck
 *    signal without progress, the next model call receives a fresh
 *    recovery history (system + RECOVERY MODE summary) followed by the
 *    reinforced STUCK SIGNAL directive.
 *  - The ladder still ends the run at step 3 (LOOP_EXHAUSTED) when no
 *    progress happens between signals.
 *
 * (Progress resetting the ladder is pinned in dynamicGate.test.ts:
 * "signature ×3 injects a directive and the run continues…"; restore on
 * LOOP_EXHAUSTED / TOKEN_BUDGET_EXHAUSTED is pinned in
 * agentSafetyNet.test.ts.)
 */
import { beforeAll, afterAll, beforeEach, expect, it, vi, describe } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { LlmMessage, LlmResponse } from 'appforge-shared';

const { model } = vi.hoisted(() => ({ model: vi.fn() }));
vi.mock('./llm.js', async (importOriginal) => {
  const o = await importOriginal<typeof import('./llm.js')>();
  return { ...o, isStubMode: () => false, chatLlm: (...args: unknown[]) => (model as (...a: unknown[]) => Promise<LlmResponse>)(...args) };
});

import { runAgentOnce, type AgentSettings } from './agent.js';

// ---------------------------------------------------------------------------
// Minimal dynamic fixture (same shape as dynamicGate.test.ts)
// ---------------------------------------------------------------------------

const BACKEND_BUILD_JS = `
import { mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'dist'), { recursive: true });
copyFileSync(join(root, 'scripts', 'fake-server.js'), join(root, 'dist', 'server.js'));
console.log('backend build ok');
`;

const BUILD_JS = `
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist', 'index.html'), '<html>ok</html>');
console.log('build ok');
`;

const MIGRATE_JS = `
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = process.env.DB_PATH;
if (!dbPath) { console.error('DB_PATH is required'); process.exit(1); }
const db = new DatabaseSync(dbPath);
db.exec('CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)');
const files = readdirSync(join(root, 'migrations')).filter((f) => /^\\d+_.+\\.sql$/.test(f)).sort();
let fresh = 0;
for (const file of files) {
  const row = db.prepare('SELECT checksum FROM migrations WHERE name=?').get(file);
  if (row) { console.log('already applied: ' + file); continue; }
  const sql = readFileSync(join(root, 'migrations', file), 'utf8');
  db.exec(sql);
  db.prepare('INSERT INTO migrations(version,name,checksum,applied_at) VALUES (?,?,?,?)')
    .run(Number(file.split('_')[0]), file, 'x', new Date().toISOString());
  console.log('applied: ' + file);
  fresh++;
}
console.log('done: ' + fresh + ' new migration(s)');
db.close();
`;

const TESTS_JS = `
console.log('\\u2139 tests 2');
console.log('\\u2139 pass 2');
console.log('\\u2139 fail 0');
`;

const LOCK = (name: string) =>
  JSON.stringify({ name, version: '0.1.0', lockfileVersion: 3, packages: { '': { name, version: '0.1.0' } } });

function makeGateProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-flex-'));
  const fe = path.join(dir, 'frontend');
  const be = path.join(dir, 'backend');
  fs.mkdirSync(path.join(fe, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(be, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'migrations'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(fe, 'package.json'), JSON.stringify({ name: 'fx-fe', version: '0.1.0', scripts: { build: 'node scripts/build.mjs' } }));
  fs.writeFileSync(path.join(be, 'package.json'), JSON.stringify({ name: 'fx-be', version: '0.1.0', scripts: { build: 'node scripts/build.mjs' } }));
  fs.writeFileSync(path.join(fe, 'package-lock.json'), LOCK('fx-fe'));
  fs.writeFileSync(path.join(be, 'package-lock.json'), LOCK('fx-be'));
  fs.writeFileSync(path.join(fe, 'scripts', 'build.mjs'), BUILD_JS);
  fs.writeFileSync(path.join(be, 'scripts', 'build.mjs'), BACKEND_BUILD_JS);
  fs.writeFileSync(path.join(be, 'scripts', 'fake-server.js'), 'export {};');
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'fx', version: '0.1.0', scripts: { migrate: 'node scripts/migrate.mjs', test: 'node scripts/tests.mjs' } }),
  );
  fs.writeFileSync(path.join(dir, 'scripts', 'migrate.mjs'), MIGRATE_JS);
  fs.writeFileSync(path.join(dir, 'scripts', 'tests.mjs'), TESTS_JS);
  fs.writeFileSync(path.join(dir, 'migrations', '001_init.sql'), 'CREATE TABLE notes(id TEXT PRIMARY KEY);');
  return dir;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const DDL = `
CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT, description TEXT, type TEXT DEFAULT 'static', status TEXT DEFAULT 'active', model TEXT, created_at TEXT, updated_at TEXT, preview_url TEXT, production_url TEXT, config_json TEXT);
CREATE TABLE messages(id TEXT PRIMARY KEY, project_id TEXT, role TEXT, content TEXT, created_at TEXT, tokens INTEGER);
CREATE TABLE runs(id TEXT PRIMARY KEY, project_id TEXT, prompt TEXT, status TEXT, created_at TEXT, started_at TEXT, finished_at TEXT, stats_json TEXT, error TEXT);
CREATE TABLE run_events(id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, seq INTEGER, kind TEXT, payload_json TEXT, created_at TEXT);
CREATE TABLE builds(id TEXT PRIMARY KEY, project_id TEXT, status TEXT, started_at TEXT, finished_at TEXT, duration_ms INTEGER, logs TEXT, artifacts_json TEXT, error TEXT);
CREATE TABLE migrations(id TEXT PRIMARY KEY, project_id TEXT, version INTEGER, name TEXT, status TEXT, started_at TEXT, finished_at TEXT, duration_ms INTEGER, logs TEXT, error TEXT);
CREATE TABLE revisions(id TEXT PRIMARY KEY, project_id TEXT, label TEXT, git_sha TEXT, created_at TEXT);
CREATE TABLE settings(id INTEGER PRIMARY KEY CHECK(id=1), data_json TEXT);
`;

const settings: AgentSettings = {
  provider: 'groq', model: 'test', temperature: 0, maxTokens: 8000,
  maxIterations: 30, llmTimeoutMs: 30000, cmdTimeoutMs: 60000, runTimeoutMs: 300000,
  language: 'en', autoRevision: false,
};

let db: Database.Database;
let dataDir: string;
const tmpDirs: string[] = [];

const toolCall = (name: string, args: Record<string, unknown> = {}): LlmResponse => ({
  content: null, toolCalls: [{ id: `tc-${name}-${Math.random()}`, name, arguments: args }],
  usage: { promptTokens: 1, completionTokens: 1 },
});
const final = (content = 'Done.'): LlmResponse => ({ content, toolCalls: [], usage: { promptTokens: 1, completionTokens: 1 } });

beforeAll(() => {
  vi.stubEnv('GROQ_API_KEY', 'test-key');
  vi.stubEnv('APPFORGE_LLM_STUB', '');
});

afterAll(() => {
  vi.unstubAllEnvs();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

beforeEach(() => {
  model.mockReset();
  db = new Database(':memory:');
  db.exec(DDL);
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-flex-data-'));
  tmpDirs.push(dataDir);
});

function setupRun(projectDir: string): string {
  const projectId = `proj-${Math.random().toString(36).slice(2)}`;
  const runId = `run-${Math.random().toString(36).slice(2)}`;
  db.prepare('INSERT INTO projects(id, name, type, status) VALUES (?,?,?,?)').run(projectId, 'Flex project', 'dynamic', 'active');
  db.prepare('INSERT INTO runs(id, project_id, prompt, status, created_at) VALUES (?,?,?,?,?)')
    .run(runId, projectId, 'Build my app', 'queued', new Date().toISOString());
  fs.mkdirSync(path.join(dataDir, 'projects', projectId), { recursive: true });
  fs.cpSync(projectDir, path.join(dataDir, 'projects', projectId), { recursive: true });
  return runId;
}

function eventPayloads(runId: string, kind: string): Array<Record<string, unknown>> {
  const rows = db.prepare('SELECT payload_json FROM run_events WHERE run_id=? AND kind=?').all(runId, kind) as Array<{ payload_json: string }>;
  return rows.map((r) => { try { return JSON.parse(r.payload_json) as Record<string, unknown>; } catch { return {}; } });
}

describe('intervention ladder', () => {
  it('step 2 compacts the context: the next completion gets a recovery history plus the reinforced directive', async () => {
    const runId = setupRun(makeGateProject());
    const seenMessages: LlmMessage[][] = [];
    let n = 0;
    model.mockImplementation(async (...args: unknown[]) => {
      seenMessages.push(args[1] as LlmMessage[]);
      n++;
      // One real edit so verify() engages; then pure finish attempts —
      // identical diagnostic, no progress: signature signals at
      // verifications 3 and 6 (iterations 4 and 7); the stagnation
      // detector fires the third signal at verification 7 (iteration 8).
      if (n === 1) return toolCall('write_file', { area: 'backend', path: 'src/domain.ts', content: 'export const implemented = true;' });
      return final('Done.');
    });
    await runAgentOnce(db, runId, { dataDir, settings });

    const row = db.prepare('SELECT status FROM runs WHERE id=?').get(runId) as { status: string };
    expect(row.status).toBe('error');
    const errorEvents = eventPayloads(runId, 'error');
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]!.code).toBe('LOOP_EXHAUSTED');
    const signals = eventPayloads(runId, 'status').filter((p) => p.phase === 'stuck_signal');
    expect(signals.map((s) => s.level)).toEqual([1, 2, 3]);
    expect(model).toHaveBeenCalledTimes(8);

    // The completion right after the SECOND signal (call #8, iteration 8)
    // must open with the compacted recovery history, not the grown one:
    // [system, recovery user, directive user, ...].
    const afterSecond = seenMessages[7]!;
    expect(afterSecond.length).toBeGreaterThanOrEqual(3);
    expect(afterSecond[0]!.role).toBe('system');
    expect(String(afterSecond[1]!.content)).toContain('RECOVERY MODE');
    expect(String(afterSecond[2]!.content)).toContain('STUCK SIGNAL — intervention 2 of 3');
    expect(String(afterSecond[2]!.content)).toContain('compacted');
    // And the pre-compaction history (call #5, after signal 1) was NOT compacted.
    const afterFirst = seenMessages[4]!;
    expect(afterFirst.some((m) => String(m.content ?? '').includes('RECOVERY MODE'))).toBe(false);
    expect(afterFirst.some((m) => String(m.content ?? '').includes('STUCK SIGNAL — intervention 1 of 3'))).toBe(true);
    db.close();
  }, 180000);
});
