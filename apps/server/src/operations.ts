/**
 * 7C.2 — Persistent idempotency and administrative-operation audit.
 *
 * This module performs no Docker work. It atomically reserves a user supplied
 * idempotency key before a mutation and persists its exact safe API result.
 */
import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export type AdministrativeOperation =
  | 'database_backup'
  | 'migrations'
  | 'rollback'
  | 'deploy'
  | 'deployment_cancel';
export type AuditStatus = 'running' | 'succeeded' | 'failed';

export interface OperationAuditRecord {
  id: string;
  idempotencyKey: string;
  actor: string;
  operation: AdministrativeOperation;
  projectId: string;
  requestHash: string;
  status: AuditStatus;
  responseStatus: number | null;
  response: unknown | null;
  checkpoint: unknown | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export type OperationReservation =
  | { kind: 'started'; record: OperationAuditRecord }
  | { kind: 'replay'; record: OperationAuditRecord; responseStatus: number; response: unknown }
  | { kind: 'in_progress'; record: OperationAuditRecord }
  | { kind: 'conflict'; record: OperationAuditRecord };

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const ACTOR_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const MAX_RESPONSE_BYTES = 64 * 1024;

export class OperationAuditError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'OperationAuditError';
    this.code = code;
  }
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new OperationAuditError('INVALID_PAYLOAD', 'payload contains a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new OperationAuditError('INVALID_PAYLOAD', 'payload must contain only JSON values');
    }
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  throw new OperationAuditError('INVALID_PAYLOAD', 'payload must contain only JSON values');
}

export function operationRequestHash(input: {
  operation: AdministrativeOperation;
  projectId: string;
  payload: unknown;
}): string {
  return createHash('sha256').update(canonicalJson(input)).digest('hex');
}

function parseResponse(raw: string | null): unknown | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new OperationAuditError('CORRUPT_AUDIT', 'stored operation response is not valid JSON');
  }
}

function rowToRecord(row: Record<string, unknown>): OperationAuditRecord {
  return {
    id: String(row.id),
    idempotencyKey: String(row.idempotency_key),
    actor: String(row.actor),
    operation: String(row.operation) as AdministrativeOperation,
    projectId: String(row.project_id),
    requestHash: String(row.request_hash),
    status: String(row.status) as AuditStatus,
    responseStatus: row.response_status === null ? null : Number(row.response_status),
    response: parseResponse(row.response_json === null ? null : String(row.response_json)),
    checkpoint: parseResponse(row.checkpoint_json === null ? null : String(row.checkpoint_json)),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    finishedAt: row.finished_at === null ? null : String(row.finished_at),
  };
}

