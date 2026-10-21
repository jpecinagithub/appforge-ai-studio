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
import { LlmError } from './llm.js';

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
  it('bounds malformed model responses and preserves the full request in single-file recovery', async () => {
    const runId=setupRun(makeGateProject());
    db.prepare('UPDATE runs SET prompt=? WHERE id=?').run('Build a store. '+'.'.repeat(4000)+' KEEP_THE_LAST_REQUIREMENT',runId);
    model.mockRejectedValue(new LlmError('LLM_BAD_TOOL_ARGS','Invalid JSON arguments for tool write_files'));
    await runAgentOnce(db,runId,{dataDir,settings});
    expect(model).toHaveBeenCalledTimes(4);
    expect(runStatus(runId).status).toBe('error');
    expect(runStatus(runId).error).toContain('Four consecutive');
    const recovery=model.mock.calls[1];
    expect(JSON.stringify(recovery[1])).toContain('KEEP_THE_LAST_REQUIREMENT');
    expect(recovery[2].some((tool:{name:string})=>tool.name==='write_files')).toBe(false);
    expect(recovery[2].some((tool:{name:string})=>tool.name==='write_file')).toBe(true);
    expect(toolCallCount(runId,'write_files')).toBe(0);
    db.close();
  });

  it('also rejects the unchanged starter on a later retry', async () => {
    const fixture = makeGateProject();
    fs.mkdirSync(path.join(fixture, 'frontend', 'src'), { recursive: true });
    fs.mkdirSync(path.join(fixture, 'backend', 'src'), { recursive: true });
    const runId = setupRun(fixture);
    const projectId = (db.prepare('SELECT project_id FROM runs WHERE id=?').get(runId) as { project_id: string }).project_id;
    db.prepare('INSERT INTO runs(id,project_id,status) VALUES (?,?,?)').run('prior-attempt', projectId, 'error');
    const templates = path.join(dataDir, 'templates');
    fs.cpSync(fixture, path.join(templates, 'dynamic-react-node'), { recursive: true });
    vi.stubEnv('APPFORGE_TEMPLATES_DIR', templates);
    const proxy = await startGateProxy();
    vi.stubEnv('APPFORGE_STUDIO_URL', proxy.url);
    try {
      script([...SIX_CHECKS.map(n => toolCall(n)), ...Array.from({ length: 9 }, () => final('Store complete'))]);
      await runAgentOnce(db, runId, { dataDir, settings });
      expect(runStatus(runId).status).toBe('error');
      expect(runStatus(runId).error).toContain('NO_IMPLEMENTATION');
    } finally {
      await proxy.close();
      delete process.env.APPFORGE_STUDIO_URL;
      delete process.env.APPFORGE_TEMPLATES_DIR;
      db.close();
    }
  }, 240000);

  it('rejects an untouched starter even when every check passes', async () => {
    const runId = setupRun(makeGateProject());
    const proxy = await startGateProxy();
    vi.stubEnv('APPFORGE_STUDIO_URL', proxy.url);
    try {
      script([...SIX_CHECKS.map(n => toolCall(n)), ...Array.from({length: 9}, () => final('Store complete'))]);
      await runAgentOnce(db, runId, { dataDir, settings });
      expect(runStatus(runId).status).toBe('error');
      expect(runStatus(runId).error).toContain('NO_IMPLEMENTATION');
    } finally { await proxy.close(); delete process.env.APPFORGE_STUDIO_URL; db.close(); }
  }, 240000);


  /** Fixture + starter template with real src trees, for the implementation gate. */
  function makeTemplatedProject(): string {
    const fixture = makeGateProject();
    fs.mkdirSync(path.join(fixture, 'frontend', 'src'), { recursive: true });
    fs.mkdirSync(path.join(fixture, 'backend', 'src', 'routes'), { recursive: true });
    fs.writeFileSync(path.join(fixture, 'frontend', 'src', 'App.tsx'), 'export default function App(){return null}');
    fs.writeFileSync(path.join(fixture, 'frontend', 'src', 'api.ts'), 'export const api={};');
    fs.writeFileSync(path.join(fixture, 'backend', 'src', 'server.ts'), 'export const app={};');
    fs.writeFileSync(path.join(fixture, 'backend', 'src', 'routes', 'todos.ts'), "export default async function todos(app:any){ app.get('/api/todos', async()=>[]); }");
    fs.writeFileSync(path.join(fixture, 'backend', 'src', 'routes', 'users.ts'), "export default async function users(app:any){ app.get('/api/users', async()=>[]); }");
    return fixture;
  }

  function stubTemplatesFrom(fixture: string): void {
    const templates = path.join(dataDir, 'templates');
    fs.cpSync(fixture, path.join(templates, 'dynamic-react-node'), { recursive: true });
    vi.stubEnv('APPFORGE_TEMPLATES_DIR', templates);
  }

  it('rejects the PcBox case: six checks green, only a migration written', async () => {
    const fixture = makeTemplatedProject();
    stubTemplatesFrom(fixture);
    const runId = setupRun(fixture);
    const proxy = await startGateProxy();
    vi.stubEnv('APPFORGE_STUDIO_URL', proxy.url);
    try {
      script([
        ...SIX_CHECKS.map(n => toolCall(n)),
        toolCall('write_files', { area: 'migrations', files: [{ path: '002_catalog.sql', content: 'CREATE TABLE products(id TEXT PRIMARY KEY, name TEXT);' }] }),
        toolCall('run_migrations'), toolCall('run_api_tests'), toolCall('start_fullstack_preview'), toolCall('test_authenticated_flow'),
        ...Array.from({ length: 9 }, () => final('Store complete')),
      ]);
      await runAgentOnce(db, runId, { dataDir, settings });
      expect(runStatus(runId).status).toBe('error');
      expect(runStatus(runId).error).toContain('NO_IMPLEMENTATION');
      expect(runStatus(runId).error).toContain('backend/src is still the untouched starter template');
    } finally { await proxy.close(); delete process.env.APPFORGE_STUDIO_URL; delete process.env.APPFORGE_TEMPLATES_DIR; db.close(); }
  }, 240000);

  it('finishes when the run adds a backend route and changes the frontend', async () => {
    const fixture = makeTemplatedProject();
    stubTemplatesFrom(fixture);
    const runId = setupRun(fixture);
    const proxy = await startGateProxy();
    vi.stubEnv('APPFORGE_STUDIO_URL', proxy.url);
    try {
      script([
        ...SIX_CHECKS.map(n => toolCall(n)),
        toolCall('write_files', { area: 'backend', files: [{ path: 'src/routes/products.ts', content: "export default async function products(app:any){ app.get('/api/products', async()=>[]); }" }] }),
        toolCall('write_files', { area: 'frontend', files: [{ path: 'src/App.tsx', content: 'export default function App(){ return <div>STORE</div>; }' }] }),
        ...SIX_CHECKS.map(n => toolCall(n)),
        final('Store built'),
      ]);
      await runAgentOnce(db, runId, { dataDir, settings });
      expect(runStatus(runId).status).toBe('done');
    } finally { await proxy.close(); delete process.env.APPFORGE_STUDIO_URL; delete process.env.APPFORGE_TEMPLATES_DIR; db.close(); }
  }, 240000);

  it('annotates contract violations in the same write turn (agent autonomy)', async () => {
    const fixture = makeTemplatedProject();
    fs.mkdirSync(path.join(fixture, 'backend', 'src', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(fixture, 'backend', 'src', 'lib', 'errors.ts'),
      "export type ErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND' | 'CONFLICT';\nexport function sendError(reply: unknown, code: ErrorCode, message: string) { return { code, message }; }");
    stubTemplatesFrom(fixture);
    const runId = setupRun(fixture);
    const proxy = await startGateProxy();
    vi.stubEnv('APPFORGE_STUDIO_URL', proxy.url);
    try {
      script([
        toolCall('write_files', { area: 'backend', files: [{ path: 'src/routes/products.ts', content: "import { sendError } from '../lib/errors.js';\nexport default async function products(app:any, db:any){\n  app.post('/api/cart', async (req:any, reply:any) => { const tx = db.transaction(() => 1); tx(); return sendError(reply, 'INSUFFICIENT_STOCK', 'Not enough stock.'); });\n}" }] }),
        toolCall('write_files', { area: 'frontend', files: [{ path: 'src/App.tsx', content: 'export default function App(){ return <div>STORE</div>; }' }] }),
        ...SIX_CHECKS.map(n => toolCall(n)),
        final('Store built'),
      ]);
      await runAgentOnce(db, runId, { dataDir, settings });
      expect(runStatus(runId).status).toBe('done');
      const results = db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND kind='tool_result'").all(runId) as Array<{ payload_json: string }>;
      const writeOutputs = results.map((r) => { try { return JSON.parse(r.payload_json) as { name?: string; output?: string }; } catch { return {}; } })
        .filter((p) => p.name === 'write_files').map((p) => p.output ?? '');
      const annotated = writeOutputs.find((o) => o.includes('Backend contract check'));
      expect(annotated).toBeTruthy();
      expect(annotated).toContain('INSUFFICIENT_STOCK');
      expect(annotated).toContain('BEGIN IMMEDIATE');
    } finally { await proxy.close(); delete process.env.APPFORGE_STUDIO_URL; delete process.env.APPFORGE_TEMPLATES_DIR; db.close(); }
  }, 240000);

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
        toolCall('write_file', { area: 'backend', path: 'src/domain.ts', content: 'export const implemented = true;' }),
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
        toolCall('write_file', { area: 'backend', path: 'src/domain.ts', content: 'export const implemented = true;' }),
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
        toolCall('write_file', { area: 'backend', path: 'src/domain.ts', content: 'export const implemented = true;' }),
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
