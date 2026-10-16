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
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, test, afterEach } from 'vitest';
import {
  ensurePreviewsTable,
  getPreview,
  startFullstackPreview,
  stopPreview,
  reconcilePreviews,
  previewCookieName,
} from './previewManager.js';
import { recordDynamicCheckForTest, previewGateStatus } from './dynamicTools.js';
import type { ToolContext } from './tools.js';

import { FAKE_SERVER } from './previewFixture.js';


const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
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

  test('reconcilePreviews discards stale previews on restart', async () => {
    const db = makeDb();
    const ctx = makeCtx(db, makeProject());
    mark5AValid(ctx);
    const r = await startFullstackPreview(ctx);
    expect(r.ok).toBe(true);
    const pid = getPreview(db, ctx.projectId)!.pid!;
    expect(pidAlive(pid)).toBe(true);

    // Simulate an AppForge restart: reconcile without the in-memory handles.
    const n = reconcilePreviews(db);
    expect(n).toBe(1);
    const row = getPreview(db, ctx.projectId)!;
    expect(row.status).toBe('stopped');
    expect(row.port).toBeNull();
    // The stale process was killed (best effort), never trusted.
    await new Promise((res) => setTimeout(res, 500));
    expect(pidAlive(pid)).toBe(false);
  });

  test('previewCookieName is project-scoped and cookie-safe', () => {
    const name = previewCookieName('abc-123_DEF');
    expect(name).toMatch(/^af_preview_[A-Za-z0-9]+$/);
    expect(previewCookieName('abc-123_DEF')).toBe(name);
    expect(previewCookieName('other')).not.toBe(name);
  });
});
