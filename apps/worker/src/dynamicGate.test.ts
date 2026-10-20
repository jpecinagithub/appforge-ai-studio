/**
 * Agent-level tests for the dynamic completion gate (Fase 5A Codex blocker 1,
 * extended to six checks in Fase 5B).
 *
 * The gate lives in code (dynamicGateStatus, consulted by verify()), never
 * just in the prompt. These tests drive runAgentOnce with a scripted LLM:
 *  - finishing without running the tools is blocked;
 *  - running the tools out of order is blocked (and recoverable);
 *  - modifying sources after the checks invalidates them;
 *  - running all six tools in order completes the run (full happy path);
 *  - finishing with only the four 5A checks is blocked (5B not done).
 *
 * The fixture's backend build produces a runnable fake server (from
 * previewFixture), and a DB-backed /a/:projectId proxy lets
 * test_authenticated_flow run its browser phase end to end.
 */
import { beforeAll, afterAll, beforeEach, expect, it, vi, describe } from 'vitest';
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
import { getPreview } from './previewManager.js';

// ---------------------------------------------------------------------------
// Minimal dynamic fixture (working npm scripts, no network)
// ---------------------------------------------------------------------------

const BACKEND_BUILD_JS = `
import { mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'dist'), { recursive: true });
// The "compiled" server is a runnable fake implementing the template contract.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-gate-'));
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
  fs.writeFileSync(path.join(be, 'scripts', 'fake-server.js'), FAKE_SERVER);
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'fx', version: '0.1.0', scripts: { migrate: 'node scripts/migrate.mjs', test: 'node scripts/tests.mjs' } }),
  );
  fs.writeFileSync(path.join(dir, 'scripts', 'migrate.mjs'), MIGRATE_JS);
  fs.writeFileSync(path.join(dir, 'scripts', 'tests.mjs'), TESTS_JS);
  fs.writeFileSync(path.join(dir, 'migrations', '001_init.sql'), 'CREATE TABLE notes(id TEXT PRIMARY KEY);');
  fs.writeFileSync(path.join(fe, 'package.json'), JSON.stringify({ name: 'fx-fe', version: '0.1.0', scripts: { build: 'node scripts/build.mjs' } }));
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
  // The 6-check happy path runs a real preview: opt in explicitly.
  vi.stubEnv('APPFORGE_ENABLE_UNSAFE_LOCAL_PREVIEW', '1');
});

afterAll(() => {
  vi.unstubAllEnvs();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

beforeEach(() => {
  model.mockReset();
  db = new Database(':memory:');
  db.exec(DDL);
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-gate-data-'));
  tmpDirs.push(dataDir);
});

function setupRun(projectDir: string): string {
  const projectId = `proj-${Math.random().toString(36).slice(2)}`;
  const runId = `run-${Math.random().toString(36).slice(2)}`;
  db.prepare('INSERT INTO projects(id, name, type, status) VALUES (?,?,?,?)').run(projectId, 'Gate project', 'dynamic', 'active');
  db.prepare('INSERT INTO runs(id, project_id, prompt, status, created_at) VALUES (?,?,?,?,?)')
    .run(runId, projectId, 'Build my app', 'queued', new Date().toISOString());
  fs.mkdirSync(path.join(dataDir, 'projects', projectId), { recursive: true });
  fs.cpSync(projectDir, path.join(dataDir, 'projects', projectId), { recursive: true });
  return runId;
}

function runStatus(runId: string): { status: string; error: string | null } {
  return db.prepare('SELECT status, error FROM runs WHERE id=?').get(runId) as { status: string; error: string | null };
}

function toolCallCount(runId: string, name: string): number {
  const rows = db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND kind='tool_call'").all(runId) as Array<{ payload_json: string }>;
  return rows.filter((r) => { try { return (JSON.parse(r.payload_json) as { name?: string }).name === name; } catch { return false; } }).length;
}

/** Scripted model: plays the queue, then keeps returning a final message. */
function script(responses: LlmResponse[]): void {
  const queue = [...responses];
  model.mockImplementation(async () => (queue.length > 0 ? queue.shift()! : final('Done, for real this time.')));
}

/**
 * DB-backed /a/:projectId proxy for the gate tests: forwards to whatever
 * port the preview registry holds for the project (the real Studio proxy
 * is covered in server/src/proxy.test.ts).
 */
async function startGateProxy(): Promise<{ url: string; close: () => Promise<void> }> {
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    const m = (req.url ?? '').match(/^\/a\/([^/]+)(\/.*)?$/);
    if (!m) { res.writeHead(404); res.end(); return; }
    const projectId = m[1]!;
    const rest = m[2] || '/';
    let port: number | null = null;
    try {
      const row = getPreview(db, projectId);
      if (row?.status === 'ready') port = row.port;
    } catch { /* no preview */ }
    if (!port) { res.writeHead(503); res.end('no preview'); return; }
    const proxy = http.request(
      { host: '127.0.0.1', port, path: rest, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${port}` } },
      (upRes) => { res.writeHead(upRes.statusCode ?? 502, upRes.headers); upRes.pipe(res); },
    );
    proxy.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(proxy);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** The six verification tools in canonical order. */
