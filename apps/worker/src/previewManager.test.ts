/**
 * Fase 5B tests: start_fullstack_preview and the preview manager.
 *
 * Fixture-based: a fake backend (node:http, no dependencies) mimics the
 * template's observable contract — env-driven PORT/HOST/DB_PATH, /healthz,
 * and the auth/todos API used by the authenticated-flow tests.
 */
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { describe, expect, test, afterEach, beforeEach } from 'vitest';
import {
  ensurePreviewsTable,
  getPreview,
  startFullstackPreview,
  stopPreview,
  failPreview,
  reconcilePreviews,
  previewCookieName,
  validatePreviewTmpDir,
  PREVIEW_ENABLE_ENV,
} from './previewManager.js';
import { recordDynamicCheckForTest, previewGateStatus } from './dynamicTools.js';
import type { ToolContext } from './tools.js';

import { FAKE_SERVER } from './previewFixture.js';


const tmpDirs: string[] = [];
const ENV_SAVED = process.env[PREVIEW_ENABLE_ENV];
beforeEach(() => {
  // Previews execute generated code: tests opt in explicitly.
  process.env[PREVIEW_ENABLE_ENV] = '1';
});
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  if (ENV_SAVED === undefined) delete process.env[PREVIEW_ENABLE_ENV];
  else process.env[PREVIEW_ENABLE_ENV] = ENV_SAVED;
});

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY, type TEXT)');
  ensurePreviewsTable(db);
  return db;
}

/** Project fixture with a fake backend entry at backend/dist/server.js. */
function makeProject(opts: { mode?: string } = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'af-preview-test-'));
  tmpDirs.push(dir);
  mkdirSync(path.join(dir, 'backend', 'dist'), { recursive: true });
  mkdirSync(path.join(dir, 'frontend'), { recursive: true });
  writeFileSync(path.join(dir, 'backend', 'dist', 'server.js'), FAKE_SERVER);
  if (opts.mode) writeFileSync(path.join(dir, 'backend', 'dist', 'fake-mode.txt'), opts.mode);
  writeFileSync(path.join(dir, 'frontend', 'index.html'), '<h1>x</h1>');
  return dir;
}

function makeCtx(db: Database.Database, projectDir: string, projectId = 'pv1'): ToolContext {
  db.prepare('INSERT OR REPLACE INTO projects(id, type) VALUES (?,?)').run(projectId, 'dynamic');
  return {
    db,
    projectId,
    projectDir,
    frontendDir: path.join(projectDir, 'frontend'),
    cmdTimeoutMs: 30000,
    buildTimeoutMs: 120000,
    studioBaseUrl: 'http://127.0.0.1:1', // unused by the preview manager
  };
}

