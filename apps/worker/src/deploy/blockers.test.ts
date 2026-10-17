/**
 * Fase 6 — tests de regresión de la revisión de Codex (10 bloqueos).
 *
 * Bloqueos cubiertos en este fichero:
 *  B1: timeouts y cancelación real (AbortSignal, abort sin trabajo en
 *      segundo plano, cancelación en promoting segura).
 *  B3: sanitización de `deployments.error` (driver, rollback, reconciliación).
 *  B4: backup obligatorio y validado antes de tocar live.
 *  B5: rollback sin versión anterior → failed (nunca rolled_back ficticio).
 *  B6: matriz de limpieza en fallos de migrating/verifying + fallos de
 *      limpieza registrados en el diagnóstico.
 *  B7: semántica de discardCandidate (nunca tras promoción correcta).
 *  B8: atomicidad estado+evento (fallo al insertar el evento revierte el estado).
 *
 * B2 (puerta persistida) vive en receipts.test.ts; B9 es el fix
 * determinista en dynamicTools.test.ts; B10 es documentación.
 *
 * Ningún test necesita Docker, Oracle ni red externa.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from '../../../server/src/db.js';
import {
  createDeployment,
  getDeployment,
  isDeploymentCancelRequested,
  listDeploymentEvents,
  reconcileDeployments,
  requestDeploymentCancel,
  runDeploymentPipeline,
  transitionDeployment,
  upsertProjectRuntime,
  MAX_ERROR_CHARS,
} from '../index.js';
import {
  FakeDeploymentDriver,
  assertDriverArgs,
  type DriverOpArgs,
  type DriverResult,
  type FakeOpName,
  type HealthCheckArgs,
  type LiveBackupArgs,
} from './driver.js';
import { nowIso } from '../tools.js';

let db: Database.Database;
let dir: string;

const gateOk = () => ({ ok: true });

function addProject(id: string, type: 'dynamic' | 'static' = 'dynamic'): void {
  const now = nowIso();
  db.prepare('INSERT INTO projects(id, name, type, status, created_at, updated_at) VALUES (?,?,?,?,?,?)').run(
    id, `P-${id}`, type, 'active', now, now,
  );
}

function seedRuntime(projectId: string, liveImage: string): void {
  upsertProjectRuntime(db, {
    projectId,
    containerName: `appforge-app-${projectId.slice(0, 8)}`,
    liveImage,
    previousImage: null,
    status: 'running',
  });
}

/** Hace fallar solo el PRIMER health check live (el del candidato). */
function failFirstLiveHealth(): (op: FakeOpName, args: DriverOpArgs) => 'fail' | undefined {
  let failedOnce = false;
  return (op, args) => {
    if (op === 'runHealthCheck' && (args as HealthCheckArgs).runtime === 'live' && !failedOnce) {
      failedOnce = true;
      return 'fail';
    }
    return undefined;
  };
}

