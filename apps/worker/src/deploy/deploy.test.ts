/**
 * Fase 6 — tests del pipeline de despliegue (criterios de aceptación 1–23).
 *
 * Mapa criterios → tests (los criterios 4/15/18/19/20 HTTP y 22/23 viven
 * además en apps/server/src/deployHttp.test.ts y en CI):
 *  1: camino completo           -> 'full pipeline'
 *  2: transición antes del driver -> 'driver observes persisted state'
 *  3: transiciones inválidas    -> 'state machine'
 *  4: concurrencia              -> 'createDeployment' (409) + HTTP 409
 *  5: dos proyectos             -> 'two projects are independent'
 *  6: fallo en building         -> 'build failure'
 *  7: fallo en migrating        -> 'verification migration failure'
 *  8: fallo en verifying        -> 'verification failure'
 *  9: fallo de backup           -> 'backup failure'
 * 10: fallo migración live      -> 'live migration failure rolls back once'
 * 11: candidato sin health      -> 'live health failure restores previous'
 * 12: rollback fallido          -> 'failed rollback'
 * 13: cancelación pre-promoting -> 'cancellation before the critical section'
 * 14: cancelación en promoting  -> 'cancellation during promoting'
 * 15: reinicio                  -> 'restart recovery' (+ server Test E p. migrations)
 * 16: runtime tras health       -> 'runtime updated only after live health'
 * 17: logs                      -> 'logs are sanitized, capped and ordered'
 * 18: proyecto static           -> 'static projects rejected'
 * 19: target no soportado       -> 'unsupported target rejected'
 * 20: sin driver                -> 'tool refuses without a driver'
 * 21: sin Docker/shell/red      -> 'no docker, shell or network'
 *
 * Ningún test necesita Docker, Oracle ni red externa: todo corre contra
 * FakeDeploymentDriver y SQLite local.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { openDb } from '../../../server/src/db.js';
import {
  DeploymentError,
  createDeployment,
  getDeployment,
  getProjectRuntime,
  isDeploymentCancelRequested,
  listDeploymentEvents,
  recordEvent,
  reconcileDeployments,
  requestDeploymentCancel,
  runDeploymentPipeline,
  transitionDeployment,
  upsertProjectRuntime,
  MAX_EVENT_OUTPUT_CHARS,
  MAX_DEPLOYMENT_LOGS_CHARS,
} from '../index.js';
import { FakeDeploymentDriver, type HealthCheckArgs } from './driver.js';
import { createDynamicTools } from '../dynamicTools.js';
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

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-deploy-test-'));
  db = openDb(dir);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Hace fallar solo el PRIMER health check live (el del candidato): simula
 * un candidato sin salud cuya versión anterior sí responde tras el restore.
 */