/** Mark the four 5A checks valid on the current sources. */
function mark5AValid(ctx: ToolContext): void {
  recordDynamicCheckForTest(ctx, 'frontendBuild');
  recordDynamicCheckForTest(ctx, 'backendBuild');
  recordDynamicCheckForTest(ctx, 'migrations');
  recordDynamicCheckForTest(ctx, 'apiTests');
  expect(previewGateStatus(ctx).ok).toBe(true);
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe('start_fullstack_preview', () => {
  test('refuses without the opt-in env var (disabled by default)', async () => {
    delete process.env[PREVIEW_ENABLE_ENV];
    const db = makeDb();
    const ctx = makeCtx(db, makeProject());
    mark5AValid(ctx);
    const r = await startFullstackPreview(ctx);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('PREVIEW_DISABLED');
    expect(getPreview(db, ctx.projectId)).toBeUndefined();
  });

  test('refuses without the four 5A checks', async () => {
    const db = makeDb();
    const ctx = makeCtx(db, makeProject());
    const r = await startFullstackPreview(ctx);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('DYNAMIC_CHECKS_INCOMPLETE');
    expect(getPreview(db, ctx.projectId)?.status).not.toBe('ready');
  });

  test('starts the backend, waits for /healthz and registers the preview', async () => {
    const db = makeDb();
    const dir = makeProject();
    const ctx = makeCtx(db, dir);
    mark5AValid(ctx);
    const r = await startFullstackPreview(ctx);
    expect(r.ok).toBe(true);
    expect((r.data as { url: string }).url).toBe(`/a/${ctx.projectId}/`);
    expect((r.data as { status: string }).status).toBe('ready');

    const row = getPreview(db, ctx.projectId);
    expect(row?.status).toBe('ready');
    expect(row?.port).toBeGreaterThan(0);
    expect(row?.pid).toBeGreaterThan(0);
    expect(pidAlive(row!.pid!)).toBe(true);

    // The backend really answers on loopback.
    const health = await fetch(`http://127.0.0.1:${row!.port}/healthz`);
    expect(health.ok).toBe(true);

    // The preview receipt is recorded.
    expect(ctx.dynamicChecks?.fullstackPreview).toBeTruthy();

    await stopPreview(db, ctx.projectId, 'test');
    expect(getPreview(db, ctx.projectId)?.status).toBe('stopped');
    expect(pidAlive(row!.pid!)).toBe(false);
  });

  test('health failure marks the preview failed and cleans up', async () => {
    const db = makeDb();
    const dir = makeProject();
    // Patch the fake server to fail /healthz via env.
    const serverPath = path.join(dir, 'backend', 'dist', 'server.js');
    const src = 'const MODE = process.env.FAKE_PREVIEW_MODE || \'ok\';';
    void src; void serverPath;
    const ctx = makeCtx(db, dir);
    mark5AValid(ctx);
    // Force the failure by wrapping start with a broken entry: remove health
    // by pointing the entry at a script that exits immediately.
    writeFileSync(
      path.join(dir, 'backend', 'dist', 'server.js'),
      'console.error("boom"); process.exit(3);',
    );
    const r = await startFullstackPreview(ctx);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('PREVIEW_HEALTH_FAILED');
    const row = getPreview(db, ctx.projectId);
    expect(row?.status).toBe('failed');
    // No temp dirs leaked.
    const leaked = readdirSync(tmpdir()).filter((f) => f.startsWith(`af-preview-${process.pid}-`));
    expect(leaked).toEqual([]);
  });

  test('starting twice replaces the old preview (no orphans)', async () => {
    const db = makeDb();
    const ctx = makeCtx(db, makeProject());
    mark5AValid(ctx);
    const r1 = await startFullstackPreview(ctx);
    expect(r1.ok).toBe(true);
    const pid1 = getPreview(db, ctx.projectId)!.pid!;

    // Sources unchanged, so the 5A gate still holds; record again after replace.
    const r2 = await startFullstackPreview(ctx);
    expect(r2.ok).toBe(true);
    const row2 = getPreview(db, ctx.projectId)!;
    expect(row2.status).toBe('ready');
    expect(pidAlive(pid1)).toBe(false); // old tree fully stopped
    expect(pidAlive(row2.pid!)).toBe(true);

    await stopPreview(db, ctx.projectId, 'test');
  });

  test('stopPreview removes the temp SQLite/WAL/SHM', async () => {
    const db = makeDb();
    const ctx = makeCtx(db, makeProject());
    mark5AValid(ctx);
    const r = await startFullstackPreview(ctx);
    expect(r.ok).toBe(true);
    const row = getPreview(db, ctx.projectId)!;
    const tmpDir = row.tmp_dir!;
    expect(tmpDir).toBeTruthy();
    // Simulate WAL/SHM next to the db file.
    writeFileSync(row.db_path + '-wal', 'x');
    writeFileSync(row.db_path + '-shm', 'x');
    await stopPreview(db, ctx.projectId, 'test');
    const { existsSync } = await import('node:fs');
    expect(existsSync(tmpDir)).toBe(false);
  });

  test('reconcilePreviews discards stale previews on restart WITHOUT killing PIDs', async () => {
    const db = makeDb();
    const ctx = makeCtx(db, makeProject());
    mark5AValid(ctx);
    const r = await startFullstackPreview(ctx);
    expect(r.ok).toBe(true);
    const pid = getPreview(db, ctx.projectId)!.pid!;
    expect(pidAlive(pid)).toBe(true);

    // Simulate an AppForge restart: reconcile without the in-memory handles.
    // The stale PID must NOT be killed: the OS may have reused it for an
    // unrelated process, so its identity cannot be verified.
    const n = reconcilePreviews(db);
    expect(n).toBe(1);
    const row = getPreview(db, ctx.projectId)!;
    expect(row.status).toBe('stopped');
    expect(row.port).toBeNull();
    expect(row.pid).toBeNull();
    await new Promise((res) => setTimeout(res, 500));
    expect(pidAlive(pid)).toBe(true); // untouched: not our process to kill
    // Clean up the process we started (it is ours: we spawned it).
    try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
  });

  test('backend crash after ready marks the preview failed and cleans up', async () => {
    const db = makeDb();
    const dir = makeProject();
    // Fake backend that answers /healthz once, then dies.
    writeFileSync(
      path.join(dir, 'backend', 'dist', 'server.js'),
      `import http from 'node:http';
const srv = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200); res.end('ok');
    setTimeout(() => process.exit(1), 300);
  } else { res.writeHead(404); res.end(); }
});
srv.listen(Number(process.env.PORT || '0'), '127.0.0.1');\n`,
    );
    const ctx = makeCtx(db, dir);
    mark5AValid(ctx);
    const r = await startFullstackPreview(ctx);
    expect(r.ok).toBe(true);
    const row = getPreview(db, ctx.projectId)!;
    expect(row.status).toBe('ready');
    const tmpDir = row.tmp_dir!;

    // Wait for the exit watcher to observe the crash.
    let crashed: typeof row | undefined;
    for (let i = 0; i < 40 && (!crashed || crashed.status !== 'failed'); i++) {
      await new Promise((res) => setTimeout(res, 250));
      crashed = getPreview(db, ctx.projectId);
    }
    expect(crashed?.status).toBe('failed');
    expect(crashed?.port).toBeNull();
    expect(crashed?.pid).toBeNull();
    expect(crashed?.db_path).toBeNull();
    // Temp SQLite dir removed.
    const { existsSync } = await import('node:fs');
    expect(existsSync(tmpDir)).toBe(false);
    expect(/exited unexpectedly/.test(crashed?.error ?? '')).toBe(true);
  });

  test('validatePreviewTmpDir only allows af-preview-* dirs inside os.tmpdir()', () => {    const base = tmpdir();
    const good = path.join(base, 'af-preview-123-xyz');
    expect(validatePreviewTmpDir(good)).toBe(path.resolve(good));
    // os.tmpdir() itself: refused.
    expect(() => validatePreviewTmpDir(base)).toThrow(/os\.tmpdir\(\) itself/);
    expect(() => validatePreviewTmpDir(base + path.sep)).toThrow();
    // Outside os.tmpdir(): refused.
    expect(() => validatePreviewTmpDir(path.join(base, '..', 'af-preview-x'))).toThrow(/outside/);
    expect(() => validatePreviewTmpDir('/etc/af-preview-x')).toThrow(/outside/);
    // Wrong prefix inside tmpdir: refused.
    expect(() => validatePreviewTmpDir(path.join(base, 'other-dir'))).toThrow(/prefix/);
    expect(() => validatePreviewTmpDir(path.join(base, 'af-preview'))).toThrow(/prefix/);
  });

  test('previewCookieName is project-scoped and cookie-safe', () => {
    const name = previewCookieName('abc-123_DEF');
    expect(name).toMatch(/^af_preview_[A-Za-z0-9]+$/);
    expect(previewCookieName('abc-123_DEF')).toBe(name);
    expect(previewCookieName('other')).not.toBe(name);
  });

  test('stopPreview never kills a PID read from SQLite (foreign live process)', async () => {
    const db = makeDb();
    const ctx = makeCtx(db, makeProject());
    // Simulate a stale row from a previous AppForge lifetime: a live PID this
    // worker never spawned, so there is no ChildProcess in the map.
    const foreign = spawn('node', ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const foreignPid = foreign.pid!;
    expect(pidAlive(foreignPid)).toBe(true);
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'af-preview-foreign-'));
    db.prepare(`INSERT INTO previews(project_id, port, pid, status, db_path, tmp_dir, error, updated_at)
      VALUES (?, ?, ?, 'ready', ?, ?, ?, ?)`)
      .run(ctx.projectId, 45678, foreignPid, path.join(tmpDir, 'preview.db'), tmpDir, null, new Date().toISOString());
    try {
      await stopPreview(db, ctx.projectId, 'test');
      const row = getPreview(db, ctx.projectId)!;
      expect(row.status).toBe('stopped');
      expect(row.pid).toBeNull();
      expect(row.port).toBeNull();
      // The foreign process is untouched...
      expect(pidAlive(foreignPid)).toBe(true);
      // ...but the verified temp dir was still cleaned and the row closed.
      expect(existsSync(tmpDir)).toBe(false);
    } finally {
      try { foreign.kill('SIGKILL'); } catch { /* ignore */ }
    }
  });

  test('failPreview kills an owned live backend and leaves no orphan', async () => {
    const db = makeDb();
    const ctx = makeCtx(db, makeProject());
    mark5AValid(ctx);
    const r = await startFullstackPreview(ctx);
    expect(r.ok).toBe(true);
    const row = getPreview(db, ctx.projectId)!;
    const pid = row.pid!;
    const tmpDir = row.tmp_dir!;
    expect(pidAlive(pid)).toBe(true);

    // Simulate a proxy timeout against a backend that is still alive:
    // fail-close must kill the owned tree and wait for it BEFORE cleaning
    // the temp dir and marking the row failed.
    await failPreview(db, ctx.projectId, 'simulated proxy timeout');
    expect(pidAlive(pid)).toBe(false);
    const failed = getPreview(db, ctx.projectId)!;
    expect(failed.status).toBe('failed');
    expect(failed.pid).toBeNull();
    expect(failed.port).toBeNull();
    expect(failed.db_path).toBeNull();
    expect(existsSync(tmpDir)).toBe(false);
    expect(/simulated proxy timeout/.test(failed.error ?? '')).toBe(true);
  });

  test('failPreview with no owned child never kills the persisted PID', async () => {
    const db = makeDb();
    const ctx = makeCtx(db, makeProject());
    const foreign = spawn('node', ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const foreignPid = foreign.pid!;
    expect(pidAlive(foreignPid)).toBe(true);
    db.prepare(`INSERT INTO previews(project_id, port, pid, status, db_path, tmp_dir, error, updated_at)
      VALUES (?, ?, ?, 'ready', ?, ?, ?, ?)`)
      .run(ctx.projectId, 45679, foreignPid, null, null, null, new Date().toISOString());
    try {
      await failPreview(db, ctx.projectId, 'simulated proxy error');
      // The foreign process is untouched: only the row is closed.
      expect(pidAlive(foreignPid)).toBe(true);
      const row = getPreview(db, ctx.projectId)!;
      expect(row.status).toBe('failed');
      expect(row.pid).toBeNull();
      expect(row.port).toBeNull();
    } finally {
      try { foreign.kill('SIGKILL'); } catch { /* ignore */ }
    }
  });
});