function runPipeline(
  driver: FakeDeploymentDriver,
  projectId: string,
  extra: { opTimeoutMs?: number; pipelineTimeoutMs?: number; cancelPollMs?: number } = {},
) {
  return runDeploymentPipeline(db, driver, {
    projectId,
    target: 'oracle',
    verificationGate: gateOk,
    opTimeoutMs: extra.opTimeoutMs ?? 10_000,
    pipelineTimeoutMs: extra.pipelineTimeoutMs ?? 60_000,
    cancelPollMs: extra.cancelPollMs ?? 20,
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-blockers-test-'));
  db = openDb(dir);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// B1 — timeouts y cancelación real
// ---------------------------------------------------------------------------

describe('B1 timeouts and real abort (revisión Codex)', () => {
  it('hanging operation → op timeout → terminal failed, no dangling ops', async () => {
    addProject('p1');
    const driver = new FakeDeploymentDriver({ db, behavior: { buildCandidate: 'hang' } });
    const final = await runPipeline(driver, 'p1', { opTimeoutMs: 200 });
    expect(final.status).toBe('failed');
    expect(final.error).toMatch(/operation timed out/i);
    // Abort real: ninguna operación queda en vuelo.
    expect(driver.pendingOpCount()).toBe(0);
    // Limpieza ejecutada tras el timeout.
    expect(driver.callsOf('discardCandidate').length).toBe(1);
  });

  it('cancel during a hung operation → cancelled, operation really aborted', async () => {
    addProject('p1');
    const driver = new FakeDeploymentDriver({
      db,
      behavior: { buildCandidate: 'hang' },
      hooks: {
        buildCandidate: (call) => {
          requestDeploymentCancel(db, call.args.deploymentId);
        },
      },
    });
    const final = await runPipeline(driver, 'p1', { opTimeoutMs: 10_000 });
    expect(final.status).toBe('cancelled');
    expect(driver.pendingOpCount()).toBe(0);
    expect(driver.callsOf('discardCandidate').length).toBe(1);
    expect(driver.callsOf('runLiveMigrations').length).toBe(0);
  });

  it('pipeline total timeout → terminal failed', async () => {
    addProject('p1');
    const driver = new FakeDeploymentDriver({ db, behavior: { buildCandidate: 'hang' } });
    const final = await runPipeline(driver, 'p1', { opTimeoutMs: 10_000, pipelineTimeoutMs: 300 });
    expect(final.status).toBe('failed');
    expect(final.error).toMatch(/pipeline timed out/i);
    expect(driver.pendingOpCount()).toBe(0);
  });

  it('cancel during promoting completes a safe promotion (never incoherent)', async () => {
    addProject('p1');
    const driver = new FakeDeploymentDriver({
      db,
      delayMs: { runLiveMigrations: 300 },
      hooks: {
        runLiveMigrations: (call) => {
          requestDeploymentCancel(db, call.args.deploymentId);
        },
      },
    });
    const final = await runPipeline(driver, 'p1', { opTimeoutMs: 5000 });
    // La cancelación en la sección crítica NO interrumpe: promoción segura.
    expect(final.status).toBe('live');
    expect(final.cancelRequested).toBe(true);
    expect(driver.pendingOpCount()).toBe(0);
  });

  it('cancel during promoting with live failure → rollback, never stuck', async () => {
    addProject('p1');
    seedRuntime('p1', 'img-old');
    const driver = new FakeDeploymentDriver({
      db,
      delayMs: { runLiveMigrations: 300 },
      hooks: {
        runLiveMigrations: (call) => {
          requestDeploymentCancel(db, call.args.deploymentId);
        },
      },
      decide: failFirstLiveHealth(),
    });
    const final = await runPipeline(driver, 'p1', { opTimeoutMs: 5000 });
    expect(final.status).toBe('rolled_back');
    expect(final.cancelRequested).toBe(true);
    expect(driver.pendingOpCount()).toBe(0);
  });

  it('timeout during promoting → rollback, never stuck', async () => {
    addProject('p1');
    seedRuntime('p1', 'img-old');
    const driver = new FakeDeploymentDriver({ db, behavior: { runLiveMigrations: 'hang' } });
    const final = await runPipeline(driver, 'p1', { opTimeoutMs: 200 });
    expect(final.status).toBe('rolled_back');
    // rolled_back no fija error: el diagnóstico del timeout vive en los eventos.
    const events = listDeploymentEvents(db, final.id);
    const rollbackStarted = events.find((e) => e.event === 'rollback_started');
    expect(rollbackStarted?.output).toMatch(/timed out/i);
    expect(driver.pendingOpCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// B3 — sanitización de deployments.error
// ---------------------------------------------------------------------------

describe('B3 error sanitization (revisión Codex)', () => {
  it('driver error secrets never reach SQLite', async () => {
    addProject('p1');
    const driver = new FakeDeploymentDriver({
      db,
      behavior: { buildCandidate: 'fail' },
      failError: {
        buildCandidate:
          'boom: password=hunter2secret Authorization: Bearer abc123tokenXYZ Cookie: af_session=deadbeefcookie token=tok1234567890',
      },
    });
    const final = await runPipeline(driver, 'p1');
    expect(final.status).toBe('failed');
    const row = db.prepare('SELECT error FROM deployments WHERE id=?').get(final.id) as { error: string };
    for (const secret of ['hunter2secret', 'abc123tokenXYZ', 'deadbeefcookie', 'tok1234567890']) {
      expect(row.error).not.toContain(secret);
      expect(final.error ?? '').not.toContain(secret);
    }
    expect(row.error).toContain('[redacted]');
  });

  it('over-long errors are truncated to the cap', async () => {
    addProject('p1');
    const driver = new FakeDeploymentDriver({
      db,
      behavior: { buildCandidate: 'fail' },
      failError: { buildCandidate: `x=${'y'.repeat(10_000)}` },
    });
    const final = await runPipeline(driver, 'p1');
    const row = db.prepare('SELECT error FROM deployments WHERE id=?').get(final.id) as { error: string };
    expect(row.error.length).toBeLessThanOrEqual(MAX_ERROR_CHARS);
  });

  it('rollback diagnostics are sanitized too', async () => {
    addProject('p1');
    seedRuntime('p1', 'img-old');
    const driver = new FakeDeploymentDriver({
      db,
      decide: failFirstLiveHealth(),
      behavior: { startPreviousVersion: 'fail' },
      failError: {
        startPreviousVersion: 'rollback blew up: password=rollbacksecret9',
      },
    });
    const final = await runPipeline(driver, 'p1');
    // El rollback falla (startPreviousVersion) → failed con ambos diagnósticos, sanitizados.
    expect(final.status).toBe('failed');
    expect(final.error).not.toContain('rollbacksecret9');
    expect(final.error).toMatch(/rollback FAILED/i);
  });
});

// ---------------------------------------------------------------------------
// B4 — backup obligatorio y validado
// ---------------------------------------------------------------------------

describe('B4 mandatory validated backup (revisión Codex)', () => {
  it('ok backup without backupId → failed, live migrations never run', async () => {
    addProject('p1');
    seedRuntime('p1', 'img-old');
    class NoBackupId extends FakeDeploymentDriver {
      override async createLiveBackup(args: LiveBackupArgs): Promise<DriverResult> {
        assertDriverArgs(args);
        return { ok: true, code: 'BACKUP_OK' };
      }
    }
    const driver = new NoBackupId({ db });
    const final = await runPipeline(driver, 'p1');
    expect(final.status).toBe('failed');
    expect(final.error).toMatch(/backup.*invalid/i);
    expect(driver.callsOf('runLiveMigrations').length).toBe(0);
    expect(getDeployment(db, final.id)!.backupId).toBeNull();
  });

  it('malformed backupId → failed, live untouched', async () => {
    addProject('p1');
    seedRuntime('p1', 'img-old');
    const driver = new FakeDeploymentDriver({ db, backupId: '../evil' });
    const final = await runPipeline(driver, 'p1');
    expect(final.status).toBe('failed');
    expect(final.error).toMatch(/backupId missing or invalid/i);
    expect(driver.callsOf('runLiveMigrations').length).toBe(0);
  });

  it('missing semantic validation → failed', async () => {
    addProject('p1');
    seedRuntime('p1', 'img-old');
    class NoValidation extends FakeDeploymentDriver {
      override async createLiveBackup(args: LiveBackupArgs): Promise<DriverResult> {
        assertDriverArgs(args);
        return { ok: true, code: 'BACKUP_OK', data: { backupId: 'bk_valid123' } };
      }
    }
    const driver = new NoValidation({ db });
    const final = await runPipeline(driver, 'p1');
    expect(final.status).toBe('failed');
    expect(final.error).toMatch(/not semantically validated/i);
    expect(driver.callsOf('runLiveMigrations').length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// B5 — rollback sin versión anterior
// ---------------------------------------------------------------------------

describe('B5 rollback without previous version (revisión Codex)', () => {
  it('first deploy whose candidate fails live health → failed, not rolled_back', async () => {
    addProject('p1'); // sin runtime: primer despliegue
    const driver = new FakeDeploymentDriver({ db, decide: failFirstLiveHealth() });
    const final = await runPipeline(driver, 'p1');
    expect(final.status).toBe('failed');
    expect(final).not.toHaveProperty('status', 'rolled_back');
    expect(final.error).toMatch(/no previous live version/i);
    // Se restaura el backup (existe), pero NUNCA se arranca una versión inexistente…
    expect(driver.callsOf('restoreBackup').length).toBe(1);
    expect(driver.callsOf('startPreviousVersion').length).toBe(0);
    // …y nunca hay health ficticio: solo el health del propio candidato.
    const liveHealths = driver
      .callsOf('runHealthCheck')
      .filter((c) => (c.args as HealthCheckArgs).runtime === 'live');
    expect(liveHealths.length).toBe(1);
    // El candidato fallido se limpia.
    expect(driver.callsOf('discardCandidate').length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// B6 — matriz de limpieza
// ---------------------------------------------------------------------------

describe('B6 cleanup matrix (revisión Codex)', () => {
  const matrix: Array<{
    name: string;
    failOp: FakeOpName | 'verifyHealth';
    expectStop: boolean;
  }> = [
    { name: 'prepareVerificationDatabase', failOp: 'prepareVerificationDatabase', expectStop: false },
    { name: 'runVerificationMigrations', failOp: 'runVerificationMigrations', expectStop: false },
    { name: 'startVerificationRuntime', failOp: 'startVerificationRuntime', expectStop: true },
    { name: 'verify health', failOp: 'verifyHealth', expectStop: true },
    { name: 'authenticated verification', failOp: 'runAuthenticatedVerification', expectStop: true },
  ];

  for (const { name, failOp, expectStop } of matrix) {
    it(`failure in ${name} → full verification cleanup`, async () => {
      addProject('p1');
      seedRuntime('p1', 'old-img');
      const driver = new FakeDeploymentDriver({
        db,
        decide: (op, args) => {
          if (failOp === 'verifyHealth') {
            return op === 'runHealthCheck' && (args as HealthCheckArgs).runtime === 'verify' ? 'fail' : undefined;
          }
          return op === failOp ? 'fail' : undefined;
        },
      });
      const final = await runPipeline(driver, 'p1');
      expect(final.status).toBe('failed');
      expect(driver.callsOf('stopVerificationRuntime').length).toBe(expectStop ? 1 : 0);
      expect(driver.callsOf('discardVerificationDatabase').length).toBe(1);
      expect(driver.callsOf('discardCandidate').length).toBe(1);
      expect(driver.callsOf('runLiveMigrations').length).toBe(0);
    });
  }

  it('cleanup failures are recorded in the final diagnostic, not swallowed', async () => {
    addProject('p1');
    const driver = new FakeDeploymentDriver({
      db,
      behavior: { buildCandidate: 'fail', discardCandidate: 'fail' },
    });
    const final = await runPipeline(driver, 'p1');
    expect(final.status).toBe('failed');
    expect(final.error).toMatch(/cleanup failures/i);
    const events = listDeploymentEvents(db, final.id);
    expect(events.some((e) => e.event.startsWith('cleanup:') && e.status === 'failed')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B7 — semántica de discardCandidate
// ---------------------------------------------------------------------------

describe('B7 discardCandidate semantics (revisión Codex)', () => {
  it('happy path: the promoted candidate is never discarded', async () => {
    addProject('p1');
    const driver = new FakeDeploymentDriver({ db });
    const final = await runPipeline(driver, 'p1');
    expect(final.status).toBe('live');
    expect(driver.callsOf('discardCandidate').length).toBe(0);
    // El orden exacto termina en startCandidateAsLive → health live, sin discard posterior.
    const ops = driver.calls.map((c) => c.op);
    expect(ops.slice(-2)).toEqual(['startCandidateAsLive', 'runHealthCheck']);
  });

  it('rollback discards the failed candidate after the rollback health check', async () => {
    addProject('p1');
    seedRuntime('p1', 'img-old');
    const driver = new FakeDeploymentDriver({ db, decide: failFirstLiveHealth() });
    const final = await runPipeline(driver, 'p1');
    expect(final.status).toBe('rolled_back');
    const discards = driver.callsOf('discardCandidate');
    expect(discards.length).toBe(1);
    const healths = driver.callsOf('runHealthCheck');
    const lastHealthIdx = driver.calls.lastIndexOf(healths[healths.length - 1]!);
    const discardIdx = driver.calls.indexOf(discards[0]!);
    expect(discardIdx).toBeGreaterThan(lastHealthIdx);
  });
});

// ---------------------------------------------------------------------------
// B8 — atomicidad estado+evento
// ---------------------------------------------------------------------------

describe('B8 state+event atomicity (revisión Codex)', () => {
  const TRIGGER = `CREATE TRIGGER trg_fail_event BEFORE INSERT ON deployment_events
    WHEN NEW.deployment_id='sentinel-fail'
    BEGIN SELECT RAISE(ABORT, 'forced event insert failure'); END;`;

  function insertSentinelRow(status: string): void {
    const now = nowIso();
    db.prepare(
      `INSERT INTO deployments(id, project_id, target, status, url, created_at, logs,
         candidate_id, previous_live_version, backup_id, cancel_requested,
         started_at, updated_at, finished_at, error)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run('sentinel-fail', 'p1', 'oracle', status, null, now, '', null, null, null, 0, now, now, null, null);
  }

  it('event insert failure rolls back the transition', () => {
    addProject('p1');
    insertSentinelRow('pending');
    db.exec(TRIGGER);
    try {
      expect(() => transitionDeployment(db, 'sentinel-fail', 'building')).toThrow(/forced event insert failure/);
      expect(getDeployment(db, 'sentinel-fail')!.status).toBe('pending');
      expect(listDeploymentEvents(db, 'sentinel-fail').length).toBe(0);
    } finally {
      db.exec('DROP TRIGGER trg_fail_event');
    }
  });

  it('createDeployment is atomic: event failure → no deployment row', () => {
    addProject('p1');
    db.exec('DROP TABLE deployment_events');
    expect(() => createDeployment(db, { projectId: 'p1', target: 'oracle' })).toThrow();
    const c = db.prepare('SELECT COUNT(*) AS c FROM deployments').get() as { c: number };
    expect(c.c).toBe(0);
  });

  it('cancel is atomic: event failure → flag unchanged', () => {
    addProject('p1');
    const dep = createDeployment(db, { projectId: 'p1', target: 'oracle' });
    db.exec('DROP TABLE deployment_events');
    expect(() => requestDeploymentCancel(db, dep.id)).toThrow();
    expect(isDeploymentCancelRequested(db, dep.id)).toBe(false);
  });

  it('restart recovery is atomic: event failure → status unchanged', async () => {
    addProject('p1');
    insertSentinelRow('building');
    db.exec(TRIGGER);
    try {
      await expect(reconcileDeployments(db)).rejects.toThrow(/forced event insert failure/);
      expect(getDeployment(db, 'sentinel-fail')!.status).toBe('building');
    } finally {
      db.exec('DROP TRIGGER trg_fail_event');
    }
  });
});
