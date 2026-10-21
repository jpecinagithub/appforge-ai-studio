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
import {
  assertProductionConfiguration,
  buildServer,
  createBackgroundTaskTracker,
  parseShutdownTimeout,
  reconcileInterruptedBuilds,
  reconcileInterruptedMigrations,
  reconcileInterruptedRuns,
} from './index.js';

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
    const publicHealth = await app.inject({ method: 'GET', url: '/healthz' });
    expect(publicHealth.statusCode).toBe(200);
    expect(publicHealth.json()).toEqual({ ok: true, version: '0.1.0' });
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, version: '0.1.0' });
  });
});

describe('project type and backend requirements', () => {
  it('scaffolds a backend when Automatic creation receives a full-stack prompt', async () => {
    const created = await app.inject({method:'POST',url:'/api/projects',payload:{name:'PC Computers',prompt:'Tienda full-stack con backend Node.js y SQLite'}});
    expect(created.statusCode).toBe(201);
    const project=created.json();expect(project.type).toBe('dynamic');
    expect(fs.existsSync(path.join(dataDir,'projects',project.id,'backend','src','server.ts'))).toBe(true);
  });
  it('rejects full-stack generation on an explicitly static project before consuming tokens', async () => {
    const project=await createProject('Explicit static');
    const response=await app.inject({method:'POST',url:`/api/projects/${project.id}/runs`,payload:{prompt:'Crear tienda full-stack con SQLite',language:'es'}});
    expect(response.statusCode).toBe(409);expect(response.json().error.code).toBe('PROJECT_TYPE_MISMATCH');
    expect(db.prepare('SELECT COUNT(*) n FROM runs WHERE project_id=?').get(project.id)).toEqual({n:0});
  });
});

describe('production configuration', () => {
  it('requires a strong admin token and absolute data directory', () => {
    expect(() => assertProductionConfiguration({ APPFORGE_PRODUCTION: '1' }, '/data/appforge')).toThrow(
      /APPFORGE_ADMIN_TOKEN/,
    );
    expect(() => assertProductionConfiguration({
      APPFORGE_PRODUCTION: '1',
      APPFORGE_ADMIN_TOKEN: 'x'.repeat(32),
    }, 'relative/data')).toThrow(/DATA_DIR/);
  });

  it('rejects the fake LLM and accepts a safe production configuration', () => {
    expect(() => assertProductionConfiguration({
      APPFORGE_PRODUCTION: '1',
      APPFORGE_ADMIN_TOKEN: 'x'.repeat(32),
      APPFORGE_LLM_STUB: '1',
    }, '/data/appforge')).toThrow(/LLM_STUB/);
    expect(() => assertProductionConfiguration({
      APPFORGE_PRODUCTION: '1',
      APPFORGE_ADMIN_TOKEN: 'x'.repeat(32),
    }, '/data/appforge')).not.toThrow();
  });

  it('validates the bounded graceful-shutdown budget', () => {
    expect(parseShutdownTimeout(undefined)).toBe(30_000);
    expect(parseShutdownTimeout('45000')).toBe(45_000);
    expect(() => parseShutdownTimeout('999')).toThrow(/SHUTDOWN_TIMEOUT/);
    expect(() => parseShutdownTimeout('300001')).toThrow(/SHUTDOWN_TIMEOUT/);
    expect(() => parseShutdownTimeout('1.5')).toThrow(/SHUTDOWN_TIMEOUT/);
  });
});

describe('background task shutdown drain', () => {
  it('tracks completion and drains within the budget', async () => {
    const tracker = createBackgroundTaskTracker();
    let release!: () => void;
    const task = new Promise<void>((resolve) => { release = resolve; });
    const tracked = tracker.track(task);
    expect(tracker.size()).toBe(1);
    setTimeout(release, 5);
    await expect(tracker.drain(500)).resolves.toBe(true);
    await tracked;
    expect(tracker.size()).toBe(0);
  });

  it('reports budget exhaustion without cancelling the task', async () => {
    const tracker = createBackgroundTaskTracker();
    let release!: () => void;
    const tracked = tracker.track(new Promise<void>((resolve) => { release = resolve; }));
    await expect(tracker.drain(5)).resolves.toBe(false);
    expect(tracker.size()).toBe(1);
    release();
    await tracked;
  });
});

