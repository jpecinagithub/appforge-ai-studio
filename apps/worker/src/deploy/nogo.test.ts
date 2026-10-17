/**
 * Fase 6 — tests de regresión de la revisión final de Codex (NO-GO, 4 bloqueos).
 *
 *  N1: timeout global durante promoting → rollback con presupuesto de
 *      recuperación independiente → rolled_back, health anterior OK, cero
 *      operaciones pendientes.
 *  N2: stopVerificationRuntime=fail / =timeout tras autenticación correcta
 *      → failed; cero llamadas a createLiveBackup/runLiveMigrations/
 *      startCandidateAsLive (el stop es precondición obligatoria).
 *  N3: cancelación/timeout de runAuthenticatedVerification + fallo al
 *      detener el runtime → ningún avance a promoting, diagnóstico completo.
 *  N4: backup sin ID / ID inválido / sin validación → discardCandidate
 *      exactamente una vez; si el descarte falla, queda en
 *      deployments.error y en eventos.
 *  N5: discardVerificationDatabase=fail en flujo por lo demás correcto →
 *      sin promoción, failed, diagnóstico de limpieza.
 *  N6: trigger SQLite que hace fallar el evento de transición a live → la
 *      transacción revierte también project_runtime (se conserva la
 *      versión anterior).
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
  getDeployment,
  getProjectRuntime,
  listDeploymentEvents,
  requestDeploymentCancel,
  runDeploymentPipeline,
  upsertProjectRuntime,
} from '../index.js';
import {
  FakeDeploymentDriver,
  type DriverOpArgs,
  type FakeOpName,
  type HealthCheckArgs,
} from './driver.js';
import { nowIso } from '../tools.js';

let db: Database.Database;
let dir: string;

const gateOk = () => ({ ok: true });

function addProject(id: string): void {
  const now = nowIso();
  db.prepare('INSERT INTO projects(id, name, type, status, created_at, updated_at) VALUES (?,?,?,?,?,?)').run(
    id, `P-${id}`, 'dynamic', 'active', now, now,
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

function runPipeline(
  driver: FakeDeploymentDriver,
  projectId: string,
  extra: { opTimeoutMs?: number; pipelineTimeoutMs?: number; rollbackTimeoutMs?: number; cancelPollMs?: number } = {},
) {
  return runDeploymentPipeline(db, driver, {
    projectId,
    target: 'oracle',
    verificationGate: gateOk,
    opTimeoutMs: extra.opTimeoutMs ?? 10_000,
    pipelineTimeoutMs: extra.pipelineTimeoutMs ?? 60_000,
    rollbackTimeoutMs: extra.rollbackTimeoutMs,
    cancelPollMs: extra.cancelPollMs ?? 20,
  });
}

const LIVE_OPS: FakeOpName[] = ['createLiveBackup', 'runLiveMigrations', 'startCandidateAsLive'];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-nogo-test-'));
  db = openDb(dir);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// N1 — timeout global durante promoting + rollback con presupuesto propio
// ---------------------------------------------------------------------------

describe('N1 independent rollback recovery budget (bloqueo 2)', () => {
  it('pipeline timeout during promoting → rolled_back with slow rollback ops, zero pending', async () => {
    addProject('p1');
    seedRuntime('p1', 'prev-v1');
    const driver = new FakeDeploymentDriver({
      db,
      delayMs: {
        runLiveMigrations: 1500, // el timeout global (500ms) la aborta a mitad
        stopCurrentLiveRuntime: 100, // rollback deliberadamente lento…
        restoreBackup: 100,
        startPreviousVersion: 100,
      },
    });
    const final = await runPipeline(driver, 'p1', {
      opTimeoutMs: 30_000, // el timeout de operación no debe dispararse
      pipelineTimeoutMs: 500, // …pero el global sí, durante promoting
      rollbackTimeoutMs: 30_000, // presupuesto de recuperación independiente
    });
    expect(final.status).toBe('rolled_back');
    // El rollback restauró la versión anterior sana: su health check pasó.
    const liveHealths = driver
      .callsOf('runHealthCheck')
      .filter((c) => (c.args as HealthCheckArgs).runtime === 'live');
    expect(liveHealths.length).toBe(1);
    expect(driver.callsOf('startPreviousVersion').length).toBe(1);
    expect(driver.callsOf('restoreBackup').length).toBe(1);
    // Abort real: ninguna operación queda en vuelo (ni la abortada ni las de rollback).
    expect(driver.pendingOpCount()).toBe(0);
    const events = listDeploymentEvents(db, final.id);
    expect(events.some((e) => e.event === 'rollback_started')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// N2 — stopVerificationRuntime como precondición obligatoria
// ---------------------------------------------------------------------------

describe('N2 mandatory verification-runtime stop (bloqueo 1)', () => {
  it.each([
    ['fail', { stopVerificationRuntime: 'fail' } as const, {}],
    ['timeout', { stopVerificationRuntime: 'hang' } as const, { opTimeoutMs: 200 }],
  ])('stopVerificationRuntime=%s tras autenticación correcta → failed, live intacto', async (_label, behavior, extra) => {
    addProject('p1');
    seedRuntime('p1', 'old-img');
    const driver = new FakeDeploymentDriver({ db, behavior });
    const final = await runPipeline(driver, 'p1', { opTimeoutMs: 10_000, ...extra });
    expect(final.status).toBe('failed');
    expect(final.error).toMatch(/mandatory verification runtime stop failed/i);
    // Ni backup ni live: cero llamadas a las operaciones que tocan live.
    for (const op of LIVE_OPS) {
      expect(driver.callsOf(op).length).toBe(0);
    }
    expect(getProjectRuntime(db, 'p1')!.liveImage).toBe('old-img');
    expect(getDeployment(db, final.id)!.status).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// N3 — cancel/timeout de la verificación + fallo al detener el runtime
// ---------------------------------------------------------------------------

describe('N3 auth-verification cancel/timeout with failing stop (bloqueos 1+3)', () => {
  it('cancel during runAuthenticatedVerification + stop fails → cancelled, no promoting, full diagnostic', async () => {
    addProject('p1');
    const driver = new FakeDeploymentDriver({
      db,
      behavior: { runAuthenticatedVerification: 'hang', stopVerificationRuntime: 'fail' },
      hooks: {
        runAuthenticatedVerification: (call: { args: DriverOpArgs }) => {
          requestDeploymentCancel(db, call.args.deploymentId);
        },
      },
    });
    const final = await runPipeline(driver, 'p1');
    expect(final.status).toBe('cancelled');
    // Ningún avance a promoting.
    for (const op of LIVE_OPS) {
      expect(driver.callsOf(op).length).toBe(0);
    }
    expect(listDeploymentEvents(db, final.id).some((e) => e.phase === 'promoting')).toBe(false);
    // Diagnóstico completo: el fallo al detener el runtime queda registrado.
    const events = listDeploymentEvents(db, final.id);
    const transition = events.find((e) => e.event === 'transition' && e.status === 'cancelled');
    expect(transition?.output).toMatch(/cleanup failures/i);
    expect(events.some((e) => e.event.startsWith('cleanup:') && e.status === 'failed')).toBe(true);
  });

  it('timeout of runAuthenticatedVerification + stop fails → failed, no promoting, cleanup recorded', async () => {
    addProject('p1');
    const driver = new FakeDeploymentDriver({
      db,
      behavior: { runAuthenticatedVerification: 'hang', stopVerificationRuntime: 'fail' },
    });
    const final = await runPipeline(driver, 'p1', { opTimeoutMs: 200 });
    expect(final.status).toBe('failed');
    for (const op of LIVE_OPS) {
      expect(driver.callsOf(op).length).toBe(0);
    }
    expect(final.error).toMatch(/cleanup failures/i);
    expect(final.error).toMatch(/stopVerificationRuntime/i);
  });
});

// ---------------------------------------------------------------------------
// N4 — backup inválido: discardCandidate exactamente una vez
// ---------------------------------------------------------------------------

describe('N4 invalid backup discards the candidate exactly once (bloqueo 3)', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['sin backupId', { omitBackupId: true }],
    ['backupId inválido', { backupId: 'no es un id válido!!!' }],
    ['sin validación semántica', { backupValidated: 'false' }],
  ];
  for (const [name, fakeOpts] of cases) {
    it(`backup ${name} → failed, discardCandidate x1, live intacto`, async () => {
      addProject('p1');
      seedRuntime('p1', 'old-img');
      const driver = new FakeDeploymentDriver({ db, ...fakeOpts });
      const final = await runPipeline(driver, 'p1');
      expect(final.status).toBe('failed');
      expect(final.error).toMatch(/live backup invalid/i);
      expect(driver.callsOf('discardCandidate').length).toBe(1);
      expect(driver.callsOf('runLiveMigrations').length).toBe(0);
      expect(driver.callsOf('stopCurrentLiveRuntime').length).toBe(0);
      expect(driver.callsOf('startCandidateAsLive').length).toBe(0);
      expect(getProjectRuntime(db, 'p1')!.liveImage).toBe('old-img');
    });
  }

  it('backup inválido + discardCandidate falla → el fallo queda en deployments.error y eventos', async () => {
    addProject('p1');
    seedRuntime('p1', 'old-img');
    const driver = new FakeDeploymentDriver({
      db,
      omitBackupId: true,
      behavior: { discardCandidate: 'fail' },
    });
    const final = await runPipeline(driver, 'p1');
    expect(final.status).toBe('failed');
    expect(driver.callsOf('discardCandidate').length).toBe(1);
    expect(final.error).toMatch(/cleanup failures/i);
    const events = listDeploymentEvents(db, final.id);
    expect(events.some((e) => e.event.startsWith('cleanup:') && e.status === 'failed')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// N5 — fallo al descartar la BD de verificación tras verificación correcta
// ---------------------------------------------------------------------------

describe('N5 verification-database discard failure blocks promoting (bloqueo 3)', () => {
  it('discardVerificationDatabase=fail en flujo correcto → failed, sin promoción, diagnóstico de limpieza', async () => {
    addProject('p1');
    seedRuntime('p1', 'old-img');
    const driver = new FakeDeploymentDriver({
      db,
      behavior: { discardVerificationDatabase: 'fail' },
    });
    const final = await runPipeline(driver, 'p1');
    expect(final.status).toBe('failed');
    expect(final.error).toMatch(/verification database discard failed/i);
    expect(final.error).toMatch(/cannot promote/i);
    for (const op of LIVE_OPS) {
      expect(driver.callsOf(op).length).toBe(0);
    }
    // El candidato también se descarta (nunca fue live).
    expect(driver.callsOf('discardCandidate').length).toBe(1);
    expect(getProjectRuntime(db, 'p1')!.liveImage).toBe('old-img');
  });
});

// ---------------------------------------------------------------------------
// N6 — finalización atómica: si el evento falla, el runtime no se publica
// ---------------------------------------------------------------------------

describe('N6 atomic live finalization (bloqueo 4)', () => {
  it('el evento de transición a live falla → project_runtime revierte, se conserva la versión anterior', async () => {
    addProject('p1');
    seedRuntime('p1', 'prev-v1');
    // Trigger que hace fallar exactamente el INSERT del evento de
    // transición a live: la transacción debe revertir también el
    // upsert de project_runtime y el UPDATE de deployments.
    db.exec(
      `CREATE TRIGGER fail_live_transition BEFORE INSERT ON deployment_events
       WHEN NEW.phase = 'live' AND NEW.event = 'transition'
       BEGIN SELECT RAISE(ABORT, 'injected live-event failure'); END;`,
    );
    const driver = new FakeDeploymentDriver({ db });
    const final = await runPipeline(driver, 'p1');
    // La promoción había ido bien, pero no pudo persistirse: failed (vía
    // catch-all), nunca live a medias.
    expect(final.status).toBe('failed');
    expect(final.error).toMatch(/injected live-event failure/i);
    // project_runtime conserva la versión anterior: el nuevo runtime NO
    // quedó publicado.
    expect(getProjectRuntime(db, 'p1')!.liveImage).toBe('prev-v1');
    // Sin evento de transición a live.
    const events = listDeploymentEvents(db, final.id);
    expect(events.some((e) => e.phase === 'live' && e.event === 'transition')).toBe(false);
  });
});
