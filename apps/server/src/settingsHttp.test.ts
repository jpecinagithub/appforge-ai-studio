/**
 * Paquete 3: PATCH /api/settings must persist every field the Zod schema
 * accepts. Regression test for maxHardIterations / maxRepairAttempts,
 * which the handler's copy list used to omit — the PATCH answered 200
 * with the old defaults and silently dropped the new values.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { openDb } from './db.js';
import { buildServer } from './index.js';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.resolve(SRC_DIR, '..', '..', '..', 'templates');

let db: Database.Database;
let app: FastifyInstance;
let dataDir: string;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-settings-test-'));
  db = openDb(dataDir);
  app = buildServer({ db, dataDir, templatesDir: TEMPLATES_DIR });
  await app.listen({ port: 0, host: '127.0.0.1' });
});

afterAll(async () => {
  await app.close();
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('PATCH /api/settings', () => {
  it('exposes the Fase 1 defaults before any patch', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { maxHardIterations: number; maxRepairAttempts: number };
    expect(body.maxHardIterations).toBe(60);
    expect(body.maxRepairAttempts).toBe(12);
  });

  it('persists maxHardIterations and maxRepairAttempts (response and later GET)', async () => {
    const patched = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { maxHardIterations: 123, maxRepairAttempts: 7 },
    });
    expect(patched.statusCode).toBe(200);
    const patchedBody = patched.json() as { maxHardIterations: number; maxRepairAttempts: number };
    expect(patchedBody.maxHardIterations).toBe(123);
    expect(patchedBody.maxRepairAttempts).toBe(7);

    const after = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(after.statusCode).toBe(200);
    const afterBody = after.json() as { maxHardIterations: number; maxRepairAttempts: number };
    expect(afterBody.maxHardIterations).toBe(123);
    expect(afterBody.maxRepairAttempts).toBe(7);
  });

  it('patching another field leaves the loop limits untouched', async () => {
    const patched = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { temperature: 0.5 },
    });
    expect(patched.statusCode).toBe(200);
    const body = patched.json() as {
      temperature: number;
      maxHardIterations: number;
      maxRepairAttempts: number;
    };
    expect(body.temperature).toBe(0.5);
    expect(body.maxHardIterations).toBe(123);
    expect(body.maxRepairAttempts).toBe(7);
  });
});
