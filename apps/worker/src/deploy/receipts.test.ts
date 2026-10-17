/**
 * Fase 6 — tests de la puerta de verificación persistida autoritativa
 * (revisión Codex, bloqueo 2).
 *
 * La ruta HTTP `POST /api/projects/:id/deploy` solo crea el deployment si
 * los SEIS checks 5A/5B tienen receipts persistidos vigentes sobre las
 * fuentes actuales y en orden canónico. Casos:
 * - seis válidos → permitido;
 * - falta cualquiera → 409;
 * - orden incorrecto → 409;
 * - fuente modificada después → 409;
 * - cero receipts → 409;
 * - build antiguo sobre fuentes distintas → 409;
 * - la invalidación por mutación también borra los receipts persistidos
 *   (incluso con el estado en memoria vacío: proceso nuevo).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from '../../../server/src/db.js';
import {
  DYNAMIC_CHECK_ORDER,
  checkScopeFingerprint,
  invalidateDynamicChecks,
  persistedDynamicGateStatus,
  recordDynamicCheckForTest,
  type DynamicCheckKey,
  type ToolContext,
} from '../index.js';
import { deleteVerificationReceipts, listVerificationReceipts, recordVerificationReceipt } from './receipts.js';

let db: Database.Database;
let dir: string;
let projectDir: string;

function makeCtx(): ToolContext {
  return {
    db,
    projectId: 'p1',
    projectDir,
    frontendDir: path.join(projectDir, 'frontend'),
    cmdTimeoutMs: 1000,
    buildTimeoutMs: 1000,
  } as ToolContext;
}

function seedProjectFiles(): void {
  for (const d of ['frontend', 'backend', 'migrations', 'tests']) {
    fs.mkdirSync(path.join(projectDir, d), { recursive: true });
  }
  fs.writeFileSync(path.join(projectDir, 'frontend', 'app.js'), 'console.log(1)');
  fs.writeFileSync(path.join(projectDir, 'backend', 'server.js'), 'serve();');
  fs.writeFileSync(path.join(projectDir, 'migrations', '001_init.sql'), 'CREATE TABLE t(x);');
  fs.writeFileSync(path.join(projectDir, 'tests', 'a.test.mjs'), 'ok');
  fs.writeFileSync(path.join(projectDir, 'package.json'), '{"name":"app"}');
}

function recordAllSix(ctx: ToolContext): void {
  for (const key of DYNAMIC_CHECK_ORDER) recordDynamicCheckForTest(ctx, key);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-receipts-test-'));
  db = openDb(dir);
  projectDir = path.join(dir, 'proj');
  seedProjectFiles();
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('persisted verification gate (bloqueo 2)', () => {
  it('six valid receipts → allowed', () => {
    const ctx = makeCtx();
    recordAllSix(ctx);
    const gate = persistedDynamicGateStatus(db, projectDir, 'p1');
    expect(gate.ok).toBe(true);
    const receipts = listVerificationReceipts(db, 'p1');
    expect(receipts.map((r) => r.checkKey)).toEqual([...DYNAMIC_CHECK_ORDER]);
    expect(receipts.map((r) => r.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    for (const r of receipts) {
      expect(r.fingerprint).toBe(checkScopeFingerprint(projectDir, r.checkKey));
      expect(r.createdAt).toBeTruthy();
    }
  });

  it('missing any receipt → rejected', () => {
    const ctx = makeCtx();
    for (const key of DYNAMIC_CHECK_ORDER) {
      if (key === 'apiTests') continue;
      recordDynamicCheckForTest(ctx, key);
    }
    const gate = persistedDynamicGateStatus(db, projectDir, 'p1');
    expect(gate.ok).toBe(false);
    expect(gate.reason).toMatch(/missing verification receipts: apiTests/);
  });

  it('wrong order → rejected', () => {
    // Inserción manual con seq permutados (no puede ocurrir vía
    // recordDynamicCheck, que asigna el índice canónico).
    DYNAMIC_CHECK_ORDER.forEach((key, i) => {
      const fp = checkScopeFingerprint(projectDir, key) ?? 'missing';
      const seq = key === 'migrations' ? 3 : key === 'apiTests' ? 2 : i;
      recordVerificationReceipt(db, 'p1', key, fp, seq);
    });
    const gate = persistedDynamicGateStatus(db, projectDir, 'p1');
    expect(gate.ok).toBe(false);
    expect(gate.reason).toMatch(/out of canonical order/);
  });

  it('source modified afterwards → rejected', () => {
    const ctx = makeCtx();
    recordAllSix(ctx);
    expect(persistedDynamicGateStatus(db, projectDir, 'p1').ok).toBe(true);
    fs.writeFileSync(path.join(projectDir, 'frontend', 'app.js'), 'console.log(2)');
    const gate = persistedDynamicGateStatus(db, projectDir, 'p1');
    expect(gate.ok).toBe(false);
    expect(gate.reason).toMatch(/'frontendBuild' is stale/);
  });

  it('zero receipts → rejected', () => {
    const gate = persistedDynamicGateStatus(db, projectDir, 'p1');
    expect(gate.ok).toBe(false);
    expect(gate.reason).toMatch(/missing verification receipts/);
  });

  it('old build over different sources → rejected', () => {
    const ctx = makeCtx();
    recordAllSix(ctx);
    fs.writeFileSync(path.join(projectDir, 'backend', 'server.js'), 'serve2();');
    const gate = persistedDynamicGateStatus(db, projectDir, 'p1');
    expect(gate.ok).toBe(false);
    expect(gate.reason).toMatch(/'backendBuild' is stale/);
  });

  it('recording a check drops its canonical followers (persisted)', () => {
    const ctx = makeCtx();
    recordAllSix(ctx);
    // Re-ejecutar migraciones invalida migraciones y todo lo posterior.
    recordDynamicCheckForTest(ctx, 'migrations');
    const keys = listVerificationReceipts(db, 'p1').map((r) => r.checkKey);
    expect(keys).toEqual(['frontendBuild', 'backendBuild', 'migrations']);
    expect(persistedDynamicGateStatus(db, projectDir, 'p1').ok).toBe(false);
  });

  it('mutation invalidates persisted receipts even with empty in-memory state', () => {
    const ctx = makeCtx();
    recordAllSix(ctx);
    // Proceso nuevo: sin checks en memoria pero con receipts persistidos.
    const freshCtx = makeCtx();
    expect(freshCtx.dynamicChecks).toBeUndefined();
    fs.writeFileSync(path.join(projectDir, 'frontend', 'app.js'), 'console.log(3)');
    invalidateDynamicChecks(freshCtx);
    expect(listVerificationReceipts(db, 'p1').length).toBe(0);
    expect(persistedDynamicGateStatus(db, projectDir, 'p1').ok).toBe(false);
  });

  it('deleteVerificationReceipts with empty list is a no-op', () => {
    expect(() => deleteVerificationReceipts(db, 'p1', [])).not.toThrow();
  });
});
