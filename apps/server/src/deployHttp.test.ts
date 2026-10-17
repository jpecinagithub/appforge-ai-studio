/**
 * Fase 6 — tests HTTP del pipeline de despliegue.
 *
 * Criterios cubiertos aquí:
 *  1: POST /deploy → 202 y pipeline completo hasta live (vía fake).
 *  4: dos solicitudes simultáneas → una crea, la otra 409.
 * 13: cancelación vía POST /cancel → cancelled + limpieza.
 * 15: reconciliación tras reinicio (deployments + migrations).
 * 18: proyecto static → 400 INVALID_TYPE.
 * 19: target no soportado → 400 INVALID_TARGET.
 * 20: sin driver configurado → 501 estable, sin simular nada.
 * Además: GET deployments / GET deployment / GET runtime y la puerta de
 * verificación persistida (409 VERIFICATION_GATE sin evidencias).
 *
 * Ningún test necesita Docker, Oracle ni red externa.
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
  buildServer,
  reconcileInterruptedMigrations,
} from './index.js';
import {
  FakeDeploymentDriver,
  getDeployment,
  reconcileDeployments,
  DYNAMIC_CHECK_ORDER,
  checkScopeFingerprint,
  persistedDynamicGateStatus,
  recordDynamicCheckForTest,
  recordVerificationReceipt,
  type DeploymentRecord,
  type DynamicCheckKey,
  type ToolContext,
} from 'appforge-worker';
import { nowIso } from 'appforge-worker';
import { projectDir } from './projects.js';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.resolve(SRC_DIR, '..', '..', '..', 'templates');

let db: Database.Database;
let app: FastifyInstance;
let dataDir: string;

function addProject(id: string, type: 'dynamic' | 'static' = 'dynamic'): void {
  const now = nowIso();
  db.prepare('INSERT INTO projects(id, name, type, status, created_at, updated_at) VALUES (?,?,?,?,?,?)').run(
    id, `P-${id}`, type, 'active', now, now,
  );
}

/** Receipts persistidos autoritativos (revisión Codex, bloqueo 2): los seis checks. */
function seedVerificationReceipts(projectId: string, skip?: DynamicCheckKey): void {
  const dir = projectDir(dataDir, projectId);
  fs.mkdirSync(dir, { recursive: true });
  DYNAMIC_CHECK_ORDER.forEach((key, i) => {
    if (key === skip) return;
    recordVerificationReceipt(db, projectId, key, checkScopeFingerprint(dir, key) ?? 'missing', i);
  });
  // Sanity: la puerta debe estar vigente salvo que se pida lo contrario.
  if (!skip) expect(persistedDynamicGateStatus(db, dir, projectId).ok).toBe(true);
}

