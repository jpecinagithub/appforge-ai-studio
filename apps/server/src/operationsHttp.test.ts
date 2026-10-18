import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { FakeDeploymentDriver, nowIso } from 'appforge-worker';
import { openDb } from './db.js';
import { buildServer } from './index.js';
import { acquireProjectOperationLock, releaseProjectOperationLock } from './operations.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.resolve(HERE, '..', '..', '..', 'templates');
const TOKEN = 'test-operation-admin-token';
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const LIVE_IMAGE = 'appforge/app-11111111:dep-abcdef12-123456789abc';

let db: Database.Database;
let dataDir: string;
let app: FastifyInstance;
let driver: FakeDeploymentDriver;

function auth(key?: string): Record<string, string> {
  return {
    authorization: `Bearer ${TOKEN}`,
    ...(key ? { 'idempotency-key': key } : {}),
  };
}

function seedProject(): void {
  const now = nowIso();
  db.prepare('INSERT INTO projects(id,name,type,status,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(
    PROJECT_ID, 'Managed app', 'dynamic', 'active', now, now,
  );
  db.prepare(
    `INSERT INTO project_runtime(project_id,container_name,live_image,previous_image,status,updated_at)
     VALUES (?,?,?,?,?,?)`,
  ).run(PROJECT_ID, 'appforge-live-11111111', LIVE_IMAGE, null, 'running', now);
}

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-ops-http-'));
  db = openDb(dataDir);
  seedProject();
  driver = new FakeDeploymentDriver({ db, backupId: 'bk_manual_http' });
  app = buildServer({
    db,
    dataDir,
    templatesDir: TEMPLATES_DIR,
    adminToken: TOKEN,
    deploymentDriver: driver,
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('POST database backup — 7C.2', () => {
  it('requires administrative authentication and an idempotency key', async () => {
    const unauthenticated = await app.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT_ID}/database/backup`,
      headers: { 'idempotency-key': 'backup-key-0001' },
    });
    expect(unauthenticated.statusCode).toBe(401);

    const missingKey = await app.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT_ID}/database/backup`,
      headers: auth(),
    });
    expect(missingKey.statusCode).toBe(400);
    expect(missingKey.json().error.code).toBe('INVALID_IDEMPOTENCY_KEY');
    expect(driver.callsOf('createLiveBackup')).toHaveLength(0);
  });

  it('returns only opaque validated metadata and replays without a second backup', async () => {
    const headers = auth('backup-key-0002');
    const first = await app.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT_ID}/database/backup`,
      headers,
    });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ backupId: 'bk_manual_http', sizeBytes: 0, hadDatabase: false });
    expect(first.body).not.toContain(dataDir);
    expect(first.body).not.toContain('project-backups');
    expect(driver.callsOf('createLiveBackup')).toHaveLength(1);
    expect(driver.callsOf('resumeCurrentLiveRuntime')).toHaveLength(1);

    const replay = await app.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT_ID}/database/backup`,
      headers,
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json()).toEqual(first.json());
    expect(driver.callsOf('createLiveBackup')).toHaveLength(1);
    expect(driver.callsOf('resumeCurrentLiveRuntime')).toHaveLength(1);

    const history = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/operations`,
      headers: auth(),
    });
    expect(history.statusCode).toBe(200);
    expect(history.json().items).toHaveLength(1);
    expect(history.json().items[0]).toMatchObject({
      operation: 'database_backup',
      status: 'succeeded',
      responseStatus: 201,
    });
    expect(history.body).not.toContain('backup-key-0002');
  });

  it('serializes against every other project mutation and audits the rejection', async () => {
    expect(acquireProjectOperationLock(db, {
      projectId: PROJECT_ID,
      operationId: 'other-operation',
      operation: 'deploy',
    })).toBe(true);
    try {
      const blocked = await app.inject({
        method: 'POST',
        url: `/api/projects/${PROJECT_ID}/database/backup`,
        headers: auth('backup-key-0003'),
      });
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json().error.code).toBe('PROJECT_OPERATION_ACTIVE');
      expect(driver.callsOf('createLiveBackup')).toHaveLength(0);
    } finally {
      releaseProjectOperationLock(db, 'other-operation');
    }
    const row = db.prepare('SELECT status,response_status FROM operation_audit WHERE idempotency_key=?').get(
      'backup-key-0003',
    ) as { status: string; response_status: number };
    expect(row).toEqual({ status: 'failed', response_status: 409 });
  });

  it('fails closed when backup evidence is incomplete', async () => {
    await app.close();
    driver = new FakeDeploymentDriver({ db, omitBackupId: true });
    app = buildServer({
      db,
      dataDir,
      templatesDir: TEMPLATES_DIR,
      adminToken: TOKEN,
      deploymentDriver: driver,
    });
    await app.ready();
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT_ID}/database/backup`,
      headers: auth('backup-key-0004'),
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe('BACKUP_INVALID_RESULT');
    expect(driver.callsOf('resumeCurrentLiveRuntime')).toHaveLength(0);
  });

  it('does not report success unless the stopped live runtime recovers healthy', async () => {
    await app.close();
    driver = new FakeDeploymentDriver({
      db,
      backupId: 'bk_recovery_failure',
      behavior: { resumeCurrentLiveRuntime: 'fail' },
      failError: { resumeCurrentLiveRuntime: `cannot start ${dataDir} password=secret-value` },
    });
    app = buildServer({
      db,
      dataDir,
      templatesDir: TEMPLATES_DIR,
      adminToken: TOKEN,
      deploymentDriver: driver,
    });
    await app.ready();
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT_ID}/database/backup`,
      headers: auth('backup-key-0005'),
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe('BACKUP_LIVE_RECOVERY_FAILED');
    expect(response.body).toContain('backupId=bk_recovery_failure');
    expect(response.body).not.toContain(dataDir);
    expect(response.body).not.toContain('secret-value');
  });
});