function failFirstLiveHealth() {
  let failedOnce = false;
  return (op: string, args: { runtime?: string }) => {
    if (op === 'runHealthCheck' && (args as HealthCheckArgs).runtime === 'live' && !failedOnce) {
      failedOnce = true;
      return 'fail' as const;
    }
    return undefined;
  };
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

// ---------------------------------------------------------------------------
// Criterio 3 — máquina de estados
// ---------------------------------------------------------------------------

describe('state machine (criterio 3)', () => {
  it('rejects invalid transitions with a stable error', () => {
    addProject('p1');
    const dep = createDeployment(db, { projectId: 'p1', target: 'oracle' });
    expect(() => transitionDeployment(db, dep.id, 'live')).toThrowError(DeploymentError);
    try {
      transitionDeployment(db, dep.id, 'live');
      expect.unreachable();
    } catch (e) {
      expect((e as DeploymentError).code).toBe('INVALID_TRANSITION');
    }
    try {
      transitionDeployment(db, dep.id, 'bogus');
      expect.unreachable();
    } catch (e) {
      expect((e as DeploymentError).code).toBe('INVALID_STATE');
    }
    // El estado no cambió tras los intentos inválidos.
    expect(getDeployment(db, dep.id)!.status).toBe('pending');
  });

  it('is idempotent when repeating an already-completed transition', () => {
    addProject('p1');
    const dep = createDeployment(db, { projectId: 'p1', target: 'oracle' });
    const once = transitionDeployment(db, dep.id, 'building', { diagnostic: 'x' });
    const twice = transitionDeployment(db, dep.id, 'building', { diagnostic: 'x' });
    expect(twice.status).toBe('building');
    expect(once.updatedAt).toBe(twice.updatedAt);
  });

  it('terminal states accept no further transitions', () => {
    addProject('p1');
    const dep = createDeployment(db, { projectId: 'p1', target: 'oracle' });
    transitionDeployment(db, dep.id, 'cancelled');
    try {
      transitionDeployment(db, dep.id, 'building');
      expect.unreachable();
    } catch (e) {
      expect((e as DeploymentError).code).toBe('INVALID_TRANSITION');
    }
    // …y promoting no admite 'cancelled' (la cancelación en la sección
    // crítica completa la promoción o ejecuta rollback, nunca cuelga).
    addProject('p2');
    const dep2 = createDeployment(db, { projectId: 'p2', target: 'oracle' });
    for (const s of ['building', 'migrating', 'verifying', 'promoting'] as const) transitionDeployment(db, dep2.id, s);
    try {
      transitionDeployment(db, dep2.id, 'cancelled');
      expect.unreachable();
    } catch (e) {
      expect((e as DeploymentError).code).toBe('INVALID_TRANSITION');
    }
  });

  it('rejects a second active deployment for the same project (criterio 4)', () => {
    addProject('p1');
    createDeployment(db, { projectId: 'p1', target: 'oracle' });
    try {
      createDeployment(db, { projectId: 'p1', target: 'oracle' });
      expect.unreachable();
    } catch (e) {
      expect((e as DeploymentError).code).toBe('DEPLOYMENT_ACTIVE');
      expect((e as DeploymentError).statusCode).toBe(409);
    }
  });
});

// ---------------------------------------------------------------------------
// Criterio 1 — camino completo
// ---------------------------------------------------------------------------

describe('full pipeline (criterio 1)', () => {
  it('runs pending → building → migrating → verifying → promoting → live', async () => {
    addProject('p1');
    const driver = new FakeDeploymentDriver({ db });
    const final = await runDeploymentPipeline(db, driver, {
      projectId: 'p1', target: 'oracle', verificationGate: gateOk,
    });
    expect(final.status).toBe('live');
    expect(final.finishedAt).not.toBeNull();
    expect(final.error).toBeNull();
    expect(final.candidateId).toBe(`cand-${final.id.slice(0, 8)}`);
    // project_runtime actualizado solo al final, con previous preservado.
    const rt = getProjectRuntime(db, 'p1')!;
    expect(rt.liveImage).toBe(final.candidateId);
    expect(rt.previousImage).toBeNull();
    expect(rt.status).toBe('running');
    // Historial exacto de eventos en orden.
    const events = listDeploymentEvents(db, final.id);
    const phases = events.map((e) => e.phase);
    for (const p of ['pending', 'building', 'migrating', 'verifying', 'promoting', 'live']) {
      expect(phases).toContain(p);
    }
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
  });
});

// ---------------------------------------------------------------------------
// Criterio 2 — la transición se persiste ANTES de invocar al driver
// ---------------------------------------------------------------------------

describe('driver observes persisted state (criterio 2)', () => {
  it('every driver op sees the expected persisted status', async () => {
    addProject('p1');
    const driver = new FakeDeploymentDriver({ db });
    const final = await runDeploymentPipeline(db, driver, {
      projectId: 'p1', target: 'oracle', verificationGate: gateOk,
    });
    expect(final.status).toBe('live');
    const seen = new Map(driver.calls.map((c) => [c.op, c.observedStatus] as const));
    expect(seen.get('buildCandidate')).toBe('building');
    expect(seen.get('prepareVerificationDatabase')).toBe('migrating');
    expect(seen.get('runVerificationMigrations')).toBe('migrating');
    expect(seen.get('startVerificationRuntime')).toBe('verifying');
    expect(seen.get('runAuthenticatedVerification')).toBe('verifying');
    expect(seen.get('stopVerificationRuntime')).toBe('verifying');
    expect(seen.get('createLiveBackup')).toBe('promoting');
    expect(seen.get('runLiveMigrations')).toBe('promoting');
    expect(seen.get('stopCurrentLiveRuntime')).toBe('promoting');
    expect(seen.get('startCandidateAsLive')).toBe('promoting');
    for (const c of driver.calls) {
      expect(c.observedStatus).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Criterio 5 — dos proyectos independientes
// ---------------------------------------------------------------------------

describe('two projects are independent (criterio 5)', () => {
  it('runs two pipelines without interference', async () => {
    addProject('pa');
    addProject('pb');
    const da = new FakeDeploymentDriver({ db });
    const dbb = new FakeDeploymentDriver({ db });
    const [fa, fb] = await Promise.all([
      runDeploymentPipeline(db, da, { projectId: 'pa', target: 'oracle', verificationGate: gateOk }),
      runDeploymentPipeline(db, dbb, { projectId: 'pb', target: 'oracle', verificationGate: gateOk }),
    ]);
    expect(fa.status).toBe('live');
    expect(fb.status).toBe('live');
    expect(getProjectRuntime(db, 'pa')!.liveImage).toBe(fa.candidateId);
    expect(getProjectRuntime(db, 'pb')!.liveImage).toBe(fb.candidateId);
  });
});

// ---------------------------------------------------------------------------
// Criterios 6–9 — fallos antes de promoting
// ---------------------------------------------------------------------------

describe('failures before promoting (criterios 6–9)', () => {
  it('build failure → failed, no promotion, candidate cleaned (criterio 6)', async () => {
    addProject('p1');
    seedRuntime('p1', 'old-img');
    const driver = new FakeDeploymentDriver({ db, behavior: { buildCandidate: 'fail' } });
    const final = await runDeploymentPipeline(db, driver, {
      projectId: 'p1', target: 'oracle', verificationGate: gateOk,
    });
    expect(final.status).toBe('failed');
    expect(final.error).toMatch(/building/);
    expect(driver.callsOf('removeCandidate').length).toBe(1);
    expect(driver.callsOf('runLiveMigrations').length).toBe(0);
    expect(driver.callsOf('startCandidateAsLive').length).toBe(0);
    expect(getProjectRuntime(db, 'p1')!.liveImage).toBe('old-img');
  });

  it('verification migration failure → failed, live intact (criterio 7)', async () => {
    addProject('p1');
    seedRuntime('p1', 'old-img');
    const driver = new FakeDeploymentDriver({ db, behavior: { runVerificationMigrations: 'fail' } });
    const final = await runDeploymentPipeline(db, driver, {
      projectId: 'p1', target: 'oracle', verificationGate: gateOk,
    });
    expect(final.status).toBe('failed');
    expect(driver.callsOf('discardVerificationDatabase').length).toBe(1);
    expect(driver.callsOf('runLiveMigrations').length).toBe(0);
    expect(getProjectRuntime(db, 'p1')!.liveImage).toBe('old-img');
  });

  it('verification failure → failed and verify runtime always stopped (criterio 8)', async () => {
    addProject('p1');
    seedRuntime('p1', 'old-img');
    const driver = new FakeDeploymentDriver({ db, behavior: { runAuthenticatedVerification: 'fail' } });
    const final = await runDeploymentPipeline(db, driver, {
      projectId: 'p1', target: 'oracle', verificationGate: gateOk,
    });
    expect(final.status).toBe('failed');
    const order = driver.calls.map((c) => c.op);
    expect(order.indexOf('stopVerificationRuntime')).toBeGreaterThan(order.indexOf('runAuthenticatedVerification'));
    expect(driver.callsOf('createLiveBackup').length).toBe(0);
    expect(getProjectRuntime(db, 'p1')!.liveImage).toBe('old-img');
  });

  it('backup failure → failed, live migrations never run (criterio 9)', async () => {
    addProject('p1');
    seedRuntime('p1', 'old-img');
    const driver = new FakeDeploymentDriver({ db, behavior: { createLiveBackup: 'fail' } });
    const final = await runDeploymentPipeline(db, driver, {
      projectId: 'p1', target: 'oracle', verificationGate: gateOk,
    });
    expect(final.status).toBe('failed');
    expect(final.error).toMatch(/backup/i);
    expect(driver.callsOf('runLiveMigrations').length).toBe(0);
    expect(driver.callsOf('stopCurrentLiveRuntime').length).toBe(0);
    expect(getProjectRuntime(db, 'p1')!.liveImage).toBe('old-img');
  });
});

// ---------------------------------------------------------------------------
// Criterios 10–12 — rollback
// ---------------------------------------------------------------------------

describe('rollback semantics (criterios 10–12)', () => {
  it('live migration failure → single rollback → rolled_back (criterio 10)', async () => {
    addProject('p1');
    seedRuntime('p1', 'old-img');
    const driver = new FakeDeploymentDriver({ db, behavior: { runLiveMigrations: 'fail' } });
    const final = await runDeploymentPipeline(db, driver, {
      projectId: 'p1', target: 'oracle', verificationGate: gateOk,
    });
    expect(final.status).toBe('rolled_back');
    expect(driver.callsOf('restoreBackup').length).toBe(1);
    expect(driver.callsOf('startPreviousVersion').length).toBe(1);
    expect(final.backupId).not.toBeNull();
    expect(final.previousLiveVersion).toBe('old-img');
    // project_runtime sigue reflejando la versión anterior: nunca dos live.
    expect(getProjectRuntime(db, 'p1')!.liveImage).toBe('old-img');
  });

  it('candidate without live health → previous version restored (criterio 11)', async () => {
    addProject('p1');
    seedRuntime('p1', 'old-img');
    const driver = new FakeDeploymentDriver({ db, decide: failFirstLiveHealth() });
    const final = await runDeploymentPipeline(db, driver, {
      projectId: 'p1', target: 'oracle', verificationGate: gateOk,
    });
    expect(final.status).toBe('rolled_back');
    expect(getProjectRuntime(db, 'p1')!.liveImage).toBe('old-img');
  });

  it('failed rollback → failed with both diagnostics, no retry loop (criterio 12)', async () => {
    addProject('p1');
    seedRuntime('p1', 'old-img');
    const driver = new FakeDeploymentDriver({
      db,
      behavior: { runLiveMigrations: 'fail', restoreBackup: 'fail' },
      failError: { restoreBackup: 'backup volume unreadable' },
    });
    const final = await runDeploymentPipeline(db, driver, {
      projectId: 'p1', target: 'oracle', verificationGate: gateOk,
    });
    expect(final.status).toBe('failed');
    expect(driver.callsOf('restoreBackup').length).toBe(1);
    expect(final.error).toMatch(/live migrations failed/i);
    expect(final.error).toMatch(/backup volume unreadable/);
  });
});

// ---------------------------------------------------------------------------
// Criterio 13 — cancelación antes de la sección crítica
// ---------------------------------------------------------------------------

describe('cancellation before the critical section (criterio 13)', () => {
  it('cancel in pending → cancelled with no driver calls', async () => {
    addProject('p1');
    const dep = createDeployment(db, { projectId: 'p1', target: 'oracle' });
    requestDeploymentCancel(db, dep.id);
    const driver = new FakeDeploymentDriver({ db });
    const final = await runDeploymentPipeline(db, driver, {
      projectId: 'p1', target: 'oracle', deploymentId: dep.id, verificationGate: gateOk,
    });
    expect(final.status).toBe('cancelled');
    expect(driver.calls.length).toBe(0);
    expect(final.finishedAt).not.toBeNull();
  });

  it('cancel during building → cancelled + candidate removed', async () => {
    addProject('p1');
    const driver = new FakeDeploymentDriver({
      db,
      hooks: { buildCandidate: (call) => { requestDeploymentCancel(db, call.args.deploymentId); } },
    });
    const final = await runDeploymentPipeline(db, driver, {
      projectId: 'p1', target: 'oracle', verificationGate: gateOk,
    });
    expect(final.status).toBe('cancelled');
    expect(driver.callsOf('removeCandidate').length).toBe(1);
    expect(driver.callsOf('runLiveMigrations').length).toBe(0);
  });

  it('cancel during migrating → cancelled + verification discarded', async () => {
    addProject('p1');
    const driver = new FakeDeploymentDriver({
      db,
      hooks: { prepareVerificationDatabase: (call) => { requestDeploymentCancel(db, call.args.deploymentId); } },
    });
    const final = await runDeploymentPipeline(db, driver, {
      projectId: 'p1', target: 'oracle', verificationGate: gateOk,
    });
    expect(final.status).toBe('cancelled');
    expect(driver.callsOf('discardVerificationDatabase').length).toBeGreaterThanOrEqual(1);
    expect(driver.callsOf('createLiveBackup').length).toBe(0);
  });

  it('cancel during verifying → cancelled + verify runtime stopped', async () => {
    addProject('p1');
    const driver = new FakeDeploymentDriver({
      db,
      hooks: { startVerificationRuntime: (call) => { requestDeploymentCancel(db, call.args.deploymentId); } },
    });
    const final = await runDeploymentPipeline(db, driver, {
      projectId: 'p1', target: 'oracle', verificationGate: gateOk,
    });
    expect(final.status).toBe('cancelled');
    expect(driver.callsOf('stopVerificationRuntime').length).toBeGreaterThanOrEqual(1);
    expect(driver.callsOf('createLiveBackup').length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Criterio 14 — cancelación durante promoting
// ---------------------------------------------------------------------------

describe('cancellation during promoting (criterio 14)', () => {
  it('completes a safe promotion (never hangs)', async () => {
    addProject('p1');
    seedRuntime('p1', 'old-img');
    const driver = new FakeDeploymentDriver({
      db,
      hooks: { runLiveMigrations: (call) => { requestDeploymentCancel(db, call.args.deploymentId); } },
    });
    const final = await runDeploymentPipeline(db, driver, {
      projectId: 'p1', target: 'oracle', verificationGate: gateOk,
    });
    // La sección crítica no se abandona: promoción segura completada.
    expect(final.status).toBe('live');
    expect(final.cancelRequested).toBe(true);
    expect(getProjectRuntime(db, 'p1')!.liveImage).toBe(final.candidateId);
  });

  it('rolls back on failure even with cancel requested', async () => {
    addProject('p1');
    seedRuntime('p1', 'old-img');
    const driver = new FakeDeploymentDriver({
      db,
      hooks: { runLiveMigrations: (call) => { requestDeploymentCancel(db, call.args.deploymentId); } },
      decide: failFirstLiveHealth(),
    });
    const final = await runDeploymentPipeline(db, driver, {
      projectId: 'p1', target: 'oracle', verificationGate: gateOk,
    });
    expect(final.status).toBe('rolled_back');
    expect(getProjectRuntime(db, 'p1')!.liveImage).toBe('old-img');
  });
});

// ---------------------------------------------------------------------------
// Criterio 15 — recuperación tras reinicio
// ---------------------------------------------------------------------------

describe('restart recovery (criterio 15)', () => {
  function seedDeployment(id: string, projectId: string, status: string): void {
    const now = nowIso();
    db.prepare(
      `INSERT INTO deployments(id, project_id, target, status, url, created_at, logs, candidate_id,
        previous_live_version, backup_id, cancel_requested, started_at, updated_at, finished_at, error)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, projectId, 'oracle', status, null, now, '', null, null, null, 0, now, now, null, null);
  }

  it('marks non-terminal deployments failed and reconciles the driver', async () => {
    for (const [id, pid, st] of [
      ['d1', 'p1', 'pending'],
      ['d2', 'p2', 'building'],
      ['d3', 'p3', 'verifying'],
      ['d4', 'p4', 'promoting'],
      ['d5', 'p5', 'live'],
    ] as const) {
      addProject(pid);
      seedDeployment(id, pid, st);
    }
    const driver = new FakeDeploymentDriver({ db });
    const n = await reconcileDeployments(db, driver);
    expect(n).toBe(4);
    for (const id of ['d1', 'd2', 'd3', 'd4']) {
      const dep = getDeployment(db, id)!;
      expect(dep.status).toBe('failed');
      expect(dep.error).toBe('interrupted by server restart');
      expect(dep.finishedAt).not.toBeNull();
    }
    expect(getDeployment(db, 'd5')!.status).toBe('live');
    expect(driver.callsOf('reconcileRuntime').length).toBe(4);
    // Los eventos conservan el diagnóstico.
    const events = listDeploymentEvents(db, 'd3');
    expect(events.some((e) => e.event === 'restart_recovery')).toBe(true);
  });

  it('works without a driver (Fase 6: no real driver configured)', async () => {
    addProject('p1');
    seedDeployment('d1', 'p1', 'migrating');
    const n = await reconcileDeployments(db);
    expect(n).toBe(1);
    expect(getDeployment(db, 'd1')!.status).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// Criterio 16 — runtime solo tras health live
// ---------------------------------------------------------------------------

describe('runtime updated only after live health (criterio 16)', () => {
  it('does not point at the candidate mid-promotion', async () => {
    addProject('p1');
    seedRuntime('p1', 'old-img');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const driver = new FakeDeploymentDriver({
      db,
      gates: { startCandidateAsLive: () => gate },
      decide: failFirstLiveHealth(),
    });
    const running = runDeploymentPipeline(db, driver, {
      projectId: 'p1', target: 'oracle', verificationGate: gateOk,
    });
    // Esperar a que el pipeline llegue a startCandidateAsLive (sección crítica).
    for (let i = 0; i < 200 && driver.callsOf('startCandidateAsLive').length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(driver.callsOf('startCandidateAsLive').length).toBe(1);
    expect(getProjectRuntime(db, 'p1')!.liveImage).toBe('old-img');
    release();
    const final = await running;
    expect(final.status).toBe('rolled_back');
    expect(getProjectRuntime(db, 'p1')!.liveImage).toBe('old-img');
  });
});

// ---------------------------------------------------------------------------
// Criterio 17 — logs sanitizados, limitados y ordenados
// ---------------------------------------------------------------------------

describe('logs are sanitized, capped and ordered (criterio 17)', () => {
  it('sanitizes secrets and truncates per-event output with a marker', async () => {
    addProject('p1');
    const secret = 's3cr3t-p4ssw0rd-value';
    const driver = new FakeDeploymentDriver({
      db,
      outputOverride: { buildCandidate: `building with password=${secret}\n` + 'x'.repeat(10_000) },
    });
    const final = await runDeploymentPipeline(db, driver, {
      projectId: 'p1', target: 'oracle', verificationGate: gateOk,
    });
    expect(final.status).toBe('live');
    const events = listDeploymentEvents(db, final.id);
    const buildEvent = events.find((e) => e.event === 'buildCandidate')!;
    expect(buildEvent.output).not.toContain(secret);
    expect(buildEvent.output).toContain('[redacted]');
    expect(buildEvent.output!.length).toBeLessThanOrEqual(MAX_EVENT_OUTPUT_CHARS + 80);
    expect(buildEvent.output).toContain('output truncated');
    // Orden exacto por seq.
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
  });

  it('caps deployments.logs with an explicit truncation marker', () => {
    addProject('p1');
    const dep = createDeployment(db, { projectId: 'p1', target: 'oracle' });
    for (let i = 0; i < 1200; i++) {
      recordEvent(db, dep.id, { phase: 'building', event: `op-${i}`, output: 'y'.repeat(300) });
    }
    const row = getDeployment(db, dep.id)!;
    expect(row.logs!.length).toBeLessThanOrEqual(MAX_DEPLOYMENT_LOGS_CHARS + 80);
    expect(row.logs).toContain(`deployment logs truncated at ${MAX_DEPLOYMENT_LOGS_CHARS} chars`);
  });
});

// ---------------------------------------------------------------------------
// Criterios 18–19 — validación de precondiciones
// ---------------------------------------------------------------------------

describe('precondition validation (criterios 18–19)', () => {
  it('rejects static projects (criterio 18)', async () => {
    addProject('ps', 'static');
    const driver = new FakeDeploymentDriver({ db });
    await expect(
      runDeploymentPipeline(db, driver, { projectId: 'ps', target: 'oracle', verificationGate: gateOk }),
    ).rejects.toMatchObject({ code: 'INVALID_TYPE' });
    expect(db.prepare('SELECT COUNT(*) AS c FROM deployments').get() as { c: number }).toMatchObject({ c: 0 });
  });

  it('rejects unsupported targets without doing any work (criterio 19)', async () => {
    addProject('p1');
    const driver = new FakeDeploymentDriver({ db });
    await expect(
      runDeploymentPipeline(db, driver, { projectId: 'p1', target: 'vercel', verificationGate: gateOk }),
    ).rejects.toMatchObject({ code: 'INVALID_TARGET' });
    expect(driver.calls.length).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS c FROM deployments').get() as { c: number }).toMatchObject({ c: 0 });
  });

  it('rejects missing projects', async () => {
    const driver = new FakeDeploymentDriver({ db });
    await expect(
      runDeploymentPipeline(db, driver, { projectId: 'nope', target: 'oracle', verificationGate: gateOk }),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
  });

  it('rejects when the verification gate is not current', async () => {
    addProject('p1');
    const driver = new FakeDeploymentDriver({ db });
    await expect(
      runDeploymentPipeline(db, driver, {
        projectId: 'p1', target: 'oracle', verificationGate: () => ({ ok: false, reason: 'stale' }),
      }),
    ).rejects.toMatchObject({ code: 'VERIFICATION_GATE' });
    expect(driver.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Criterio 20 — el tool rechaza sin driver real
// ---------------------------------------------------------------------------

describe('deploy_project tool (criterio 20)', () => {
  function toolCtx(projectId: string, driver?: FakeDeploymentDriver) {
    return {
      db,
      projectId,
      projectDir: dir,
      frontendDir: dir,
      cmdTimeoutMs: 1000,
      buildTimeoutMs: 1000,
      deploymentDriver: driver,
    };
  }

  it('refuses without a configured driver (never simulates a deployment)', async () => {
    addProject('p1');
    const tools = createDynamicTools();
    const r = await tools.deploy_project(toolCtx('p1'), {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe('DEPLOYMENT_DRIVER_NOT_CONFIGURED');
    expect(db.prepare('SELECT COUNT(*) AS c FROM deployments').get() as { c: number }).toMatchObject({ c: 0 });
  });

  it('rejects free-form arguments', async () => {
    addProject('p1');
    const tools = createDynamicTools();
    const r = await tools.deploy_project(toolCtx('p1', new FakeDeploymentDriver({ db })), { image: 'evil' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('INVALID_ARGS');
  });

  it('is only for dynamic projects', async () => {
    addProject('ps', 'static');
    const tools = createDynamicTools();
    const r = await tools.deploy_project(toolCtx('ps', new FakeDeploymentDriver({ db })), {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe('INVALID_TYPE');
  });
});

// ---------------------------------------------------------------------------
// Criterio 21 — sin Docker, shell ni red
// ---------------------------------------------------------------------------

describe('no docker, shell or network (criterio 21)', () => {
  it('the deploy module never shells out, dials out or touches Docker', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const files = ['stateMachine.ts', 'driver.ts', 'orchestrator.ts'].map((f) =>
      fs.readFileSync(path.join(here, f), 'utf8'),
    );
    const forbidden = [
      'child_process',
      'docker.sock',
      'eval(',
      'new Function(',
      'execSync',
      'spawn(',
      'fetch(',
      'axios',
    ];
    for (const src of files) {
      for (const token of forbidden) {
        expect(src, `forbidden token '${token}'`).not.toContain(token);
      }
    }
    // El fake es la única implementación del driver exportada.
    expect(FakeDeploymentDriver.name).toBe('FakeDeploymentDriver');
  });

  it('does not export a DockerDeploymentDriver', async () => {
    const worker = await import('../index.js');
    expect('DockerDeploymentDriver' in worker).toBe(false);
    expect(worker.FakeDeploymentDriver).toBe(FakeDeploymentDriver);
  });

  it('driver args reject commands, paths and container names', async () => {
    const { assertDriverArgs } = await import('./driver.js');
    expect(() =>
      assertDriverArgs({ deploymentId: 'd1', projectId: 'p1', candidateId: 'docker run evil' }),
    ).toThrow(/invalid driver argument/);
    expect(() =>
      assertDriverArgs({ deploymentId: 'd1', projectId: 'p1', candidateId: '../../etc/passwd' }),
    ).toThrow(/invalid driver argument/);
    expect(() =>
      assertDriverArgs({ deploymentId: 'd1', projectId: 'p1', candidateId: '' }),
    ).toThrow(/invalid driver argument/);
  });
});

// ---------------------------------------------------------------------------
// Validación de argumentos del driver / resultados
// ---------------------------------------------------------------------------

describe('fake driver configuration', () => {
  it('supports per-op timeout behavior', async () => {
    addProject('p1');
    const driver = new FakeDeploymentDriver({ db, behavior: { buildCandidate: 'timeout' } });
    const final = await runDeploymentPipeline(db, driver, {
      projectId: 'p1', target: 'oracle', verificationGate: gateOk,
    });
    expect(final.status).toBe('failed');
    expect(final.error).toMatch(/OPERATION_TIMEOUT/);
  });

  it('exposes cancel_requested reads without mutating state', () => {
    addProject('p1');
    const dep = createDeployment(db, { projectId: 'p1', target: 'oracle' });
    expect(isDeploymentCancelRequested(db, dep.id)).toBe(false);
    requestDeploymentCancel(db, dep.id);
    expect(isDeploymentCancelRequested(db, dep.id)).toBe(true);
    // El fake nunca escribe en deployments: solo lectura de observación.
    const calls = new FakeDeploymentDriver({ db }).calls;
    expect(calls.length).toBe(0);
  });
});
