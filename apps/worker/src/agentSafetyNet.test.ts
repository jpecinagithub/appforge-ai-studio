/**
 * Fase 2 — safety-net tests for the agent loop (Trabajos 6–8), driven by a
 * scripted LLM in the style of dynamicGate.test.ts:
 *
 *  - Avanza y degrada: the run passes checks (automatic photos are taken),
 *    then degrades the sources and dies by repair limit → the workspace
 *    ends up EXACTLY at the best photo, and the final message says so.
 *  - Fracasa sin avanzar: no photo is ever taken, nothing is restored, the
 *    files stay as the run left them, and the final message says so.
 *  - Consulta de estado: get_dynamic_status returns the correct prefix,
 *    valid/missing checks and best state at each point of the script.
 *  - Recibos coherentes tras restaurar: the persisted receipts left after
 *    the restore recompute to exactly the photo's gate state.
 *
 * The fixture mirrors dynamicGate.test.ts (working node build scripts, no
 * network) plus a real Git repository per project, because the photos and
 * the restore are Git operations.
 */
import { beforeAll, afterAll, beforeEach, expect, it, vi, describe } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { LlmResponse } from 'appforge-shared';

const { model } = vi.hoisted(() => ({ model: vi.fn() }));
vi.mock('./llm.js', async (importOriginal) => {
  const o = await importOriginal<typeof import('./llm.js')>();
  return { ...o, isStubMode: () => false, chatLlm: (...args: unknown[]) => (model as (...a: unknown[]) => Promise<LlmResponse>)(...args) };
});

