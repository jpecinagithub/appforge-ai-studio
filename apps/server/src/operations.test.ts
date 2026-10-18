import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from './db.js';
import {
  acquireProjectOperationLock,
  checkpointOperation,
  completeOperation,
  listOperations,
  listRunningOperations,
  OperationAuditError,
  reconcileInterruptedOperations,
  reconcileProjectOperationLocks,
  releaseProjectOperationLock,
  reserveOperation,
} from './operations.js';

let db: Database.Database;
let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-ops-'));
  db = openDb(dataDir);
});

describe('project operation lock', () => {
  it('serializes all mutating paths for one project and releases by owner', () => {
    expect(acquireProjectOperationLock(db, { projectId: 'p1', operationId: 'op1', operation: 'deploy' })).toBe(true);
    expect(acquireProjectOperationLock(db, { projectId: 'p1', operationId: 'op2', operation: 'database_backup' })).toBe(false);
    expect(releaseProjectOperationLock(db, 'op2')).toBe(false);
    expect(releaseProjectOperationLock(db, 'op1')).toBe(true);
    expect(acquireProjectOperationLock(db, { projectId: 'p1', operationId: 'op2', operation: 'database_backup' })).toBe(true);
  });

  it('reconciles stale locks after restart', () => {
    expect(acquireProjectOperationLock(db, { projectId: 'p1', operationId: 'op1', operation: 'deploy' })).toBe(true);
    expect(acquireProjectOperationLock(db, { projectId: 'p2', operationId: 'op2', operation: 'rollback' })).toBe(true);
    expect(reconcileProjectOperationLocks(db)).toBe(2);
    expect(reconcileProjectOperationLocks(db)).toBe(0);
  });
});

afterEach(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const base = {
  actor: 'admin',
  operation: 'database_backup' as const,
  projectId: 'project-1',
  idempotencyKey: 'backup:key-0001',
  payload: {},
};

describe('administrative operation idempotency', () => {
  it('persists a terminal result and replays it exactly', () => {
    const first = reserveOperation(db, base);
    expect(first.kind).toBe('started');
    if (first.kind !== 'started') return;
    const body = { backupId: 'bk_abc', createdAt: '2026-10-17T00:00:00.000Z', sizeBytes: 42 };
    completeOperation(db, first.record.id, 201, body);

    const replay = reserveOperation(db, { ...base, payload: {} });
    expect(replay).toMatchObject({ kind: 'replay', responseStatus: 201, response: body });
    expect(listOperations(db, base.projectId)).toHaveLength(1);
  });

  it('canonicalizes object key order but rejects key reuse with another request', () => {
    const first = reserveOperation(db, { ...base, payload: { b: 2, a: 1 } });
    expect(first.kind).toBe('started');
    if (first.kind !== 'started') return;
    completeOperation(db, first.record.id, 200, { ok: true });
    expect(reserveOperation(db, { ...base, payload: { a: 1, b: 2 } }).kind).toBe('replay');
    expect(reserveOperation(db, { ...base, payload: { a: 9, b: 2 } }).kind).toBe('conflict');
    expect(reserveOperation(db, { ...base, operation: 'rollback' }).kind).toBe('conflict');
  });

  it('returns in_progress for an identical concurrent request', () => {
    expect(reserveOperation(db, base).kind).toBe('started');
    expect(reserveOperation(db, base).kind).toBe('in_progress');
  });

  it('persists a bounded recovery checkpoint while the operation is running', () => {
    const first = reserveOperation(db, { ...base, operation: 'migrations' });
    if (first.kind !== 'started') throw new Error('expected started');
    const checkpoint = { phase: 'backup_ready', backupId: 'bk_restart_safe' };
    const updated = checkpointOperation(db, first.record.id, checkpoint);
    expect(updated.checkpoint).toEqual(checkpoint);
    expect(listRunningOperations(db)).toHaveLength(1);
    completeOperation(db, first.record.id, 503, { error: { code: 'INTERRUPTED' } });
    expect(() => checkpointOperation(db, first.record.id, checkpoint)).toThrow(/already terminal/);
  });

  it('fails closed on malformed keys and double completion', () => {
    expect(() => reserveOperation(db, { ...base, idempotencyKey: '../bad' })).toThrowError(OperationAuditError);
    const first = reserveOperation(db, base);
    if (first.kind !== 'started') throw new Error('expected started');
    completeOperation(db, first.record.id, 409, { error: { code: 'BUSY', message: 'busy' } });
    expect(() => completeOperation(db, first.record.id, 200, { ok: true })).toThrow(/already terminal/);
  });

  it('reconciles interrupted rows into an auditable terminal failure', () => {
    const first = reserveOperation(db, base);
    expect(first.kind).toBe('started');
    expect(reconcileInterruptedOperations(db)).toBe(1);
    const replay = reserveOperation(db, base);
    expect(replay).toMatchObject({
      kind: 'replay',
      responseStatus: 503,
      response: { error: { code: 'OPERATION_INTERRUPTED' } },
    });
    expect(reconcileInterruptedOperations(db)).toBe(0);
  });
});
