/**
 * Malformed tool calls (empty/missing arguments) — agent-loop hardening.
 *
 * Production run 3723178d (2026-10-21) died without executing anything
 * useful: the model emitted read_file ×5 and write_file ×1 with EMPTY
 * argument payloads; the parser silently turned them into {}, every call
 * was rejected with `missing required argument: path`, and the run burned
 * itself out. These tests drive runAgentOnce with a scripted LLM (same
 * fixture style as dynamicGate.test.ts) and pin the new behaviour:
 *
 *  (a) a completion whose read_file arrives with raw empty arguments is
 *      NOT executed; the loop retries the completion with a temporary
 *      notice naming the tool/parameter, and the run then proceeds.
 *  (b) persistently empty arguments end the run with LLM_BAD_TOOL_ARGS
 *      after exactly 1 + 2 completions and zero tool executions.
 *  (c) a wrong-key emission (read_file {file}) takes the same retry path
 *      via the required-parameter detection.
 *  (d) corte rápido: three consecutive `missing required argument` tool
 *      results for the same tool (a shape the retry layer cannot see —
 *      nested write_files items) abort with TOOL_ARGUMENT_STAGNATION.
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

import { runAgentOnce, updateArgumentStreak, type AgentSettings } from './agent.js';
import { FAKE_SERVER } from './previewFixture.js';
import { getPreview } from './previewManager.js';

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-malformed-'));
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
  return dir;
}

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

/** A completion whose tool call arrived with an EMPTY raw argument payload (parser-marked). */
const malformedCall = (name: string): LlmResponse => ({
  content: null,
  toolCalls: [{ id: `bad-${name}-${Math.random()}`, name, arguments: {}, rawArguments: '', malformed: 'empty-arguments' }],
  usage: { promptTokens: 1, completionTokens: 1 },
});

beforeAll(() => {
  vi.stubEnv('GROQ_API_KEY', 'test-key');
  vi.stubEnv('APPFORGE_LLM_STUB', '');
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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-malformed-data-'));
  tmpDirs.push(dataDir);
});

function setupRun(projectDir: string): string {
  const projectId = `proj-${Math.random().toString(36).slice(2)}`;
  const runId = `run-${Math.random().toString(36).slice(2)}`;
  db.prepare('INSERT INTO projects(id, name, type, status) VALUES (?,?,?,?)').run(projectId, 'Malformed project', 'dynamic', 'active');
  db.prepare('INSERT INTO runs(id, project_id, prompt, status, created_at) VALUES (?,?,?,?,?)')
    .run(runId, projectId, 'Build my app', 'queued', new Date().toISOString());
  fs.mkdirSync(path.join(dataDir, 'projects', projectId), { recursive: true });
  fs.cpSync(projectDir, path.join(dataDir, 'projects', projectId), { recursive: true });
  return runId;
}

function stubTemplatesFrom(fixture: string): void {
  const templates = path.join(dataDir, 'templates');
  fs.cpSync(fixture, path.join(templates, 'dynamic-react-node'), { recursive: true });
  vi.stubEnv('APPFORGE_TEMPLATES_DIR', templates);
}

function runRow(runId: string): { status: string; error: string | null; stats_json: string } {
  return db.prepare('SELECT status, error, stats_json FROM runs WHERE id=?').get(runId) as { status: string; error: string | null; stats_json: string };
}

function eventPayloads(runId: string, kind: string): Array<Record<string, unknown>> {
  const rows = db.prepare('SELECT payload_json FROM run_events WHERE run_id=? AND kind=?').all(runId, kind) as Array<{ payload_json: string }>;
  return rows.map((r) => { try { return JSON.parse(r.payload_json) as Record<string, unknown>; } catch { return {}; } });
}

function toolCallCount(runId: string, name: string): number {
  return eventPayloads(runId, 'tool_call').filter((p) => p.name === name).length;
}

/** Scripted model: plays the queue, then keeps returning a final message. */
function script(responses: LlmResponse[]): void {
  const queue = [...responses];
  model.mockImplementation(async () => (queue.length > 0 ? queue.shift()! : final('Done, for real this time.')));
}

/** DB-backed /a/:projectId proxy (same as dynamicGate.test.ts). */
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

const SIX_CHECKS = [
  'run_frontend_build',
  'run_backend_build',
  'run_migrations',
  'run_api_tests',
  'start_fullstack_preview',
  'test_authenticated_flow',
];