import { runAgentOnce, type AgentSettings } from './agent.js';
import { FAKE_SERVER } from './previewFixture.js';
import { listVerificationReceipts } from './deploy/receipts.js';
import { checkScopeFingerprint, DYNAMIC_CHECK_ORDER } from './dynamicTools.js';

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
const out = process.env.FAKE_OUT ?? 'index.html';
mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist', out), '<html>ok</html>');
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-safetynet-'));
  const fe = path.join(dir, 'frontend');
  const be = path.join(dir, 'backend');
  fs.mkdirSync(path.join(fe, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(be, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'migrations'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\ndist/\n');
  fs.writeFileSync(path.join(fe, 'package.json'), JSON.stringify({ name: 'fx-fe', version: '0.1.0', scripts: { build: 'node scripts/build.mjs' } }));
  fs.writeFileSync(path.join(be, 'package.json'), JSON.stringify({ name: 'fx-be', version: '0.1.0', scripts: { build: 'node scripts/build.mjs' } }));
  fs.writeFileSync(path.join(fe, 'package-lock.json'), LOCK('fx-fe'));
  fs.writeFileSync(path.join(be, 'package-lock.json'), LOCK('fx-be'));
  fs.writeFileSync(path.join(fe, 'scripts', 'build.mjs'), BUILD_JS);
  fs.writeFileSync(path.join(be, 'scripts', 'build.mjs'), BACKEND_BUILD_JS);
  fs.writeFileSync(path.join(be, 'scripts', 'fake-server.js'), FAKE_SERVER);
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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-safetynet-data-'));
  tmpDirs.push(dataDir);
});

function git(dir: string, args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
}

function setupRun(projectDir: string): { runId: string; projectId: string; projectOnDisk: string } {
  const projectId = `proj-${Math.random().toString(36).slice(2)}`;
  const runId = `run-${Math.random().toString(36).slice(2)}`;
  db.prepare('INSERT INTO projects(id, name, type, status) VALUES (?,?,?,?)').run(projectId, 'SafetyNet project', 'dynamic', 'active');
  db.prepare('INSERT INTO runs(id, project_id, prompt, status, created_at) VALUES (?,?,?,?,?)')
    .run(runId, projectId, 'Build my app', 'queued', new Date().toISOString());
  const projectOnDisk = path.join(dataDir, 'projects', projectId);
  fs.mkdirSync(projectOnDisk, { recursive: true });
  fs.cpSync(projectDir, projectOnDisk, { recursive: true });
  // Projects are born as Git repos with an initial commit (server/projects.ts).
  git(projectOnDisk, ['init', '-q']);
  git(projectOnDisk, ['add', '-A']);
  git(projectOnDisk, ['-c', 'user.name=AppForge', '-c', 'user.email=appforge@local', 'commit', '-q', '-m', 'initial commit']);
  return { runId, projectId, projectOnDisk };
}

function runStatus(runId: string): { status: string; error: string | null } {
  return db.prepare('SELECT status, error FROM runs WHERE id=?').get(runId) as { status: string; error: string | null };
}

function eventPhases(runId: string): string[] {
  const rows = db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND kind='status'").all(runId) as Array<{ payload_json: string }>;
  return rows.map((r) => { try { return (JSON.parse(r.payload_json) as { phase?: string }).phase ?? ''; } catch { return ''; } });
}

function autoRevisions(): Array<{ label: string; git_sha: string }> {
  return db.prepare("SELECT label, git_sha FROM revisions WHERE label LIKE 'auto:%' ORDER BY created_at ASC, label ASC").all() as Array<{ label: string; git_sha: string }>;
}

/** Scripted model: plays the queue, then keeps returning a final message. */
function script(responses: LlmResponse[]): void {
  const queue = [...responses];
  model.mockImplementation(async () => (queue.length > 0 ? queue.shift()! : final('Done, for real this time.')));
}

const GOOD_APP = 'export default function App(){return <h1>GOOD v1</h1>}';
const BAD_APP = 'export default function App(){return <h1>BROKEN v2</h1>}';

/**
 * The shared "advance then degrade" script: write a good file, pass
 * frontendBuild + backendBuild (two automatic photos), then degrade the
 * sources (overwrite + a brand-new junk file) and keep trying to finish —
 * the identical gate diagnostic feeds the intervention ladder, which
 * ends the run as LOOP_EXHAUSTED after three signals without progress.
 */
async function runAdvanceAndDegrade(): Promise<{ runId: string; projectId: string; projectOnDisk: string }> {
  const ctx = setupRun(makeGateProject());
  script([
    toolCall('write_files', { files: [{ path: 'src/App.tsx', content: GOOD_APP }] }),
    toolCall('run_frontend_build'),
    toolCall('run_backend_build'),
    toolCall('write_files', {
      files: [
        { path: 'src/App.tsx', content: BAD_APP },
        { path: 'src/Junk.tsx', content: 'export const junk = "created while degrading";' },
      ],
    }),
    final('Done?'),
    final('Done?'),
    final('Done?'),
  ]);
  await runAgentOnce(db, ctx.runId, { dataDir, settings });
  return ctx;
}

describe('Fase 2 safety net', () => {
  it('avanza y degrada: restaura exactamente la mejor foto al morir por límite de reparación', async () => {
    const { runId, projectOnDisk } = await runAdvanceAndDegrade();
    const { status, error } = runStatus(runId);
    expect(status).toBe('error');
    // Trabajo 6: una foto automática por escalón, etiquetada y visible.
    const autos = autoRevisions();
    expect(autos.map((r) => r.label)).toEqual([
      `auto: tras frontendBuild (run ${runId})`,
      `auto: tras backendBuild (run ${runId})`,
    ]);
    const phases = eventPhases(runId);
    expect(phases.filter((p) => p === 'auto_snapshot')).toHaveLength(2);
    expect(phases).toContain('restored_best');
    // Trabajo 7: el contenido es EXACTAMENTE el de la mejor foto…
    expect(fs.readFileSync(path.join(projectOnDisk, 'frontend', 'src', 'App.tsx'), 'utf8')).toBe(GOOD_APP);
    // …incluido que el fichero creado durante la degradación no sobrevive.
    expect(fs.existsSync(path.join(projectOnDisk, 'frontend', 'src', 'Junk.tsx'))).toBe(false);
    // …y el mensaje final lo dice expresamente, con el estado restaurado.
    expect(error ?? '').toMatch(/Restored to the best state reached in this run: after backendBuild \(2\/6 checks valid/);
    db.close();
  }, 180000);

  it('recibos coherentes tras restaurar: la puerta recalculada coincide con la foto', async () => {
    const { projectId, projectOnDisk } = await runAdvanceAndDegrade();
    const receipts = listVerificationReceipts(db, projectId);
    // Solo quedan los recibos del prefijo restaurado, en orden canónico…
    expect(receipts.map((r) => r.checkKey)).toEqual(['frontendBuild', 'backendBuild']);
    // …y cada huella coincide con las fuentes restauradas: el prefijo
    // recalculado sobre el disco es exactamente el de la foto (2).
    let recomputedPrefix = 0;
    for (const key of DYNAMIC_CHECK_ORDER) {
      const receipt = receipts.find((r) => r.checkKey === key);
      if (!receipt) break;
      if (checkScopeFingerprint(projectOnDisk, key) !== receipt.fingerprint) break;
      recomputedPrefix++;
    }
    expect(recomputedPrefix).toBe(2);
    db.close();
  }, 180000);

  it('fracasa sin avanzar: no se restaura nada y los archivos quedan como quedaron', async () => {
    const { runId, projectOnDisk } = setupRun(makeGateProject());
    script([
      toolCall('write_files', { files: [{ path: 'src/App.tsx', content: BAD_APP }] }),
      final('Done?'),
      final('Done?'),
      final('Done?'),
    ]);
    await runAgentOnce(db, runId, { dataDir, settings });
    const { status, error } = runStatus(runId);
    expect(status).toBe('error');
    // Sin avance no hay fotos ni restauración, y el mensaje lo indica.
    expect(autoRevisions()).toHaveLength(0);
    expect(eventPhases(runId)).not.toContain('restored_best');
    expect(error ?? '').toMatch(/No earlier state was restored/);
    expect(fs.readFileSync(path.join(projectOnDisk, 'frontend', 'src', 'App.tsx'), 'utf8')).toBe(BAD_APP);
    db.close();
  }, 180000);

  it('escalera agotada: tres señales sin progreso cierran con LOOP_EXHAUSTED y restauran la mejor foto', async () => {
    const { runId, projectOnDisk } = await runAdvanceAndDegrade();
    const { status, error } = runStatus(runId);
    expect(status).toBe('error');
    const errorEvents = (db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND kind='error'").all(runId) as Array<{ payload_json: string }>)
      .map((r) => JSON.parse(r.payload_json) as { code?: string });
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]!.code).toBe('LOOP_EXHAUSTED');
    // The final message enumerates the three interventions and the restore.
    expect(error ?? '').toContain('Three stuck interventions fired without progress between them');
    expect(error ?? '').toContain('1. [repeated-signature]');
    expect(error ?? '').toContain('3. [');
    expect(error ?? '').toMatch(/Restored to the best state reached in this run: after backendBuild \(2\/6 checks valid/);
    const signals = (db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND kind='status'").all(runId) as Array<{ payload_json: string }>)
      .map((r) => JSON.parse(r.payload_json) as { phase?: string; level?: number })
      .filter((p) => p.phase === 'stuck_signal');
    expect(signals.map((s) => s.level)).toEqual([1, 2, 3]);
    expect(fs.readFileSync(path.join(projectOnDisk, 'frontend', 'src', 'App.tsx'), 'utf8')).toBe(GOOD_APP);
    db.close();
  }, 180000);

  it('techo de tokens: agota maxRunTokens, restaura la mejor foto y cierra con TOKEN_BUDGET_EXHAUSTED', async () => {
    const { runId, projectOnDisk } = setupRun(makeGateProject());
    // Usage-heavy scripted responses: 1000 prompt tokens per completion.
    const heavy = (r: LlmResponse): LlmResponse => ({ ...r, usage: { promptTokens: 1000, completionTokens: 0 } });
    script([
      heavy(toolCall('write_files', { files: [{ path: 'src/App.tsx', content: GOOD_APP }] })),
      heavy(toolCall('run_frontend_build')),
      heavy(toolCall('run_backend_build')),
      heavy(toolCall('write_files', {
        files: [
          { path: 'src/App.tsx', content: BAD_APP },
          { path: 'src/Junk.tsx', content: 'export const junk = "created while degrading";' },
        ],
      })),
      heavy(toolCall('read_file', { path: 'package.json' })),
    ]);
    // Ceiling 3500: after 3 completions (3000) the degrade still runs;
    // the 5th completion (4100 total) trips the check at iteration start.
    await runAgentOnce(db, runId, { dataDir, settings: { ...settings, maxRunTokens: 3500 } });
    const { status, error } = runStatus(runId);
    expect(status).toBe('error');
    expect(error ?? '').toMatch(/token ceiling/i);
    expect(error ?? '').toContain('maxRunTokens=3500');
    const errorEvents = (db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND kind='error'").all(runId) as Array<{ payload_json: string }>)
      .map((r) => JSON.parse(r.payload_json) as { code?: string });
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]!.code).toBe('TOKEN_BUDGET_EXHAUSTED');
    // The token death is a fact-based termination: it restores like the others.
    expect(eventPhases(runId)).toContain('restored_best');
    expect(fs.readFileSync(path.join(projectOnDisk, 'frontend', 'src', 'App.tsx'), 'utf8')).toBe(GOOD_APP);
    expect(fs.existsSync(path.join(projectOnDisk, 'frontend', 'src', 'Junk.tsx'))).toBe(false);
    db.close();
  }, 180000);

  it('consulta de estado: get_dynamic_status devuelve el prefijo y el mejor estado en cada momento', async () => {
    const { runId } = setupRun(makeGateProject());
    const seen: Array<Record<string, any>> = [];
    const seenRaw = new Set<string>();
    const queue: LlmResponse[] = [
      toolCall('get_dynamic_status'),
      toolCall('run_frontend_build'),
      toolCall('run_backend_build'),
      toolCall('get_dynamic_status'),
    ];
    model.mockImplementation(async (...args: unknown[]) => {
      const history = (args[1] ?? []) as Array<{ role: string; name?: string; content?: string }>;
      for (const m of history) {
        if (m.role === 'tool' && m.name === 'get_dynamic_status' && m.content && !seenRaw.has(m.content)) {
          seenRaw.add(m.content);
          const parsed = JSON.parse(m.content) as { data?: Record<string, any> };
          if (parsed.data) seen.push(parsed.data);
        }
      }
      return queue.length > 0 ? queue.shift()! : final('Done, for real this time.');
    });
    await runAgentOnce(db, runId, { dataDir, settings });
    expect(seen).toHaveLength(2);
    // Antes de actuar: prefijo 0, todo ausente, sin mejor estado.
    expect(seen[0]!.prefixLength).toBe(0);
    expect(seen[0]!.valid).toEqual([]);
    expect(seen[0]!.missing).toEqual([...DYNAMIC_CHECK_ORDER]);
    expect(seen[0]!.nextCheck).toBe('frontendBuild');
    expect(seen[0]!.best).toBeNull();
    // Tras los dos builds: prefijo 2, siguiente migrations, mejor estado
    // con su foto asociada.
    expect(seen[1]!.prefixLength).toBe(2);
    expect(seen[1]!.valid).toEqual(['frontendBuild', 'backendBuild']);
    expect(seen[1]!.missing).toEqual(['migrations', 'apiTests', 'fullstackPreview', 'authenticatedFlow']);
    expect(seen[1]!.nextCheck).toBe('migrations');
    expect(seen[1]!.best).toMatchObject({ prefixLength: 2, lastCheck: 'backendBuild' });
    expect(typeof seen[1]!.best.revisionId).toBe('string');
    db.close();
  }, 180000);
});
