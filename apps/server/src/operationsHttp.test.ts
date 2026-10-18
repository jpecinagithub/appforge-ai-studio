import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { FakeDeploymentDriver, nowIso } from 'appforge-worker';
import { openDb } from './db.js';
import { buildServer, recoverInterruptedAdministrativeOperations } from './index.js';
import {
  acquireProjectOperationLock,
  checkpointOperation,
  releaseProjectOperationLock,
  reserveOperation,
} from './operations.js';

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

function seedMigrationFiles(): void {
  const dir = path.join(dataDir, 'projects', PROJECT_ID, 'migrations');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '001_init.sql'), 'CREATE TABLE users(id TEXT PRIMARY KEY);\n');
  fs.writeFileSync(path.join(dir, '002_todos.sql'), 'CREATE TABLE todos(id TEXT PRIMARY KEY);\n');
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

describe('GET migrations — 7C.2', () => {
  it('returns the persisted migration history in descending version order', async () => {
    const now = nowIso();
    db.prepare(
      `INSERT INTO migrations(id,project_id,version,name,status,started_at,finished_at,duration_ms,logs,error)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run('mig-001', PROJECT_ID, 1, '001_init.sql', 'success', now, now, 12, 'applied', null);
    db.prepare(
      `INSERT INTO migrations(id,project_id,version,name,status,started_at,finished_at,duration_ms,logs,error)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run('mig-002', PROJECT_ID, 2, '002_add_todos.sql', 'failed', now, now, 8, '', 'constraint');

    const response = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/migrations`,
      headers: auth(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().items).toEqual([
      expect.objectContaining({ id: 'mig-002', version: 2, status: 'failed', error: 'constraint' }),
      expect.objectContaining({ id: 'mig-001', version: 1, status: 'success', logs: 'applied' }),
    ]);
  });
});

describe('restart recovery — 7C.2', () => {
  it('restores the checkpointed backup before closing an interrupted migration', async () => {
    const reserved = reserveOperation(db, {
      actor: 'admin',
      idempotencyKey: 'restart-migration-0001',
      operation: 'migrations',
      projectId: PROJECT_ID,
      payload: {},
    });
    if (reserved.kind !== 'started') throw new Error('expected started');
    checkpointOperation(db, reserved.record.id, { phase: 'backup_ready', backupId: 'bk_restart_migration' });

    expect(await recoverInterruptedAdministrativeOperations(db, driver, dataDir)).toBe(1);
    expect(driver.callsOf('recoverCurrentLiveBackup')).toHaveLength(1);
    expect(driver.callsOf('resumeCurrentLiveRuntime')).toHaveLength(0);
    const replay = reserveOperation(db, {
      actor: 'admin', idempotencyKey: 'restart-migration-0001', operation: 'migrations', projectId: PROJECT_ID, payload: {},
    });
    expect(replay).toMatchObject({ kind: 'replay', responseStatus: 503 });
  });

  it('health-checks/resumes an interrupted backup that has no restore checkpoint', async () => {
    reserveOperation(db, {
      actor: 'admin',
      idempotencyKey: 'restart-backup-0001',
      operation: 'database_backup',
      projectId: PROJECT_ID,
      payload: {},
    });

    expect(await recoverInterruptedAdministrativeOperations(db, driver, dataDir)).toBe(1);
    expect(driver.callsOf('resumeCurrentLiveRuntime')).toHaveLength(1);
    expect(driver.callsOf('recoverCurrentLiveBackup')).toHaveLength(0);
  });
});

describe('POST migrations — 7C.2', () => {
  it('backs up, migrates, resumes healthy and replays without a second mutation', async () => {
    seedMigrationFiles();
    await app.close();
    driver = new FakeDeploymentDriver({
      db,
      backupId: 'bk_migration_success',
      backupSizeBytes: 4096,
      backupHadDatabase: true,
    });
    app = buildServer({ db, dataDir, templatesDir: TEMPLATES_DIR, adminToken: TOKEN, deploymentDriver: driver });
    await app.ready();
    const headers = auth('migration-key-0001');
    const first = await app.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT_ID}/migrations`,
      headers,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().items).toHaveLength(2);
    expect(first.json().items.map((item: { status: string }) => item.status)).toEqual(['success', 'success']);
    expect(driver.callsOf('createLiveBackup')).toHaveLength(1);
    expect(driver.callsOf('runCurrentLiveMigrations')).toHaveLength(1);
    expect(driver.callsOf('resumeCurrentLiveRuntime')).toHaveLength(1);
    expect(driver.callsOf('recoverCurrentLiveBackup')).toHaveLength(0);

    const replay = await app.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT_ID}/migrations`,
      headers,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json()).toEqual(first.json());
    expect(driver.callsOf('runCurrentLiveMigrations')).toHaveLength(1);
  });

  it('physically restores the validated backup when a migration fails', async () => {
    seedMigrationFiles();
    await app.close();
    driver = new FakeDeploymentDriver({
      db,
      backupId: 'bk_migration_failure',
      backupSizeBytes: 4096,
      backupHadDatabase: true,
      behavior: { runCurrentLiveMigrations: 'fail' },
      failError: { runCurrentLiveMigrations: `migration failed at ${dataDir} password=secret-value` },
    });
    app = buildServer({ db, dataDir, templatesDir: TEMPLATES_DIR, adminToken: TOKEN, deploymentDriver: driver });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT_ID}/migrations`,
      headers: auth('migration-key-0002'),
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe('MIGRATION_FAILED');
    expect(driver.callsOf('recoverCurrentLiveBackup')).toHaveLength(1);
    const rows = db.prepare('SELECT status,error FROM migrations WHERE project_id=?').all(PROJECT_ID) as Array<{ status: string; error: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === 'failed')).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(dataDir);
    expect(JSON.stringify(rows)).not.toContain('secret-value');
  });

  it('restores the backup if post-migration health recovery fails', async () => {
    seedMigrationFiles();
    await app.close();
    driver = new FakeDeploymentDriver({
      db,
      backupId: 'bk_health_failure',
      backupSizeBytes: 4096,
      backupHadDatabase: true,
      behavior: { resumeCurrentLiveRuntime: 'fail' },
    });
    app = buildServer({ db, dataDir, templatesDir: TEMPLATES_DIR, adminToken: TOKEN, deploymentDriver: driver });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT_ID}/migrations`,
      headers: auth('migration-key-0003'),
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe('MIGRATION_LIVE_RECOVERY_FAILED');
    expect(driver.callsOf('recoverCurrentLiveBackup')).toHaveLength(1);
  });

  it('fails closed when both migration and physical restore fail', async () => {
    seedMigrationFiles();
    await app.close();
    driver = new FakeDeploymentDriver({
      db,
      backupId: 'bk_double_failure',
      backupSizeBytes: 4096,
      backupHadDatabase: true,
      behavior: { runCurrentLiveMigrations: 'fail', recoverCurrentLiveBackup: 'fail' },
      failError: { recoverCurrentLiveBackup: `restore failed ${dataDir} token=private-value` },
    });
    app = buildServer({ db, dataDir, templatesDir: TEMPLATES_DIR, adminToken: TOKEN, deploymentDriver: driver });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT_ID}/migrations`,
      headers: auth('migration-key-0004'),
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe('MIGRATION_RECOVERY_FAILED');
    expect(response.body).not.toContain(dataDir);
    expect(response.body).not.toContain('private-value');
  });
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
    expect(driver.callsOf('resumeCurrentLiveRuntime')).toHaveLength(1);
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