describe('project scaffold', () => {
  it('creates a minimal React project with plain CSS and no Tailwind dependency', async () => {
    const project = await createProject('Plain CSS app');
    const frontend = path.join(dataDir, 'projects', project.id, 'frontend');
    const manifest = JSON.parse(fs.readFileSync(path.join(frontend, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const allDependencies = { ...manifest.dependencies, ...manifest.devDependencies };

    expect(allDependencies).not.toHaveProperty('tailwindcss');
    expect(allDependencies).not.toHaveProperty('@tailwindcss/vite');
    expect(fs.readFileSync(path.join(frontend, 'vite.config.ts'), 'utf8')).not.toContain('tailwind');
    expect(fs.readFileSync(path.join(frontend, 'src', 'index.css'), 'utf8')).not.toContain('@import "tailwindcss"');
    expect(fs.readFileSync(path.join(dataDir, 'projects', project.id, 'PROJECT_CONTEXT.md'), 'utf8')).toContain('plain CSS');
  });
});

describe('authentication boundary', () => {
  it('keeps the API private while generated web apps remain public', async () => {
    const secured = buildServer({ db, dataDir, templatesDir: TEMPLATES_DIR, adminToken: 'test-admin-token' });
    try {
      const unauthorized = await secured.inject({ method: 'GET', url: '/api/health' });
      expect(unauthorized.statusCode).toBe(401);

      const created = await secured.inject({
        method: 'POST',
        url: '/api/projects',
        headers: { authorization: 'Bearer test-admin-token' },
        payload: { name: 'Public Oracle app' },
      });
      expect(created.statusCode).toBe(201);
      const projectId = (created.json() as { id: string }).id;
      const distDir = path.join(dataDir, 'projects', projectId, 'frontend', 'dist');
      fs.mkdirSync(distDir, { recursive: true });
      fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><h1>Public app</h1>');
      fs.mkdirSync(path.join(distDir, '__appforge'), { recursive: true });
      fs.writeFileSync(path.join(distDir, '__appforge', 'thumbnail.webp'), Buffer.from([0x52, 0x49, 0x46, 0x46]));

      const preview = await secured.inject({ method: 'GET', url: `/p/${projectId}/` });
      expect(preview.statusCode).toBe(200);
      expect(preview.body).toContain('Public app');
      const thumbnail = await secured.inject({ method: 'GET', url: `/p/${projectId}/__appforge/thumbnail.webp` });
      expect(thumbnail.statusCode).toBe(200);
      expect(thumbnail.headers['content-type']).toBe('image/webp');
    } finally {
      await secured.close();
    }
  });
});

describe('runs: single active run per project', () => {
  it('turns an unsupported request into a zero-token compatibility response', async () => {
    const p = await createProject('Compatibility app');
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${p.id}/runs`,
      payload: { prompt: 'Crea el proyecto con Next.js, Tailwind y PostgreSQL', language: 'es' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      status: 'done',
      error: null,
      stats: { iterations: 0, llmCalls: 0, tokensIn: 0, tokensOut: 0, toolCalls: 0, errors: 0 },
    });

    const messages = await app.inject({ method: 'GET', url: `/api/projects/${p.id}/messages` });
    expect(messages.statusCode).toBe(200);
    expect(messages.json().items).toHaveLength(2);
    expect(messages.json().items[0]).toMatchObject({ role: 'user' });
    expect(messages.json().items[1]).toMatchObject({ role: 'assistant', tokens: 0 });
    expect(messages.json().items[1].content).toContain('Tecnologías permitidas actualmente:');
    expect(messages.json().items[1].content).toContain('- Next.js');
    expect(messages.json().items[1].content).toContain('- Tailwind CSS');

    const runs = await app.inject({ method: 'GET', url: `/api/projects/${p.id}/runs` });
    expect(runs.json().items).toHaveLength(1);
    expect(runs.json().items[0].status).toBe('done');
  });

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

  it('marks pending/running builds as failed and preserves finished builds', () => {
    const project = db.prepare('SELECT id FROM projects LIMIT 1').get() as { id: string };
    const now = new Date().toISOString();
    const insert = db.prepare('INSERT INTO builds(id, project_id, status, started_at, logs) VALUES (?,?,?,?,?)');
    insert.run('build-rec-1', project.id, 'pending', now, 'queued');
    insert.run('build-rec-2', project.id, 'running', now, 'building');
    insert.run('build-rec-3', project.id, 'success', now, 'done');

    expect(reconcileInterruptedBuilds(db)).toBe(2);
    const interrupted = db.prepare('SELECT status, finished_at, error, logs FROM builds WHERE id=?').get('build-rec-2') as {
      status: string;
      finished_at: string | null;
      error: string | null;
      logs: string;
    };
    expect(interrupted.status).toBe('failed');
    expect(interrupted.finished_at).not.toBeNull();
    expect(interrupted.error).toContain('interrupted by server restart');
    expect(interrupted.logs).toContain('Source files were preserved');
    expect((db.prepare('SELECT status FROM builds WHERE id=?').get('build-rec-3') as { status: string }).status).toBe('success');
  });

  it('marks pending/running migrations as failed and preserves finished ones (§9.14)', () => {
    const now = new Date().toISOString();
    const insert = db.prepare(
      'INSERT INTO migrations(id, project_id, version, name, status, started_at) VALUES (?,?,?,?,?,?)',
    );
    insert.run('mig-rec-1', 'p-x', 1, '001_init.sql', 'pending', now);
    insert.run('mig-rec-2', 'p-x', 2, '002_add.sql', 'running', now);
    insert.run('mig-rec-3', 'p-x', 1, '001_init.sql', 'success', now);

    expect(reconcileInterruptedMigrations(db)).toBe(2);
    const interrupted = db.prepare('SELECT status, finished_at, error FROM migrations WHERE id=?').get('mig-rec-2') as {
      status: string;
      finished_at: string | null;
      error: string | null;
    };
    expect(interrupted.status).toBe('failed');
    expect(interrupted.finished_at).not.toBeNull();
    expect(interrupted.error).toContain('interrupted by server restart');
    expect((db.prepare('SELECT status FROM migrations WHERE id=?').get('mig-rec-3') as { status: string }).status).toBe('success');
  });
});

describe('deploy (Fase 6)', () => {
  it('rejects static projects with 400 INVALID_TYPE', async () => {
    const p = await createProject('Deploy app');
    const res = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/deploy`, payload: { target: 'oracle' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_TYPE');
  });

  it('returns 501 DEPLOYMENT_DRIVER_NOT_CONFIGURED without a driver', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Dyn', type: 'dynamic' } });
    expect(res.statusCode).toBe(201);
    const p = res.json() as { id: string };
    const dep = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/deploy`, payload: { target: 'oracle' } });
    expect(dep.statusCode).toBe(501);
    expect(dep.json().error.code).toBe('DEPLOYMENT_DRIVER_NOT_CONFIGURED');
  });
});
