/**
 * Fase 5B tests: the dynamic preview proxy /a/:projectId/*.
 *
 * A fake upstream (node:http) stands in for the preview backend; the
 * previews registry row points at it. Verifies: GET/POST/PATCH/DELETE
 * forwarding, query+body preservation, cookies through the proxy, the
 * Studio Authorization header never forwarded, hop-by-hop stripping,
 * cross-project rejection, and the diagnostic page when no preview exists.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { openDb } from './db.js';
import { buildServer } from './index.js';
import { ensurePreviewsTable } from 'appforge-worker';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.resolve(SRC_DIR, '..', '..', '..', 'templates');

let db: Database.Database;
let app: FastifyInstance;
let dataDir: string;
let baseUrl: string;
let upstream: http.Server;
let upstreamPort: number;
let upstreamSaw: Array<{ method: string; url: string; authorization?: string; cookie?: string; body: string }> = [];

// Fake preview backend: echoes method/url/headers/body as JSON.
function startUpstream(): Promise<void> {
  return new Promise((resolve) => {
    upstreamSaw = [];
    upstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        upstreamSaw.push({
          method: req.method ?? '',
          url: req.url ?? '',
          authorization: req.headers.authorization,
          cookie: req.headers.cookie,
          body,
        });
        const isAsset = (req.url ?? '').endsWith('.js');
        res.writeHead(200, {
          'content-type': isAsset ? 'text/javascript' : 'application/json',
          'set-cookie': 'af_preview_x=abc; Path=/; HttpOnly; SameSite=Lax',
          connection: 'keep-alive',
        });
        res.end(isAsset ? '// asset' : JSON.stringify({ ok: true, url: req.url }));
      });
    });
    upstream.listen(0, '127.0.0.1', () => {
      upstreamPort = (upstream.address() as { port: number }).port;
      resolve();
    });
  });
}

function registerPreview(projectId: string, status = 'ready'): void {
  ensurePreviewsTable(db);
  db.prepare(`
    INSERT INTO previews(project_id, port, pid, status, db_path, tmp_dir, error, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id) DO UPDATE SET port=excluded.port, status=excluded.status, updated_at=excluded.updated_at
  `).run(projectId, upstreamPort, 12345, status, null, null, null, new Date().toISOString());
}

async function createDynamicProject(name: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/projects', payload: { name, type: 'dynamic' } });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-proxy-test-'));
  db = openDb(dataDir);
  app = buildServer({
    db,
    dataDir,
    templatesDir: TEMPLATES_DIR,
    liveRuntimeOrigin: () => `http://127.0.0.1:${upstreamPort}`,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('could not listen');
  baseUrl = `http://127.0.0.1:${addr.port}`;
  await startUpstream();
});

afterAll(async () => {
  await app.close();
  db.close();
  await new Promise<void>((r) => upstream.close(() => r()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('dynamic preview proxy /a/:projectId', () => {
  it('forwards GET with query and strips the prefix', async () => {
    const id = await createDynamicProject('Proxy A');
    registerPreview(id);
    const res = await fetch(`${baseUrl}/a/${id}/api/todos?page=2`);
    expect(res.status).toBe(200);
    const last = upstreamSaw[upstreamSaw.length - 1]!;
    expect(last.method).toBe('GET');
    expect(last.url).toBe('/api/todos?page=2');
  });

  it('falls back to a validated live runtime and reports it as ready', async () => {
    const id = await createDynamicProject('Live 7B');
    db.prepare(
      `INSERT INTO project_runtime(project_id, container_name, live_image, previous_image, status, updated_at)
       VALUES (?,?,?,?,?,?)`,
    ).run(
      id,
      `appforge-app-${id.slice(0, 8)}`,
      'appforge/app-1234abcd:dep-5678abcd-0123456789ab',
      null,
      'running',
      new Date().toISOString(),
    );
    const status = await fetch(`${baseUrl}/api/projects/${id}/preview`);
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ url: `/a/${id}/`, status: 'ready' });
    const res = await fetch(`${baseUrl}/a/${id}/api/live?q=1`, {
      headers: { authorization: 'Bearer MUST-NOT-LEAK' },
    });
    expect(res.status).toBe(200);
    const last = upstreamSaw[upstreamSaw.length - 1]!;
    expect(last.url).toBe('/api/live?q=1');
    expect(last.authorization).toBeUndefined();
  });

  it('rejects a runtime whose persisted container identity is not derived', async () => {
    const id = await createDynamicProject('Foreign live 7B');
    db.prepare(
      `INSERT INTO project_runtime(project_id, container_name, live_image, previous_image, status, updated_at)
       VALUES (?,?,?,?,?,?)`,
    ).run(
      id,
      'attacker-controlled-host',
      'appforge/app-1234abcd:dep-5678abcd-0123456789ab',
      null,
      'running',
      new Date().toISOString(),
    );
    const before = upstreamSaw.length;
    const res = await fetch(`${baseUrl}/a/${id}/`);
    expect(res.status).toBe(503);
    expect(upstreamSaw).toHaveLength(before);
  });

  it('forwards POST/PATCH/DELETE with the body preserved', async () => {
    const id = await createDynamicProject('Proxy B');
    registerPreview(id);
    for (const method of ['POST', 'PATCH', 'DELETE'] as const) {
      const res = await fetch(`${baseUrl}/a/${id}/api/todos/1`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'hello' }),
      });
      expect(res.status).toBe(200);
      const last = upstreamSaw[upstreamSaw.length - 1]!;
      expect(last.method).toBe(method);
      expect(last.url).toBe('/api/todos/1');
      expect(JSON.parse(last.body)).toEqual({ title: 'hello' });
    }
  });

  it('passes cookies through and returns Set-Cookie', async () => {
    const id = await createDynamicProject('Proxy C');
    registerPreview(id);
    const res = await fetch(`${baseUrl}/a/${id}/api/auth/me`, {
      headers: { cookie: 'af_preview_x=tok123' },
    });
    expect(res.status).toBe(200);
    const last = upstreamSaw[upstreamSaw.length - 1]!;
    expect(last.cookie).toBe('af_preview_x=tok123');
    expect(res.headers.get('set-cookie')).toContain('af_preview_x=abc');
  });

  it('never forwards the Studio Authorization header', async () => {
    const id = await createDynamicProject('Proxy D');
    registerPreview(id);
    await fetch(`${baseUrl}/a/${id}/`, {
      headers: { authorization: 'Bearer STUDIO-SECRET' },
    });
    const last = upstreamSaw[upstreamSaw.length - 1]!;
    expect(last.authorization).toBeUndefined();
  });

  it('serves assets with their content type', async () => {
    const id = await createDynamicProject('Proxy E');
    registerPreview(id);
    const res = await fetch(`${baseUrl}/a/${id}/assets/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
    expect(await res.text()).toBe('// asset');
  });

  it('rejects cross-project access (registry lookup is per project)', async () => {
    const idA = await createDynamicProject('Proxy F1');
    const idB = await createDynamicProject('Proxy F2');
    registerPreview(idA); // only A has a preview
    const res = await fetch(`${baseUrl}/a/${idB}/api/todos`);
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('Preview dinámico no disponible');
  });

  it('returns a diagnostic HTML page when no preview is registered', async () => {
    const id = await createDynamicProject('Proxy G');
    const res = await fetch(`${baseUrl}/a/${id}/`);
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).toContain('Preview dinámico no disponible');
    expect(html).toContain('start_fullstack_preview');
  });

  it('404s for unknown or non-dynamic projects (never an open proxy)', async () => {
    const res = await fetch(`${baseUrl}/a/does-not-exist/`);
    expect(res.status).toBe(404);
    // A static project must not be proxied either.
    const sres = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Static' } });
    const sid = (sres.json() as { id: string }).id;
    const res2 = await fetch(`${baseUrl}/a/${sid}/`);
    expect(res2.status).toBe(404);
  });

  it('escapes the project name in the diagnostic page (no XSS)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '<script>alert(1)</script>', type: 'dynamic' } });
    expect(res.statusCode).toBe(201);
    const id = (res.json() as { id: string }).id;
    const page = await fetch(`${baseUrl}/a/${id}/`);
    expect(page.status).toBe(503);
    const html = await page.text();
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('returns 503 and marks the preview failed when the backend crashes after going ready', async () => {
    const id = await createDynamicProject('Proxy Crash');
    // Dedicated upstream for this test so we can kill it mid-flight.
    const sockets = new Set<import('node:net').Socket>();
    const dedicated = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('alive');
    });
    dedicated.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    await new Promise<void>((r) => dedicated.listen(0, '127.0.0.1', r));
    const dport = (dedicated.address() as { port: number }).port;
    db.prepare(`
      INSERT INTO previews(project_id, port, pid, status, db_path, tmp_dir, error, updated_at)
      VALUES (?, ?, ?, 'ready', ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET port=excluded.port, status='ready', updated_at=excluded.updated_at
    `).run(id, dport, null, null, null, null, new Date().toISOString());

    // While alive: 200 through the proxy.
    const ok = await fetch(`${baseUrl}/a/${id}/`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('alive');

    // Kill the backend: the next request must be 503, not a retry against a
    // dead port, and the registry row must be marked failed.
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => dedicated.close(() => r()));
    const dead = await fetch(`${baseUrl}/a/${id}/`);
    expect(dead.status).toBe(503);
    const row = db.prepare('SELECT * FROM previews WHERE project_id=?').get(id) as { status: string; port: number | null; pid: number | null };
    expect(row.status).toBe('failed');
    expect(row.port).toBeNull();
    expect(row.pid).toBeNull();
    // And it stays 503 afterwards (the proxy no longer trusts the old row).
    const dead2 = await fetch(`${baseUrl}/a/${id}/`);
    expect(dead2.status).toBe(503);
  });

  it('rejects an upstream response with a declared Content-Length over the cap', async () => {
    const id = await createDynamicProject('Proxy Big CL');
    const big = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(20 * 1024 * 1024) });
      res.end('tiny');
    });
    await new Promise<void>((r) => big.listen(0, '127.0.0.1', r));
    const bport = (big.address() as { port: number }).port;
    db.prepare(`
      INSERT INTO previews(project_id, port, pid, status, db_path, tmp_dir, error, updated_at)
      VALUES (?, ?, ?, 'ready', ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET port=excluded.port, status='ready', updated_at=excluded.updated_at
    `).run(id, bport, null, null, null, null, new Date().toISOString());
    const res = await fetch(`${baseUrl}/a/${id}/`);
    expect(res.status).toBe(502);
    await new Promise<void>((r) => big.close(() => r()));
  });

  it('caps a streamed upstream body and preserves multiple Set-Cookie headers', async () => {
    const id = await createDynamicProject('Proxy Stream');
    const { gzipSync } = await import('node:zlib');
    const streamer = http.createServer((req, res) => {
      if ((req.url ?? '').startsWith('/huge')) {
        // Chunked, no content-length: 11 MiB streamed.
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        const chunk = Buffer.alloc(1024 * 1024, 'x');
        let n = 0;
        const iv = setInterval(() => {
          if (++n > 11 || res.destroyed) { clearInterval(iv); res.end(); return; }
          res.write(chunk);
        }, 5);
        return;
      }
      if ((req.url ?? '').startsWith('/cookies')) {
        res.setHeader('set-cookie', ['a=1; Path=/; HttpOnly', 'b=2; Path=/; HttpOnly']);
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('cookies');
        return;
      }
      // Gzipped body: fetch decompresses, so content-encoding must be stripped.
      const gz = gzipSync('plain-text-after-gunzip');
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip', 'content-length': String(gz.length) });
      res.end(gz);
    });
    await new Promise<void>((r) => streamer.listen(0, '127.0.0.1', r));
    const sport = (streamer.address() as { port: number }).port;
    db.prepare(`
      INSERT INTO previews(project_id, port, pid, status, db_path, tmp_dir, error, updated_at)
      VALUES (?, ?, ?, 'ready', ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET port=excluded.port, status='ready', updated_at=excluded.updated_at
    `).run(id, sport, null, null, null, null, new Date().toISOString());

    const huge = await fetch(`${baseUrl}/a/${id}/huge`);
    expect(huge.status).toBe(502);

    const ck = await fetch(`${baseUrl}/a/${id}/cookies`);
    expect(ck.status).toBe(200);
    const raw = ck.headers.getSetCookie();
    expect(raw.some((c) => c.startsWith('a=1'))).toBe(true);
    expect(raw.some((c) => c.startsWith('b=2'))).toBe(true);

    const gz = await fetch(`${baseUrl}/a/${id}/gz`);
    expect(gz.status).toBe(200);
    expect(await gz.text()).toBe('plain-text-after-gunzip');
    expect(gz.headers.get('content-encoding')).toBeNull();

    await new Promise<void>((r) => streamer.close(() => r()));
  });
});
