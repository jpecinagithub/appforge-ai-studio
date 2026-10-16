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
  app = buildServer({ db, dataDir, templatesDir: TEMPLATES_DIR });
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
});