/** Happy-path tail shared by (a) and (c): implement, verify, finish. */
const happyTail: LlmResponse[] = [
  ...SIX_CHECKS.map((n) => toolCall(n)),
  toolCall('write_files', { area: 'backend', files: [{ path: 'src/routes/products.ts', content: "export default async function products(app:any){ app.get('/api/products', async()=>[]); }" }] }),
  toolCall('write_files', { area: 'frontend', files: [{ path: 'src/App.tsx', content: 'export default function App(){ return <div>STORE</div>; }' }] }),
  ...SIX_CHECKS.map((n) => toolCall(n)),
  final('Store built'),
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('malformed tool calls in the agent loop', () => {
  it('(a) retries a completion whose read_file arrived with empty raw arguments, then proceeds', async () => {
    const fixture = makeTemplatedProject();
    stubTemplatesFrom(fixture);
    const runId = setupRun(fixture);
    const proxy = await startGateProxy();
    vi.stubEnv('APPFORGE_STUDIO_URL', proxy.url);
    try {
      script([
        malformedCall('read_file'),
        toolCall('read_file', { area: 'backend', path: 'src/routes/todos.ts' }),
        ...happyTail,
      ]);
      await runAgentOnce(db, runId, { dataDir, settings });
      expect(runRow(runId).status).toBe('done');
      // The retry request carried the temporary notice naming tool + parameter.
      const retryMessages = (model.mock.calls[1] as unknown[])[1] as Array<{ role: string; content: string | null }>;
      const notice = retryMessages[retryMessages.length - 1]!;
      expect(notice.role).toBe('user');
      expect(notice.content).toContain('missing or empty arguments');
      expect(notice.content).toContain('read_file');
      expect(notice.content).toContain('path');
      // The malformed call was never executed; the valid one ran exactly once.
      expect(toolCallCount(runId, 'read_file')).toBe(1);
      const logs = eventPayloads(runId, 'log').map((p) => String(p.text ?? ''));
      expect(logs.some((t) => t.includes('llm malformed tool call(s): read_file — retrying completion (1/2)'))).toBe(true);
    } finally { await proxy.close(); delete process.env.APPFORGE_STUDIO_URL; delete process.env.APPFORGE_TEMPLATES_DIR; db.close(); }
  }, 240000);

  it('(b) persistent empty arguments end the run with LLM_BAD_TOOL_ARGS after 1+2 completions and zero executions', async () => {
    const runId = setupRun(makeGateProject());
    model.mockImplementation(async () => malformedCall('read_file'));
    await runAgentOnce(db, runId, { dataDir, settings });
    expect(model).toHaveBeenCalledTimes(3);
    const row = runRow(runId);
    expect(row.status).toBe('error');
    expect(row.error).toContain('read_file');
    expect(row.error).toContain('path');
    const errorEvents = eventPayloads(runId, 'error');
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]!.code).toBe('LLM_BAD_TOOL_ARGS');
    expect(toolCallCount(runId, 'read_file')).toBe(0);
    // Every completion (initial + 2 retries) counted as an LLM call.
    expect((JSON.parse(row.stats_json) as { llmCalls: number }).llmCalls).toBe(3);
    db.close();
  }, 60000);

  it('(c) a wrong-key emission (read_file {file}) takes the same retry path via required parameters', async () => {
    const fixture = makeTemplatedProject();
    stubTemplatesFrom(fixture);
    const runId = setupRun(fixture);
    const proxy = await startGateProxy();
    vi.stubEnv('APPFORGE_STUDIO_URL', proxy.url);
    try {
      script([
        toolCall('read_file', { file: 'src/routes/todos.ts' }),
        toolCall('read_file', { area: 'backend', path: 'src/routes/todos.ts' }),
        ...happyTail,
      ]);
      await runAgentOnce(db, runId, { dataDir, settings });
      expect(runRow(runId).status).toBe('done');
      const retryMessages = (model.mock.calls[1] as unknown[])[1] as Array<{ role: string; content: string | null }>;
      const notice = retryMessages[retryMessages.length - 1]!;
      expect(notice.content).toContain('read_file (missing: path)');
      expect(toolCallCount(runId, 'read_file')).toBe(1);
    } finally { await proxy.close(); delete process.env.APPFORGE_STUDIO_URL; delete process.env.APPFORGE_TEMPLATES_DIR; db.close(); }
  }, 240000);

  it('(d) aborts with TOOL_ARGUMENT_STAGNATION after 3 consecutive missing-argument rejections for the same tool', async () => {
    const runId = setupRun(makeGateProject());
    // write_files whose single item lacks `content`: top-level `files` is
    // present, so the completion-retry layer cannot see it — the tool
    // itself rejects with `missing required argument: content`.
    script([
      toolCall('write_files', { files: [{ path: 'src/App.tsx' }] }),
      toolCall('write_files', { files: [{ path: 'src/App.tsx' }] }),
      toolCall('write_files', { files: [{ path: 'src/App.tsx' }] }),
      toolCall('write_files', { files: [{ path: 'src/App.tsx' }] }),
    ]);
    await runAgentOnce(db, runId, { dataDir, settings });
    expect(model).toHaveBeenCalledTimes(3);
    expect(runRow(runId).status).toBe('error');
    const errorEvents = eventPayloads(runId, 'error');
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]!.code).toBe('TOOL_ARGUMENT_STAGNATION');
    expect(toolCallCount(runId, 'write_files')).toBe(3);
    db.close();
  }, 60000);
});

describe('updateArgumentStreak', () => {
  it('counts consecutive missing-argument rejections for the same tool', () => {
    let s = updateArgumentStreak({ tool: '', count: 0 }, 'read_file', 'missing required argument: path');
    expect(s).toEqual({ tool: 'read_file', count: 1 });
    s = updateArgumentStreak(s, 'read_file', 'missing required argument: path');
    expect(s).toEqual({ tool: 'read_file', count: 2 });
  });

  it('resets on a different tool, a success, or a different error', () => {
    const s = { tool: 'read_file', count: 2 };
    expect(updateArgumentStreak(s, 'write_file', 'missing required argument: content')).toEqual({ tool: 'write_file', count: 1 });
    expect(updateArgumentStreak(s, 'read_file', undefined)).toEqual({ tool: '', count: 0 });
    expect(updateArgumentStreak(s, 'read_file', 'some other failure')).toEqual({ tool: '', count: 0 });
  });
});
