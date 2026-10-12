/**
 * Server API tests: 409 RUN_ACTIVE, INVALID_PATH on file APIs, SSE replay,
 * and restart reconciliation (Test E).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { openDb } from './db.js';
import { buildServer, reconcileInterruptedRuns } from './index.js';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.resolve(SRC_DIR, '..', '..', '..', 'templates');

let db: Database.Database;
let app: FastifyInstance;
let dataDir: string;
let baseUrl: string;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-server-test-'));
  db = openDb(dataDir);
  app = buildServer({ db, dataDir, templatesDir: TEMPLATES_DIR });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('could not listen');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await app.close();
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function createProject(name = 'Test App') {
  const res = await app.inject({ method: 'POST', url: '/api/projects', payload: { name } });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string };
}

describe('health', () => {
  it('responds ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, version: '0.1.0' });
  });
});

describe('runs: single active run per project', () => {
  it('returns 409 RUN_ACTIVE when a run is already active', async () => {
    const p = await createProject('Run conflict app');
    const r1 = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/runs`, payload: { prompt: 'do something' } });
    expect(r1.statusCode).toBe(201);
    expect(r1.json().status).toBe('queued');
    const r2 = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/runs`, payload: { prompt: 'do another thing' } });
    expect(r2.statusCode).toBe(409);
    expect(r2.json().error.code).toBe('RUN_ACTIVE');
  });

  it('allows a new run after the previous one is cancelled', async () => {
    const p = await createProject('Run cancel app');
    const r1 = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/runs`, payload: { prompt: 'x' } });
    const runId = (r1.json() as { id: string }).id;
    const c = await app.inject({ method: 'POST', url: `/api/runs/${runId}/cancel` });
    expect(c.statusCode).toBe(200);
    expect(c.json()).toEqual({ ok: true });
    const r2 = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/runs`, payload: { prompt: 'y' } });
    expect(r2.statusCode).toBe(201);
  });
});

describe('files: INVALID_PATH', () => {
  it('rejects traversal on PUT', async () => {
    const p = await createProject('Traversal app');
    const res = await app.inject({
      method: 'PUT',
      url: `/api/projects/${p.id}/files/content`,
      payload: { path: '../evil.txt', content: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_PATH');
  });

  it('rejects absolute paths on GET', async () => {
    const p = await createProject('Traversal app 2');
    const res = await app.inject({ method: 'GET', url: `/api/projects/${p.id}/files/content?path=/etc/passwd` });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_PATH');
  });

  it('round-trips a valid file', async () => {
    const p = await createProject('Files app');
    const put = await app.inject({
      method: 'PUT',
      url: `/api/projects/${p.id}/files/content`,
      payload: { path: 'src/note.txt', content: 'hello world' },
    });
    expect(put.statusCode).toBe(200);
    const get = await app.inject({ method: 'GET', url: `/api/projects/${p.id}/files/content?path=src/note.txt` });
    expect(get.statusCode).toBe(200);
    expect(get.json().content).toBe('hello world');
  });
});

describe('SSE events', () => {
  it('replays stored events in order and closes on done', async () => {
    const p = await createProject('SSE app');
    const runId = 'sse-run-1';
    db.prepare('INSERT INTO runs(id, project_id, prompt, status, created_at) VALUES (?,?,?,?,?)').run(runId, p.id, 'hi', 'running', new Date().toISOString());
    const ins = db.prepare('INSERT INTO run_events(run_id, seq, kind, payload_json, created_at) VALUES (?,?,?,?,?)');
    const now = new Date().toISOString();
    ins.run(runId, 1, 'status', JSON.stringify({ phase: 'started' }), now);
    ins.run(runId, 2, 'log', JSON.stringify({ text: 'hello' }), now);
    ins.run(runId, 3, 'done', JSON.stringify({ summary: 'finished' }), now);

    const res = await fetch(`${baseUrl}/api/runs/${runId}/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const body = await res.text();
    expect(body).toContain('event: status');
    expect(body).toContain('event: log');
    expect(body).toContain('event: done');
    expect(body).toContain('id: 1');
    expect(body).toContain('id: 3');
    // order check
    expect(body.indexOf('event: status')).toBeLessThan(body.indexOf('event: log'));
    expect(body.indexOf('event: log')).toBeLessThan(body.indexOf('event: done'));
  });

  it('404s on unknown run', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/runs/nope/events' });
    expect(res.statusCode).toBe(404);
  });
});

describe('restart reconciliation (Test E)', () => {
  it('marks queued/running runs as error/interrupted', () => {
    const before = (db.prepare("SELECT COUNT(*) AS c FROM runs WHERE status IN ('queued','running')").get() as { c: number }).c;
    const now = new Date().toISOString();
    db.prepare('INSERT INTO runs(id, project_id, prompt, status, created_at) VALUES (?,?,?,?,?)').run('rec-1', 'p-x', 'a', 'queued', now);
    db.prepare('INSERT INTO runs(id, project_id, prompt, status, created_at) VALUES (?,?,?,?,?)').run('rec-2', 'p-x', 'b', 'running', now);
    db.prepare('INSERT INTO runs(id, project_id, prompt, status, created_at) VALUES (?,?,?,?,?)').run('rec-3', 'p-x', 'c', 'done', now);
    const n = reconcileInterruptedRuns(db);
    expect(n - before).toBe(2);
    const s1 = (db.prepare('SELECT status, error FROM runs WHERE id=?').get('rec-1') as { status: string; error: string });
    expect(s1.status).toBe('error');
    expect(s1.error).toContain('interrupted by restart');
    const s3 = (db.prepare('SELECT status FROM runs WHERE id=?').get('rec-3') as { status: string });
    expect(s3.status).toBe('done');
  });
});

describe('deploy (Phase 1)', () => {
  it('returns 501 PHASE_3', async () => {
    const p = await createProject('Deploy app');
    const res = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/deploy` });
    expect(res.statusCode).toBe(501);
    expect(res.json().error.code).toBe('PHASE_3');
  });
});
