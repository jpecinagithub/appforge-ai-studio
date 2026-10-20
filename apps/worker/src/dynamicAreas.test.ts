/**
 * Fase 5B tests: controlled editing areas for dynamic projects.
 *
 * The file tools accept an explicit `area` on dynamic projects
 * (frontend/backend/migrations/tests); paths resolve internally inside the
 * active project. Static projects keep exactly their previous behaviour.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, test, afterEach } from 'vitest';
import { createTools, type ToolContext } from './tools.js';
import { invalidateDynamicChecks } from './dynamicTools.js';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function makeProject(type: 'dynamic' | 'static'): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'af-area-test-'));
  tmpDirs.push(dir);
  mkdirSync(path.join(dir, 'frontend', 'src'), { recursive: true });
  writeFileSync(path.join(dir, 'frontend', 'index.html'), '<h1>hi</h1>');
  writeFileSync(path.join(dir, 'frontend', 'package.json'), '{}');
  if (type === 'dynamic') {
    mkdirSync(path.join(dir, 'backend', 'src', 'routes'), { recursive: true });
    writeFileSync(path.join(dir, 'backend', 'src', 'server.ts'), 'export const x = 1;');
    writeFileSync(path.join(dir, 'backend', 'package.json'), '{}');
    mkdirSync(path.join(dir, 'migrations'), { recursive: true });
    writeFileSync(path.join(dir, 'migrations', '001_init.sql'), 'CREATE TABLE t(id TEXT);');
    mkdirSync(path.join(dir, 'tests'), { recursive: true });
    writeFileSync(path.join(dir, 'tests', 'api.test.mjs'), 'console.log("ok");');
  }
  return dir;
}

function makeCtx(db: Database.Database, projectDir: string, type: 'dynamic' | 'static'): ToolContext {
  const projectId = `area-${type}-${tmpDirs.length}`;
  db.prepare('INSERT OR REPLACE INTO projects(id, type) VALUES (?,?)').run(projectId, type);
  return {
    db,
    projectId,
    projectDir,
    frontendDir: path.join(projectDir, 'frontend'),
    cmdTimeoutMs: 30000,
    buildTimeoutMs: 120000,
  };
}

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY, type TEXT)');
  return db;
}

describe('dynamic editing areas', () => {
  test('read/write/patch per area', async () => {
    const db = makeDb();
    const dir = makeProject('dynamic');
    const ctx = makeCtx(db, dir, 'dynamic');
    const tools = createTools();

    // backend write + read
    let r = await tools.write_file(ctx, { area: 'backend', path: 'src/routes/items.ts', content: 'export const items = [];' });
    expect(r.ok).toBe(true);
    r = await tools.read_file(ctx, { area: 'backend', path: 'src/routes/items.ts' });
    expect(r.ok).toBe(true);
    expect((r.data as { content: string }).content).toBe('export const items = [];');

    // migrations write
    r = await tools.write_file(ctx, { area: 'migrations', path: '002_add.sql', content: 'ALTER TABLE t ADD COLUMN b TEXT;' });
    expect(r.ok).toBe(true);
    expect(existsSync(path.join(dir, 'migrations', '002_add.sql'))).toBe(true);

    // tests write
    r = await tools.write_file(ctx, { area: 'tests', path: 'extra.test.mjs', content: 'console.log(1);' });
    expect(r.ok).toBe(true);

    // patch in backend
    r = await tools.patch_file(ctx, { area: 'backend', path: 'src/server.ts', search: 'export const x = 1;', replace: 'export const x = 2;' });
    expect(r.ok).toBe(true);
    expect(readFileSync(path.join(dir, 'backend', 'src', 'server.ts'), 'utf8')).toContain('export const x = 2;');

    // frontend still the default (probe lives under src/: Fase 1 rejects
    // loose script files at the frontend root of dynamic projects)
    r = await tools.write_file(ctx, { path: 'src/app.js', content: 'console.log(1);' });
    expect(r.ok).toBe(true);
    expect(existsSync(path.join(dir, 'frontend', 'src', 'app.js'))).toBe(true);

    // search scoped to the area
    r = await tools.search_code(ctx, { area: 'backend', pattern: 'export const x' });
    expect(r.ok).toBe(true);
    const matches = (r.data as { matches: Array<{ file: string }> }).matches;
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.every((m) => m.file.startsWith('src/'))).toBe(true);

    // list scoped to the area
    r = await tools.list_files(ctx, { area: 'migrations' });
    expect(r.ok).toBe(true);
  });

  test('traversal, absolute paths and null bytes are rejected', async () => {
    const db = makeDb();
    const ctx = makeCtx(db, makeProject('dynamic'), 'dynamic');
    const tools = createTools();

    let r = await tools.read_file(ctx, { area: 'backend', path: '../../etc/passwd' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('INVALID_PATH');

    r = await tools.write_file(ctx, { area: 'backend', path: '/etc/passwd', content: 'x' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('INVALID_PATH');

    r = await tools.read_file(ctx, { area: 'frontend', path: 'a\0b' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('INVALID_PATH');
  });

  test('symlink escape is rejected', async () => {
    const db = makeDb();
    const dir = makeProject('dynamic');
    const ctx = makeCtx(db, dir, 'dynamic');
    const tools = createTools();
    // Plant a symlink inside the backend area pointing outside the project.
    const outside = mkdtempSync(path.join(tmpdir(), 'af-area-outside-'));
    tmpDirs.push(outside);
    writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    try {
      symlinkSync(outside, path.join(dir, 'backend', 'src', 'link'));
    } catch {
      return; // symlinks need privileges on some systems; skip if unavailable
    }
    const r = await tools.read_file(ctx, { area: 'backend', path: 'src/link/secret.txt' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('SYMLINK_ESCAPE');
  });

  test('forbidden and AppForge-controlled paths are rejected in every area', async () => {
    const db = makeDb();
    const ctx = makeCtx(db, makeProject('dynamic'), 'dynamic');
    const tools = createTools();
    const cases: Array<[string, string]> = [
      ['frontend', '.env'],
      ['frontend', 'package.json'],
      ['frontend', 'package-lock.json'],
      ['frontend', 'dist/bundle.js'],
      ['frontend', 'node_modules/x/index.js'],
      ['backend', 'package.json'],
      ['backend', 'Dockerfile'],
      ['backend', 'src/../../Dockerfile'],
      ['migrations', '../docker-compose.yml'],
      ['tests', '.env.local'],
    ];
    for (const [area, p] of cases) {
      const r = await tools.write_file(ctx, { area, path: p, content: 'x' });
      expect(r.ok).toBe(false);
      expect(['AREA_PATH_FORBIDDEN', 'AREA_PATH_NOT_ALLOWED', 'INVALID_PATH']).toContain(r.code);
    }
  });

  test('paths outside the allowed shape are rejected', async () => {
    const db = makeDb();
    const ctx = makeCtx(db, makeProject('dynamic'), 'dynamic');
    const tools = createTools();

    // backend only allows src/**
    let r = await tools.write_file(ctx, { area: 'backend', path: 'other/file.ts', content: 'x' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('AREA_PATH_NOT_ALLOWED');

    // migrations only allows top-level *.sql
    r = await tools.write_file(ctx, { area: 'migrations', path: 'sub/002.sql', content: 'x' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('AREA_PATH_NOT_ALLOWED');
    r = await tools.write_file(ctx, { area: 'migrations', path: '002.txt', content: 'x' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('AREA_PATH_NOT_ALLOWED');

    // tests only allows top-level *.test.mjs
    r = await tools.write_file(ctx, { area: 'tests', path: 'helper.mjs', content: 'x' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('AREA_PATH_NOT_ALLOWED');

    // unknown area
    r = await tools.read_file(ctx, { area: 'infra', path: 'x' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('INVALID_AREA');
  });

  test('static projects keep exactly their previous behaviour', async () => {
    const db = makeDb();
    const dir = makeProject('static');
    const ctx = makeCtx(db, dir, 'static');
    const tools = createTools();

    // area is rejected on static projects
    let r = await tools.read_file(ctx, { area: 'backend', path: 'src/server.ts' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('AREA_NOT_SUPPORTED');

    // without area: resolves under frontend/ exactly as before
    r = await tools.read_file(ctx, { path: 'index.html' });
    expect(r.ok).toBe(true);
    expect((r.data as { content: string }).content).toBe('<h1>hi</h1>');

    r = await tools.write_file(ctx, { path: 'new.js', content: 'x' });
    expect(r.ok).toBe(true);
    expect(existsSync(path.join(dir, 'frontend', 'new.js'))).toBe(true);

    r = await tools.list_files(ctx, {});
    expect(r.ok).toBe(true);
  });

  test('a change in an area invalidates the affected receipts and their followers', async () => {
    const db = makeDb();
    const dir = makeProject('dynamic');
    const ctx = makeCtx(db, dir, 'dynamic');
    const tools = createTools();

    // Pretend all four 5A checks are valid right now (use the real recorder
    // so the fingerprints match exactly what the invalidator compares).
    const { recordDynamicCheckForTest } = await import('./dynamicTools.js');
    recordDynamicCheckForTest(ctx, 'frontendBuild');
    recordDynamicCheckForTest(ctx, 'backendBuild');
    recordDynamicCheckForTest(ctx, 'migrations');
    recordDynamicCheckForTest(ctx, 'apiTests');

    // Edit a backend file through the area tool, then run the invalidator
    // (the agent loop calls it after every file tool on dynamic projects).
    const r = await tools.write_file(ctx, { area: 'backend', path: 'src/changed.ts', content: 'x' });
    expect(r.ok).toBe(true);
    invalidateDynamicChecks(ctx);
    // backendBuild is stale now, and so are its canonical followers
    expect(ctx.dynamicChecks?.backendBuild).toBeUndefined();
    expect(ctx.dynamicChecks?.migrations).toBeUndefined();
    expect(ctx.dynamicChecks?.apiTests).toBeUndefined();
    // frontendBuild is untouched by a backend change (prefix invariant)
    expect(ctx.dynamicChecks?.frontendBuild).toBeTruthy();
    expect(ctx.dynamicChecksOrder).toEqual(['frontendBuild']);
  });

  test('delete_file refuses the area root (".", "./", "a/..")', async () => {
    const db = makeDb();
    const dir = makeProject('dynamic');
    const ctx = makeCtx(db, dir, 'dynamic');
    const tools = createTools();

    for (const p of ['.', './', 'src/..', 'src/../', './/']) {
      const r = await tools.delete_file(ctx, { area: 'backend', path: p });
      expect(r.ok).toBe(false);
      expect(r.code).toBe('AREA_ROOT_DELETE');
    }
    // The area root is intact and deleting a real file still works.
    expect(existsSync(path.join(dir, 'backend', 'src', 'server.ts'))).toBe(true);
    const ok = await tools.delete_file(ctx, { area: 'backend', path: 'src/server.ts' });
    expect(ok.ok).toBe(true);
    expect(existsSync(path.join(dir, 'backend', 'src', 'server.ts'))).toBe(false);
  });

  test('read_file rejects invalid UTF-8 bytes (strict decoding)', async () => {
    const db = makeDb();
    const dir = makeProject('dynamic');
    const ctx = makeCtx(db, dir, 'dynamic');
    const tools = createTools();

    // 0xFF 0xFE are never valid UTF-8: must fail, not silently become U+FFFD.
    writeFileSync(path.join(dir, 'backend', 'src', 'bad.bin.ts'), Buffer.from([0x68, 0x69, 0xff, 0xfe, 0x0a]));
    const r = await tools.read_file(ctx, { area: 'backend', path: 'src/bad.bin.ts' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('NOT_UTF8_TEXT');

    // Valid UTF-8 (incl. multibyte) still reads fine.
    writeFileSync(path.join(dir, 'backend', 'src', 'good.ts'), 'héllo wörld ✓\n');
    const ok = await tools.read_file(ctx, { area: 'backend', path: 'src/good.ts' });
    expect(ok.ok).toBe(true);
    expect((ok.data as { content: string }).content).toContain('héllo');
  });
});