export function checkpointOperation(
  db: Database.Database,
  id: string,
  checkpoint: unknown,
): OperationAuditRecord {
  const checkpointJson = canonicalJson(checkpoint);
  if (Buffer.byteLength(checkpointJson, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new OperationAuditError('CHECKPOINT_TOO_LARGE', 'operation checkpoint exceeds 64 KiB');
  }
  const now = new Date().toISOString();
  const changed = db.prepare(
    `UPDATE operation_audit SET checkpoint_json=?,updated_at=? WHERE id=? AND status='running'`,
  ).run(checkpointJson, now, id);
  if (changed.changes !== 1) {
    throw new OperationAuditError('INVALID_OPERATION_STATE', 'operation is missing or already terminal');
  }
  const row = db.prepare('SELECT * FROM operation_audit WHERE id=?').get(id) as Record<string, unknown>;
  return rowToRecord(row);
}

export function listRunningOperations(db: Database.Database): OperationAuditRecord[] {
  const rows = db
    .prepare("SELECT * FROM operation_audit WHERE status='running' ORDER BY created_at,id")
    .all() as Array<Record<string, unknown>>;
  return rows.map(rowToRecord);
}

export function reserveOperation(
  db: Database.Database,
  input: {
    idempotencyKey: string;
    actor: string;
    operation: AdministrativeOperation;
    projectId: string;
    payload: unknown;
  },
): OperationReservation {
  if (!IDEMPOTENCY_KEY_RE.test(input.idempotencyKey)) {
    throw new OperationAuditError('INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be 8-128 safe characters');
  }
  if (!ACTOR_RE.test(input.actor)) throw new OperationAuditError('INVALID_ACTOR', 'invalid administrative actor');
  if (!input.projectId || input.projectId.length > 128) throw new OperationAuditError('INVALID_PROJECT', 'invalid project id');

  const requestHash = operationRequestHash(input);
  const reserve = db.transaction((): OperationReservation => {
    const existing = db
      .prepare('SELECT * FROM operation_audit WHERE actor=? AND idempotency_key=?')
      .get(input.actor, input.idempotencyKey) as Record<string, unknown> | undefined;
    if (existing) {
      const record = rowToRecord(existing);
      if (record.requestHash !== requestHash) return { kind: 'conflict', record };
      if (record.status === 'running') return { kind: 'in_progress', record };
      if (record.responseStatus === null || record.response === null) {
        throw new OperationAuditError('CORRUPT_AUDIT', 'terminal operation has no persisted response');
      }
      return {
        kind: 'replay',
        record,
        responseStatus: record.responseStatus,
        response: record.response,
      };
    }

    const now = new Date().toISOString();
    const id = randomUUID();
    db.prepare(
      `INSERT INTO operation_audit(
         id, idempotency_key, actor, operation, project_id, request_hash,
         status, response_status, response_json, created_at, updated_at, finished_at)
       VALUES (?,?,?,?,?,?,'running',NULL,NULL,?,?,NULL)`,
    ).run(id, input.idempotencyKey, input.actor, input.operation, input.projectId, requestHash, now, now);
    const row = db.prepare('SELECT * FROM operation_audit WHERE id=?').get(id) as Record<string, unknown>;
    return { kind: 'started', record: rowToRecord(row) };
  });
  return reserve.immediate();
}

export function completeOperation(
  db: Database.Database,
  id: string,
  responseStatus: number,
  response: unknown,
): OperationAuditRecord {
  if (!Number.isInteger(responseStatus) || responseStatus < 100 || responseStatus > 599) {
    throw new OperationAuditError('INVALID_RESPONSE_STATUS', 'response status must be an HTTP status');
  }
  const responseJson = canonicalJson(response);
  if (Buffer.byteLength(responseJson, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new OperationAuditError('RESPONSE_TOO_LARGE', 'audited operation response exceeds 64 KiB');
  }
  const now = new Date().toISOString();
  const status: AuditStatus = responseStatus >= 200 && responseStatus < 400 ? 'succeeded' : 'failed';
  const finish = db.transaction(() => {
    const changed = db.prepare(
      `UPDATE operation_audit
       SET status=?, response_status=?, response_json=?, updated_at=?, finished_at=?
       WHERE id=? AND status='running'`,
    ).run(status, responseStatus, responseJson, now, now, id);
    if (changed.changes !== 1) {
      throw new OperationAuditError('INVALID_OPERATION_STATE', 'operation is missing or already terminal');
    }
    return db.prepare('SELECT * FROM operation_audit WHERE id=?').get(id) as Record<string, unknown>;
  });
  return rowToRecord(finish.immediate());
}

export function reconcileInterruptedOperations(db: Database.Database): number {
  const now = new Date().toISOString();
  const response = canonicalJson({
    error: {
      code: 'OPERATION_INTERRUPTED',
      message: 'Administrative operation was interrupted by a Studio restart; inspect live state before retrying with a new key',
    },
  });
  return db.prepare(
    `UPDATE operation_audit
     SET status='failed', response_status=503, response_json=?, updated_at=?, finished_at=?
     WHERE status='running'`,
  ).run(response, now, now).changes;
}

/**
 * Cross-path project mutex shared by deploy, backup, migrations and rollback.
 * The row is persistent so a crash is visible; startup reconciliation removes
 * stale rows only after it has closed interrupted operations/deployments.
 */
export function acquireProjectOperationLock(
  db: Database.Database,
  input: { projectId: string; operationId: string; operation: string },
): boolean {
  try {
    db.prepare(
      'INSERT INTO project_operation_locks(project_id, operation_id, operation, acquired_at) VALUES (?,?,?,?)',
    ).run(input.projectId, input.operationId, input.operation, new Date().toISOString());
    return true;
  } catch (error) {
    const code = (error as { code?: string }).code ?? '';
    if (code.startsWith('SQLITE_CONSTRAINT')) return false;
    throw error;
  }
}

export function releaseProjectOperationLock(db: Database.Database, operationId: string): boolean {
  return db.prepare('DELETE FROM project_operation_locks WHERE operation_id=?').run(operationId).changes === 1;
}

export function reconcileProjectOperationLocks(db: Database.Database): number {
  return db.prepare('DELETE FROM project_operation_locks').run().changes;
}

export function listOperations(db: Database.Database, projectId: string, limit = 100): OperationAuditRecord[] {
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  const rows = db
    .prepare('SELECT * FROM operation_audit WHERE project_id=? ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(projectId, safeLimit) as Array<Record<string, unknown>>;
  return rows.map(rowToRecord);
}
