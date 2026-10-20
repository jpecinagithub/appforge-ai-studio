/**
 * Fase 1 (agent hardening): write guards + immediate backend typecheck.
 *
 * Covers the two regression failure modes from pcBOX / PlayStation:
 *  - write_file gutting a module its importers depend on (placeholder stub:
 *    same exported name, parameters gone) or emptying it outright;
 *  - loose scratch scripts (test_backend.js, debug_server.js…) written at
 *    the frontend root;
 * and the new feedback loop: backend-area writes report NEW tsc errors in
 * the tool result itself.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, test } from 'vitest';
import { createTools, type ToolContext } from './tools.js';
import { checkWriteGuard, extractExportedSymbols, frontendRootScriptError } from './writeGuard.js';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY, type TEXT)');
  return db;
}

function makeCtx(db: Database.Database, projectDir: string, type: 'dynamic' | 'static', id: string): ToolContext {
  db.prepare('INSERT OR REPLACE INTO projects(id, type) VALUES (?,?)').run(id, type);
  return {
    db,
    projectId: id,
    projectDir,
    frontendDir: path.join(projectDir, 'frontend'),
    cmdTimeoutMs: 60_000,
    buildTimeoutMs: 120_000,
  };
}

function makeProject(type: 'dynamic' | 'static'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-guard-'));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'frontend', 'src'), { recursive: true });
  if (type === 'dynamic') {
    fs.mkdirSync(path.join(dir, 'backend', 'src', 'routes'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'migrations'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  }
  return dir;
}

const FULL_TODOS = [
  "import type { FastifyInstance } from 'fastify';",
  '',
  'export function registerTodoRoutes(app: FastifyInstance, db: unknown, config: { x: number }): void {',
  "  app.get('/api/todos', async () => []);",
  "  void db; void config;",
  '}',
  '',
  'export const unusedHelper = 42;',
  '',
].join('\n');

const STUB_TODOS = 'export function registerTodoRoutes() {\n  // Placeholder implementation\n}\n';

const SERVER_TS = [
  "import { registerTodoRoutes } from './routes/todos.js';",
  '',
  'declare const app: never;',
  'registerTodoRoutes(app, {}, { x: 1 });',
  '',
].join('\n');

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('extractExportedSymbols', () => {
  test('captures function arity, declarations, aliases and default', () => {
    const symbols = extractExportedSymbols(
      [
        'export function alpha(a: number, b: string, c?: boolean) {}',
        'export async function beta() {}',
        'export const gamma = 1;',
        'export interface Delta { x: number }',
        'const local = 1; export { local as epsilon };',
        'export default function App() {}',
      ].join('\n'),
    );
    expect(symbols.get('alpha')?.arity).toBe(3);
    expect(symbols.get('beta')?.arity).toBe(0);
    expect(symbols.get('gamma')?.arity).toBeNull();
    expect(symbols.has('Delta')).toBe(true);
    expect(symbols.has('epsilon')).toBe(true);
    expect(symbols.has('default')).toBe(true);
    expect(symbols.get('App')?.arity).toBe(0);
  });

  test('counts parameters with defaults and nested structures as one each', () => {
    const symbols = extractExportedSymbols('export function f(a = [1, 2], b: { x: number } = { x: 1 }) {}');
    expect(symbols.get('f')?.arity).toBe(2);
  });
});

describe('frontendRootScriptError', () => {
  test('rejects loose scripts at the frontend root', () => {
    expect(frontendRootScriptError('test_backend.js', 'test_backend.js')).toMatch(/loose script/);
    expect(frontendRootScriptError('debug_server.js', 'debug_server.js')).not.toBeNull();
    expect(frontendRootScriptError('probe.ts', 'probe.ts')).not.toBeNull();
  });
  test('allows subfolders, configs and non-scripts', () => {
    expect(frontendRootScriptError('scratch/probe.js', 'scratch/probe.js')).toBeNull();
    expect(frontendRootScriptError('src/main.tsx', 'src/main.tsx')).toBeNull();
    expect(frontendRootScriptError('vite.config.ts', 'vite.config.ts')).toBeNull();
    expect(frontendRootScriptError('index.html', 'index.html')).toBeNull();
    expect(frontendRootScriptError('package.json', 'package.json')).toBeNull();
  });
});

describe('checkWriteGuard (unit)', () => {
  test('new files and non-breaking rewrites pass', () => {
    const dir = makeProject('dynamic');
    const target = path.join(dir, 'backend', 'src', 'routes', 'todos.ts');
    expect(checkWriteGuard({ projectDir: dir, targetAbs: target, displayPath: 'todos.ts', newContent: STUB_TODOS }).ok).toBe(true);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, FULL_TODOS);
    // Rewriting with the same exported API is fine.
    expect(checkWriteGuard({ projectDir: dir, targetAbs: target, displayPath: 'todos.ts', newContent: FULL_TODOS.replace('42', '43') }).ok).toBe(true);
  });

  test('emptying an existing non-empty file is rejected', () => {
    const dir = makeProject('dynamic');
    const target = path.join(dir, 'backend', 'src', 'routes', 'todos.ts');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, FULL_TODOS);
    const r = checkWriteGuard({ projectDir: dir, targetAbs: target, displayPath: 'todos.ts', newContent: '  \n' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/new content is empty/);
  });

  test('dropping an export nobody imports is allowed; dropping an imported one is not', () => {
    const dir = makeProject('dynamic');
    const routesDir = path.join(dir, 'backend', 'src', 'routes');
    fs.mkdirSync(routesDir, { recursive: true });
    const target = path.join(routesDir, 'todos.ts');
    fs.writeFileSync(target, FULL_TODOS);
    fs.writeFileSync(path.join(dir, 'backend', 'src', 'server.ts'), SERVER_TS);
    const withoutUnused = FULL_TODOS.replace('\nexport const unusedHelper = 42;\n', '\n');
    expect(checkWriteGuard({ projectDir: dir, targetAbs: target, displayPath: 'todos.ts', newContent: withoutUnused }).ok).toBe(true);
    const withoutRoutes = FULL_TODOS.replace(/export function registerTodoRoutes[\s\S]*?\n}\n/, '');
    const r = checkWriteGuard({ projectDir: dir, targetAbs: target, displayPath: 'todos.ts', newContent: withoutRoutes });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toMatch(/registerTodoRoutes/);
      expect(r.message).toMatch(/server\.ts/);
    }
  });
});

// ---------------------------------------------------------------------------
// Tool-level integration (guards)
// ---------------------------------------------------------------------------

describe('write guards through the tools', () => {
  test('the pcBOX stub is rejected and the file on disk is untouched', async () => {
    const db = makeDb();
    const dir = makeProject('dynamic');
    const ctx = makeCtx(db, dir, 'dynamic', 'guard-stub');
    const tools = createTools();
    const target = path.join(dir, 'backend', 'src', 'routes', 'todos.ts');
    fs.writeFileSync(target, FULL_TODOS);
    fs.writeFileSync(path.join(dir, 'backend', 'src', 'server.ts'), SERVER_TS);

    const r = await tools.write_file(ctx, { area: 'backend', path: 'src/routes/todos.ts', content: STUB_TODOS });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('WRITE_GUARD_REJECTED');
    expect(r.error ?? '').toMatch(/registerTodoRoutes/);
    expect(r.error ?? '').toMatch(/drops parameters \(3 → 0\)/);
    expect(fs.readFileSync(target, 'utf8')).toBe(FULL_TODOS);
    db.close();
  });

  test('emptying via write_file is rejected; delete_file remains the way to remove', async () => {
    const db = makeDb();
    const dir = makeProject('dynamic');
    const ctx = makeCtx(db, dir, 'dynamic', 'guard-empty');
    const tools = createTools();
    const target = path.join(dir, 'backend', 'src', 'routes', 'todos.ts');
    fs.writeFileSync(target, FULL_TODOS);
    const r = await tools.write_file(ctx, { area: 'backend', path: 'src/routes/todos.ts', content: '' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('WRITE_GUARD_REJECTED');
    expect(fs.readFileSync(target, 'utf8')).toBe(FULL_TODOS);
    db.close();
  });

  test('an atomic write_files batch that updates the importer passes', async () => {
    const db = makeDb();
    const dir = makeProject('dynamic');
    const ctx = makeCtx(db, dir, 'dynamic', 'guard-batch');
    const tools = createTools();
    const target = path.join(dir, 'backend', 'src', 'routes', 'todos.ts');
    fs.writeFileSync(target, FULL_TODOS);
    fs.writeFileSync(path.join(dir, 'backend', 'src', 'server.ts'), SERVER_TS);
    const r = await tools.write_files(ctx, {
      area: 'backend',
      files: [
        { path: 'src/routes/todos.ts', content: STUB_TODOS },
        { path: 'src/server.ts', content: '// routes removed on purpose\n' },
      ],
    });
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe(STUB_TODOS);
    db.close();
  });

  test('a rejected file aborts the whole write_files batch (nothing is written)', async () => {
    const db = makeDb();
    const dir = makeProject('dynamic');
    const ctx = makeCtx(db, dir, 'dynamic', 'guard-batch-abort');
    const tools = createTools();
    const target = path.join(dir, 'backend', 'src', 'routes', 'todos.ts');
    fs.writeFileSync(target, FULL_TODOS);
    fs.writeFileSync(path.join(dir, 'backend', 'src', 'server.ts'), SERVER_TS);
    const goodNew = path.join(dir, 'backend', 'src', 'newfile.ts');
    const r = await tools.write_files(ctx, {
      area: 'backend',
      files: [
        { path: 'src/newfile.ts', content: 'export const fresh = 1;' },
        { path: 'src/routes/todos.ts', content: STUB_TODOS },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('WRITE_GUARD_REJECTED');
    expect(fs.existsSync(goodNew)).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toBe(FULL_TODOS);
    db.close();
  });

  test('loose root scripts are rejected in the dynamic frontend area; scratch/ and vite.config pass; static projects are unchanged', async () => {
    const db = makeDb();
    const tools = createTools();

    const dynDir = makeProject('dynamic');
    const dyn = makeCtx(db, dynDir, 'dynamic', 'guard-root-dyn');
    let r = await tools.write_file(dyn, { path: 'test_backend.js', content: 'console.log(1)' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ROOT_SCRIPT_REJECTED');
    expect(fs.existsSync(path.join(dynDir, 'frontend', 'test_backend.js'))).toBe(false);
    r = await tools.write_file(dyn, { path: 'scratch/test_backend.js', content: 'console.log(1)' });
    expect(r.ok).toBe(true);
    r = await tools.write_file(dyn, { path: 'vite.config.ts', content: 'export default {};' });
    expect(r.ok).toBe(true);

    // Static projects keep exactly their previous behaviour (the hygiene
    // rule targets the dynamic area system, where the junk entered).
    const stDir = makeProject('static');
    const st = makeCtx(db, stDir, 'static', 'guard-root-static');
    r = await tools.write_file(st, { path: 'debug_server.js', content: 'console.log(1)' });
    expect(r.ok).toBe(true);
    r = await tools.write_file(st, { path: 'src/main.ts', content: 'export {};' });
    expect(r.ok).toBe(true);
    db.close();
  });

  test('namespace imports also protect the exports they consume', async () => {
    const db = makeDb();
    const dir = makeProject('dynamic');
    const ctx = makeCtx(db, dir, 'dynamic', 'guard-namespace');
    const tools = createTools();
    const target = path.join(dir, 'backend', 'src', 'routes', 'todos.ts');
    fs.writeFileSync(target, FULL_TODOS);
    fs.writeFileSync(
      path.join(dir, 'backend', 'src', 'server.ts'),
      "import * as todos from './routes/todos.js';\nvoid todos;\n",
    );
    const r = await tools.write_file(ctx, { area: 'backend', path: 'src/routes/todos.ts', content: STUB_TODOS });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('WRITE_GUARD_REJECTED');
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Tool-level integration (immediate backend typecheck)
// ---------------------------------------------------------------------------

function typescriptPkg(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    path.resolve(here, '../../node_modules/typescript'),
    path.resolve(here, '../../../node_modules/typescript'),
  ]) {
    if (fs.existsSync(path.join(candidate, 'bin', 'tsc'))) return fs.realpathSync(candidate);
  }
  return null;
}

describe('backend typecheck attached to writes', () => {
  test('new type errors are reported in the write result; fixes clear them; frontend writes skip it', async () => {
    const tsPkg = typescriptPkg();
    if (!tsPkg) throw new Error('typescript package not found in workspace node_modules');
    const db = makeDb();
    const dir = makeProject('dynamic');
    const ctx = makeCtx(db, dir, 'dynamic', 'guard-typecheck');
    const tools = createTools();
    const backend = path.join(dir, 'backend');
    fs.mkdirSync(path.join(backend, 'node_modules'), { recursive: true });
    fs.symlinkSync(tsPkg, path.join(backend, 'node_modules', 'typescript'), 'dir');
    fs.writeFileSync(
      path.join(backend, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', skipLibCheck: true },
        include: ['src'],
      }),
    );
    fs.writeFileSync(path.join(backend, 'src', 'ok.ts'), 'export const ok: number = 1;\n');

    // 1. Introduce a type error: the write succeeds but reports the error NOW.
    let r = await tools.write_file(ctx, {
      area: 'backend',
      path: 'src/bad.ts',
      content: 'export const bad: number = "not a number";\n',
    });
    expect(r.ok).toBe(true);
    expect(r.output ?? '').toMatch(/type error/);
    expect(r.output ?? '').toMatch(/TS2322/);
    const tc1 = (r.data as { typecheck?: { totalErrors: number; newErrors: string[] } }).typecheck;
    expect(tc1?.totalErrors).toBeGreaterThanOrEqual(1);
    expect(tc1?.newErrors.some((l) => l.includes('TS2322'))).toBe(true);

    // 2. An unrelated valid write: the same error is no longer "new".
    r = await tools.write_file(ctx, { area: 'backend', path: 'src/other.ts', content: 'export const other = 2;\n' });
    expect(r.ok).toBe(true);
    expect(r.output ?? '').toMatch(/no NEW type errors/);
    expect(r.output ?? '').toMatch(/pre-existing/);

    // 3. Fixing the error clears the report.
    r = await tools.write_file(ctx, { area: 'backend', path: 'src/bad.ts', content: 'export const bad: number = 3;\n' });
    expect(r.ok).toBe(true);
    expect(r.output ?? '').toMatch(/no type errors/);

    // 4. Frontend writes never trigger the backend typecheck.
    r = await tools.write_file(ctx, { path: 'src/App.tsx', content: 'export default function App(){return null}' });
    expect(r.ok).toBe(true);
    expect((r.data as { typecheck?: unknown }).typecheck).toBeUndefined();
    db.close();
  }, 120_000);

  test('backend writes stay silent while TypeScript is not installed yet', async () => {
    const db = makeDb();
    const dir = makeProject('dynamic');
    const ctx = makeCtx(db, dir, 'dynamic', 'guard-typecheck-skip');
    const tools = createTools();
    const r = await tools.write_file(ctx, { area: 'backend', path: 'src/a.ts', content: 'export const a = 1;\n' });
    expect(r.ok).toBe(true);
    expect((r.data as { typecheck?: unknown }).typecheck).toBeUndefined();
    db.close();
  });
});