/** Evidencia LEGACY (builds/migraciones): ya NO abre la puerta (bloqueo 2). */
function seedLegacyEvidence(projectId: string): void {
  const now = nowIso();
  db.prepare(
    "INSERT INTO builds(id, project_id, status, started_at, finished_at, duration_ms, logs, artifacts_json, error) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(`b-${projectId}`, projectId, 'success', now, now, 1000, 'ok', null, null);
  db.prepare(
    "INSERT INTO migrations(id, project_id, version, name, status, started_at, finished_at, duration_ms, logs, error) VALUES (?,?,?,?,?,?,?,?,?,?)",
  ).run(`m-${projectId}`, projectId, 1, '001_init.sql', 'success', now, now, 10, 'ok', null);
}

async function buildApp(driver?: FakeDeploymentDriver): Promise<FastifyInstance> {
  const a = buildServer({ db, dataDir, templatesDir: TEMPLATES_DIR, deploymentDriver: driver });
  await a.ready();
  return a;
}

async function waitForTerminal(
  client: FastifyInstance,
  deploymentId: string,
  timeoutMs = 20000,
): Promise<DeploymentRecord & Record<string, unknown>> {
  const t0 = Date.now();
  for (;;) {
    const res = await client.inject({ method: 'GET', url: `/api/deployments/${deploymentId}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string };
    if (['live', 'failed', 'rolled_back', 'cancelled'].includes(body.status)) {
      return body as DeploymentRecord & Record<string, unknown>;
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for terminal state (last=${body.status})`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function waitForStatus(
  client: FastifyInstance,
  deploymentId: string,
  status: string,
  timeoutMs = 20000,
): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const res = await client.inject({ method: 'GET', url: `/api/deployments/${deploymentId}` });
    const body = res.json() as { status: string };
    if (body.status === status) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for status=${status} (last=${body.status})`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-deployhttp-test-'));
  db = openDb(dataDir);
  app = await buildApp(new FakeDeploymentDriver({ db }));
});

afterAll(async () => {
  await app.close();
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('POST /api/projects/:id/deploy (criterios 1, 18, 19, 20)', () => {
  it('starts the pipeline (202) and reaches live (criterio 1)', async () => {
    addProject('h1');
    seedVerificationReceipts('h1');
    const res = await app.inject({ method: 'POST', url: '/api/projects/h1/deploy', payload: { target: 'oracle' } });
    expect(res.statusCode).toBe(202);
    const created = res.json() as { id: string; status: string; target: string };
    expect(created.status).toBe('pending');
    expect(created.target).toBe('oracle');
    const final = await waitForTerminal(app, created.id);
    expect(final.status).toBe('live');
    // GET runtime refleja el live tras el health correcto.
    const rt = await app.inject({ method: 'GET', url: '/api/projects/h1/runtime' });
    expect(rt.statusCode).toBe(200);
    expect((rt.json() as { liveImage: string }).liveImage).toBe(final.candidateId);
  });

  it('rejects static projects with 400 INVALID_TYPE (criterio 18)', async () => {
    addProject('hs', 'static');
    const res = await app.inject({ method: 'POST', url: '/api/projects/hs/deploy', payload: { target: 'oracle' } });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('INVALID_TYPE');
  });

  it('rejects unsupported targets with 400 INVALID_TARGET (criterio 19)', async () => {
    addProject('ht');
    const res = await app.inject({ method: 'POST', url: '/api/projects/ht/deploy', payload: { target: 'vercel' } });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('INVALID_TARGET');
    expect(db.prepare('SELECT COUNT(*) AS c FROM deployments WHERE project_id=?').get('ht') as { c: number }).toMatchObject({ c: 0 });
  });

  it('returns 404 for missing projects', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/projects/nope/deploy', payload: { target: 'oracle' } });
    expect(res.statusCode).toBe(404);
  });

  it('requires the verification gate evidence (409 VERIFICATION_GATE)', async () => {
    addProject('hg'); // sin receipts: la puerta no está vigente
    const res = await app.inject({ method: 'POST', url: '/api/projects/hg/deploy', payload: { target: 'oracle' } });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('VERIFICATION_GATE');
  });

  it('legacy evidence (builds/migrations rows) no longer opens the gate (bloqueo 2)', async () => {
    addProject('hl');
    seedLegacyEvidence('hl'); // la aproximación antigua ya no basta
    const res = await app.inject({ method: 'POST', url: '/api/projects/hl/deploy', payload: { target: 'oracle' } });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('VERIFICATION_GATE');
  });

  it('five of six receipts → 409 VERIFICATION_GATE (bloqueo 2)', async () => {
    addProject('h5');
    seedVerificationReceipts('h5', 'authenticatedFlow');
    const res = await app.inject({ method: 'POST', url: '/api/projects/h5/deploy', payload: { target: 'oracle' } });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('VERIFICATION_GATE');
    expect(body.error.message).toMatch(/authenticatedFlow/);
  });

  it('stale receipt after a source change → 409 VERIFICATION_GATE (bloqueo 2)', async () => {
    addProject('hst');
    seedVerificationReceipts('hst');
    fs.writeFileSync(path.join(projectDir(dataDir, 'hst'), 'changed.txt'), 'v2');
    const res = await app.inject({ method: 'POST', url: '/api/projects/hst/deploy', payload: { target: 'oracle' } });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('VERIFICATION_GATE');
  });

  it('driver error secrets are sanitized in the HTTP response (bloqueo 3)', async () => {
    const leaky = new FakeDeploymentDriver({
      db,
      behavior: { buildCandidate: 'fail' },
      failError: {
        buildCandidate: 'boom: password=httpsecret9 Authorization: Bearer httpbearertoken9 Cookie: af_session=httpsession9',
      },
    });
    const leakyApp = await buildApp(leaky);
    try {
      addProject('hsec');
      seedVerificationReceipts('hsec');
      const started = await leakyApp.inject({ method: 'POST', url: '/api/projects/hsec/deploy', payload: { target: 'oracle' } });
      expect(started.statusCode).toBe(202);
      const created = started.json() as { id: string };
      const final = await waitForTerminal(leakyApp, created.id);
      expect(final.status).toBe('failed');
      const raw = JSON.stringify(final);
      for (const s of ['httpsecret9', 'httpbearertoken9', 'httpsession9']) {
        expect(raw).not.toContain(s);
      }
      expect((final.error as string) ?? '').toContain('[redacted]');
    } finally {
      await leakyApp.close();
    }
  });

  it('without a driver: 501 stable and nothing simulated (criterio 20)', async () => {    const plain = await buildApp(undefined);
    try {
      const res = await plain.inject({ method: 'POST', url: '/api/projects/h1/deploy', payload: { target: 'oracle' } });
      expect(res.statusCode).toBe(501);
      expect((res.json() as { error: { code: string } }).error.code).toBe('DEPLOYMENT_DRIVER_NOT_CONFIGURED');
      // Sin simular: no se crea ningún deployment nuevo para este proyecto
      // (h1 ya tiene uno terminal del test anterior; no hay activos).
      const list = await plain.inject({ method: 'GET', url: '/api/projects/h1/deployments' });
      const items = (list.json() as { items: Array<{ status: string }> }).items;
      expect(items.every((d) => ['live', 'failed', 'rolled_back', 'cancelled'].includes(d.status))).toBe(true);
    } finally {
      await plain.close();
    }
  });
});

describe('concurrent deploys (criterio 4)', () => {
  it('only one of two simultaneous requests creates a deployment', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const gated = new FakeDeploymentDriver({ db, gates: { buildCandidate: () => gate } });
    const gatedApp = await buildApp(gated);
    try {
      addProject('hc');
      seedVerificationReceipts('hc');
      const first = await gatedApp.inject({ method: 'POST', url: '/api/projects/hc/deploy', payload: { target: 'oracle' } });
      expect(first.statusCode).toBe(202);
      const created = first.json() as { id: string };
      await waitForStatus(gatedApp, created.id, 'building');
      const second = await gatedApp.inject({ method: 'POST', url: '/api/projects/hc/deploy', payload: { target: 'oracle' } });
      expect(second.statusCode).toBe(409);
      expect((second.json() as { error: { code: string } }).error.code).toBe('DEPLOYMENT_ACTIVE');
      release();
      const final = await waitForTerminal(gatedApp, created.id);
      expect(final.status).toBe('live');
    } finally {
      release();
      await gatedApp.close();
    }
  });

  it('applies the 7B driver capacity across different projects before creating work', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const limited = new FakeDeploymentDriver({ db, gates: { buildCandidate: () => gate } }) as
      FakeDeploymentDriver & { maxConcurrentDeploys: number };
    limited.maxConcurrentDeploys = 1;
    const limitedApp = await buildApp(limited);
    try {
      addProject('capacity-a');
      addProject('capacity-b');
      seedVerificationReceipts('capacity-a');
      seedVerificationReceipts('capacity-b');
      const first = await limitedApp.inject({ method: 'POST', url: '/api/projects/capacity-a/deploy', payload: { target: 'oracle' } });
      expect(first.statusCode).toBe(202);
      await waitForStatus(limitedApp, (first.json() as { id: string }).id, 'building');
      const second = await limitedApp.inject({ method: 'POST', url: '/api/projects/capacity-b/deploy', payload: { target: 'oracle' } });
      expect(second.statusCode).toBe(409);
      expect((second.json() as { error: { code: string } }).error.code).toBe('DEPLOYMENT_CAPACITY');
      const rows = db.prepare('SELECT COUNT(*) AS n FROM deployments WHERE project_id=?').get('capacity-b') as { n: number };
      expect(rows.n).toBe(0);
      release();
      await waitForTerminal(limitedApp, (first.json() as { id: string }).id);
    } finally {
      release();
      await limitedApp.close();
    }
  });
});

describe('deployment queries and cancel (criterio 13)', () => {
  it('lists deployments, gets one, and cancels it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const driver = new FakeDeploymentDriver({ db, gates: { buildCandidate: () => gate } });
    const gatedApp = await buildApp(driver);
    try {
      addProject('hx');
      seedVerificationReceipts('hx');
      const started = await gatedApp.inject({ method: 'POST', url: '/api/projects/hx/deploy', payload: { target: 'oracle' } });
      expect(started.statusCode).toBe(202);
      const created = started.json() as { id: string };
      await waitForStatus(gatedApp, created.id, 'building');

      const list = await gatedApp.inject({ method: 'GET', url: '/api/projects/hx/deployments' });
      expect(list.statusCode).toBe(200);
      expect(((list.json() as { items: unknown[] }).items.length)).toBeGreaterThanOrEqual(1);

      const one = await gatedApp.inject({ method: 'GET', url: `/api/deployments/${created.id}` });
      expect(one.statusCode).toBe(200);
      expect((one.json() as { id: string }).id).toBe(created.id);

      const missing = await gatedApp.inject({ method: 'GET', url: '/api/deployments/does-not-exist' });
      expect(missing.statusCode).toBe(404);
      expect((missing.json() as { error: { code: string } }).error.code).toBe('DEPLOYMENT_NOT_FOUND');

      // Cancelar: flag persistente; al liberar, el pipeline termina en cancelled.
      const cancel = await gatedApp.inject({ method: 'POST', url: `/api/deployments/${created.id}/cancel` });
      expect(cancel.statusCode).toBe(200);
      expect((cancel.json() as { cancelRequested: boolean }).cancelRequested).toBe(true);
      const cancelMissing = await gatedApp.inject({ method: 'POST', url: '/api/deployments/does-not-exist/cancel' });
      expect(cancelMissing.statusCode).toBe(404);

      release();
      const final = await waitForTerminal(gatedApp, created.id);
      expect(final.status).toBe('cancelled');
      // Limpieza ejecutada: el candidato se eliminó.
      expect(driver.callsOf('discardCandidate').length).toBe(1);
    } finally {
      release();
      await gatedApp.close();
    }
  });

  it('runtime is 404 before the first deployment', async () => {
    addProject('hr');
    const res = await app.inject({ method: 'GET', url: '/api/projects/hr/runtime' });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe('RUNTIME_NOT_FOUND');
  });
});

describe('restart recovery (criterio 15)', () => {
  it('fails non-terminal deployments, reconciles the driver, fails stuck migrations', async () => {
    const now = nowIso();
    for (const [id, pid, st] of [
      ['r1', 'rp1', 'pending'],
      ['r2', 'rp2', 'migrating'],
      ['r3', 'rp3', 'promoting'],
      ['r4', 'rp4', 'live'],
    ] as const) {
      db.prepare('INSERT INTO projects(id, name, type, status, created_at, updated_at) VALUES (?,?,?,?,?,?)').run(
        pid, pid, 'dynamic', 'active', now, now,
      );
      db.prepare(
        `INSERT INTO deployments(id, project_id, target, status, url, created_at, logs, candidate_id,
          previous_live_version, backup_id, cancel_requested, started_at, updated_at, finished_at, error)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(id, pid, 'oracle', st, null, now, '', null, null, null, 0, now, now, null, null);
    }
    db.prepare(
      "INSERT INTO migrations(id, project_id, version, name, status, started_at, finished_at, duration_ms, logs, error) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).run('rm1', 'rp2', 1, '001.sql', 'running', now, null, null, '', null);

    const driver = new FakeDeploymentDriver({ db });
    const n = await reconcileDeployments(db, driver);
    expect(n).toBe(3);
    for (const id of ['r1', 'r2', 'r3']) {
      const dep = getDeployment(db, id)!;
      expect(dep.status).toBe('failed');
      expect(dep.error).toBe('interrupted by server restart');
    }
    expect(getDeployment(db, 'r4')!.status).toBe('live');
    expect(driver.callsOf('reconcileRuntime').length).toBe(3);

    const m = reconcileInterruptedMigrations(db);
    expect(m).toBe(1);
    const mig = db.prepare('SELECT status FROM migrations WHERE id=?').get('rm1') as { status: string };
    expect(mig.status).toBe('failed');
  });
});
