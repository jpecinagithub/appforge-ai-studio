/**
 * Fase 5B tests: test_authenticated_flow.
 *
 * Uses the shared fake preview (previewFixture) behind a minimal
 * /a/:projectId proxy, exercising the real production code path:
 * the API phase and the Chromium phase both go through the published URL.
 * The Studio proxy itself is covered separately in server.test.ts.
 */
import http from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, test, afterEach, beforeEach } from 'vitest';
import { FAKE_SERVER } from './previewFixture.js';
import { apiAuthFlow, testAuthenticatedFlow } from './authFlow.js';
import {
  ensurePreviewsTable,
  getPreview,
  startFullstackPreview,
  stopPreview,
} from './previewManager.js';
import { recordDynamicCheckForTest } from './dynamicTools.js';
import type { ToolContext } from './tools.js';

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

function makeProject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'af-authflow-test-'));
  tmpDirs.push(dir);
  mkdirSync(path.join(dir, 'backend', 'dist'), { recursive: true });
  mkdirSync(path.join(dir, 'frontend'), { recursive: true });
  writeFileSync(path.join(dir, 'backend', 'dist', 'server.js'), FAKE_SERVER);
  writeFileSync(path.join(dir, 'frontend', 'index.html'), '<h1>x</h1>');
  return dir;
}

/** Minimal /a/:projectId reverse proxy for tests (the real one lives in the server). */
async function startTestProxy(previewPort: number, projectId: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const prefix = `/a/${projectId}`;
    const url = req.url ?? '/';
    if (!url.startsWith(prefix)) { res.writeHead(404); res.end(); return; }
    const rest = url.slice(prefix.length) || '/';
    const proxy = http.request(
      { host: '127.0.0.1', port: previewPort, path: rest, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${previewPort}` } },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      },
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

interface Fixture {
  db: Database.Database;
  ctx: ToolContext;
  projectId: string;
  previewPort: number;
  proxy: { url: string; close: () => Promise<void> };
}

let fx: Fixture | null = null;

beforeEach(async () => {
  const db = makeDb();
  const projectId = 'authflow1';
  const dir = makeProject();
  db.prepare('INSERT INTO projects(id, type) VALUES (?,?)').run(projectId, 'dynamic');
  const ctx: ToolContext = {
    db,
    projectId,
    projectDir: dir,
    frontendDir: path.join(dir, 'frontend'),
    cmdTimeoutMs: 30000,
    buildTimeoutMs: 120000,
    studioBaseUrl: '', // set after the proxy starts
  };
  recordDynamicCheckForTest(ctx, 'frontendBuild');
  recordDynamicCheckForTest(ctx, 'backendBuild');
  recordDynamicCheckForTest(ctx, 'migrations');
  recordDynamicCheckForTest(ctx, 'apiTests');
  const r = await startFullstackPreview(ctx);
  expect(r.ok).toBe(true);
  const previewPort = getPreview(db, projectId)!.port!;
  const proxy = await startTestProxy(previewPort, projectId);
  ctx.studioBaseUrl = proxy.url;
  fx = { db, ctx, projectId, previewPort, proxy };
}, 60_000);

afterEach(async () => {
  if (fx) {
    await stopPreview(fx.db, fx.projectId, 'test').catch(() => null);
    await fx.proxy.close().catch(() => null);
    fx = null;
  }
});

describe('test_authenticated_flow', () => {
  test('deterministic API phase: register, cookie, session, CRUD, isolation, logout, 401', async () => {
    const base = `${fx!.proxy.url}/a/${fx!.projectId}`;
    const { userA, todoTitle } = await apiAuthFlow(base);
    expect(userA).toContain('@example.com');
    expect(todoTitle).toContain('flow-todo-');
  });

  test('full tool: api + browser phases through the published preview', async () => {
    const r = await testAuthenticatedFlow(fx!.ctx);
    expect(r.ok).toBe(true);
    expect((r.data as { phases: string[] }).phases).toEqual(['api', 'browser']);
    expect(fx!.ctx.dynamicChecks?.authenticatedFlow).toBeTruthy();
  }, 120_000);

  test('refuses without a ready preview', async () => {
    await stopPreview(fx!.db, fx!.projectId, 'test');
    const r = await testAuthenticatedFlow(fx!.ctx);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('PREVIEW_NOT_READY');
  });

  test('refuses a stale preview (sources changed after start)', async () => {
    // Simulate a source edit: the preview receipt no longer matches.
    writeFileSync(path.join(fx!.ctx.projectDir, 'frontend', 'changed.js'), 'x');
    const r = await testAuthenticatedFlow(fx!.ctx);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('DYNAMIC_CHECKS_INCOMPLETE');
  });
});