const SIX_CHECKS = [
  'run_frontend_build',
  'run_backend_build',
  'run_migrations',
  'run_api_tests',
  'start_fullstack_preview',
  'test_authenticated_flow',
];

describe('dynamic completion gate', () => {
  it('blocks finishing when the model never runs the tools', async () => {
    const runId = setupRun(makeGateProject());
    script([
      toolCall('write_files', { files: [{ path: 'src/App.tsx', content: 'export default function App(){return <h1>hi</h1>}' }] }),
      final('The app is done.'),
      final('The app is done.'),
      final('The app is done.'),
      final('The app is done.'),
      final('The app is done.'),
      final('The app is done.'),
      final('The app is done.'),
      final('The app is done.'),
    ]);
    await runAgentOnce(db, runId, { dataDir, settings });
    const { status, error } = runStatus(runId);
    expect(status).not.toBe('done');
    expect(status).toBe('error');
    expect(error ?? '').toMatch(/DYNAMIC CHECKS INCOMPLETE/);
    db.close();
  }, 180000);

  it('blocks out-of-order execution and lets the model recover in order', async () => {
    const runId = setupRun(makeGateProject());
    const proxy = await startGateProxy();
    vi.stubEnv('APPFORGE_STUDIO_URL', proxy.url);
    try {
      script([
        toolCall('run_api_tests'),
        toolCall('run_frontend_build'),
        toolCall('run_backend_build'),
        toolCall('run_migrations'),
        toolCall('run_api_tests'),
        toolCall('start_fullstack_preview'),
        toolCall('test_authenticated_flow'),
        final('All six checks ran, app is done.'),
      ]);
      await runAgentOnce(db, runId, { dataDir, settings });
      const { status } = runStatus(runId);
      expect(status).toBe('done');
      // api_tests ran twice: once out of order (wiped), once in order
      expect(toolCallCount(runId, 'run_api_tests')).toBe(2);
    } finally {
      await proxy.close();
      delete process.env.APPFORGE_STUDIO_URL;
    }
    db.close();
  }, 240000);

  it('invalidates checks when sources change after verification', async () => {
    const runId = setupRun(makeGateProject());
    const proxy = await startGateProxy();
    vi.stubEnv('APPFORGE_STUDIO_URL', proxy.url);
    try {
      script([
        ...SIX_CHECKS.map((n) => toolCall(n)),
        toolCall('write_files', { files: [{ path: 'src/App.tsx', content: 'export default function App(){return <h1>v2</h1>}' }] }),
        final('Done after the tweak.'),
        // gate blocks: the write invalidated everything from frontendBuild on
        ...SIX_CHECKS.map((n) => toolCall(n)),
        final('Done for real.'),
      ]);
      await runAgentOnce(db, runId, { dataDir, settings });
      const { status } = runStatus(runId);
      expect(status).toBe('done');
      expect(toolCallCount(runId, 'run_frontend_build')).toBe(2);
      expect(toolCallCount(runId, 'test_authenticated_flow')).toBe(2);
    } finally {
      await proxy.close();
      delete process.env.APPFORGE_STUDIO_URL;
    }
    db.close();
  }, 240000);

  it('completes when the six tools run in order (full happy path)', async () => {
    const runId = setupRun(makeGateProject());
    const proxy = await startGateProxy();
    vi.stubEnv('APPFORGE_STUDIO_URL', proxy.url);
    try {
      script([
        ...SIX_CHECKS.map((n) => toolCall(n)),
        final('All checks green, app complete.'),
      ]);
      await runAgentOnce(db, runId, { dataDir, settings });
      const { status, error } = runStatus(runId);
      expect(error).toBeNull();
      expect(status).toBe('done');
    } finally {
      await proxy.close();
      delete process.env.APPFORGE_STUDIO_URL;
    }
    db.close();
  }, 240000);

  it('Fase 1: stops the repair loop when the same error signature repeats 3 times despite source edits', async () => {
    const runId = setupRun(makeGateProject());
    let n = 0;
    // Alternate edits (each changes the source fingerprint, which used to
    // reset the stagnation counter) with finish attempts. The gate
    // diagnostic never changes, so the signature circuit breaker must trip.
    model.mockImplementation(async () => {
      n++;
      if (n % 2 === 1) {
        return toolCall('write_files', { files: [{ path: 'src/App.tsx', content: `export default function App(){return <h1>v${n}</h1>}` }] });
      }
      return final('Done?');
    });
    await runAgentOnce(db, runId, { dataDir, settings });
    const { status, error } = runStatus(runId);
    expect(status).toBe('error');
    expect(error ?? '').toMatch(/repeated 3 times in a row/);
    expect(n).toBeLessThanOrEqual(6);
    db.close();
  }, 180000);

  it('Fase 1: the hard iteration cap stops an endless tool loop', async () => {
    const runId = setupRun(makeGateProject());
    model.mockImplementation(async () => toolCall('read_file', { path: 'package.json' }));
    await runAgentOnce(db, runId, { dataDir, settings: { ...settings, maxIterations: 100, maxHardIterations: 5 } });
    const { status, error } = runStatus(runId);
    expect(status).toBe('error');
    expect(error ?? '').toMatch(/Hard iteration cap reached \(5 iterations\)/);
    expect(toolCallCount(runId, 'read_file')).toBe(5);
    db.close();
  }, 180000);

  it('Fase 1: maxRepairAttempts stops repair when failed verifications keep changing', async () => {
    const runId = setupRun(makeGateProject());
    script([
      toolCall('write_files', { files: [{ path: 'src/App.tsx', content: 'export default function App(){return <h1>v1</h1>}' }] }),
      final('Done.'), // verify #1 fails: all six checks missing (signature A)
      toolCall('run_frontend_build'), // succeeds; verify #2 fails: five missing (signature B)
      toolCall('write_files', { files: [{ path: 'src/App.tsx', content: 'export default function App(){return <h1>v2</h1>}' }] }), // invalidates frontendBuild; verify #3 fails (signature A) — 3 > maxRepairAttempts=2
    ]);
    await runAgentOnce(db, runId, { dataDir, settings: { ...settings, maxRepairAttempts: 2 } });
    const { status, error } = runStatus(runId);
    expect(status).toBe('error');
    expect(error ?? '').toMatch(/failed verification attempts \(maxRepairAttempts=2\)/);
    expect(error ?? '').not.toMatch(/repeated 3 times/);
    db.close();
  }, 180000);

  it('blocks finishing with only the four 5A checks (5B not done)', async () => {
    const runId = setupRun(makeGateProject());
    script([
      toolCall('run_frontend_build'),
      toolCall('run_backend_build'),
      toolCall('run_migrations'),
      toolCall('run_api_tests'),
      final('The four checks are done, app complete.'),
      final('The four checks are done, app complete.'),
      final('The four checks are done, app complete.'),
    ]);
    await runAgentOnce(db, runId, { dataDir, settings });
    const { status, error } = runStatus(runId);
    expect(status).not.toBe('done');
    expect(error ?? '').toMatch(/DYNAMIC CHECKS INCOMPLETE/);
    db.close();
  }, 240000);
});
