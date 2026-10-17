/**
 * Fase 7A — Tests de integración Docker (§15).
 *
 * Puerta: `APPFORGE_DOCKER_INTEGRATION=1` (local: solo lo que no necesita
 * imágenes) o `=strict` (CI: todo debe poder correr; si la imagen base no
 * está disponible tras intentar pull, la suite FALLA en vez de saltar).
 * Sin la variable, toda la suite se salta (no rompe `npm run verify`).
 *
 * Recursos canarios: todo lo creado lleva `com.appforge.test-run=<RUN_ID>`
 * (red de test propia `--internal`, nunca el bridge por defecto) y se
 * elimina en `afterAll` pase lo que pase.
 *
 * Limitación honesta: el daemon local de esta VM no puede hacer pull
 * (egress bloqueado); las secciones que necesitan `node:24-slim` quedan
 * implementadas y se ejecutan en el job de CI.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DockerCommandRunner } from './commandRunner.js';
import {
  DockerDeploymentDriver,
  preflightDocker,
  type DockerDriverConfig,
} from './dockerDriver.js';
import {
  resourceNames,
  listManagedResources,
  inspectResource,
  resourceExists,
  MANAGED_LABEL,
} from './resources.js';
import { createSnapshot } from './snapshot.js';
import { sourceFingerprint } from '../fingerprint.js';
import { isValidBackupId } from './sqliteBackup.js';
import { DYNAMIC_CHECK_ORDER, checkScopeFingerprint, type DynamicCheckKey } from '../dynamicTools.js';
import { recordVerificationReceipt } from '../deploy/receipts.js';
import type { DriverResult } from '../deploy/driver.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..', '..');
const TEMPLATE = path.join(REPO, 'templates', 'dynamic-react-node');

const MODE = process.env.APPFORGE_DOCKER_INTEGRATION;
const ENABLED = MODE === '1' || MODE === 'strict';
const STRICT = MODE === 'strict';
const RUN_ID = (process.env.APPFORGE_TEST_RUN_ID ?? `local-${Date.now().toString(36)}`)
  .replace(/[^A-Za-z0-9_-]/g, '')
  .slice(0, 24);
const BASE_IMAGE = 'node:24-slim';
const TEST_LABEL = 'com.appforge.test-run';

const d = ENABLED ? describe : describe.skip;

function okRes(r: DriverResult): void {
  expect(r.ok, `expected ok, got ${r.code}: ${(r.error ?? '').slice(0, 300)}`).toBe(true);
}

/**
 * Registra los SEIS receipts canónicos reales sobre las fuentes actuales
 * (misma semántica que `recordDynamicCheck` de Fase 6). Tras mutar fuentes,
 * llamar de nuevo para re-verificar.
 */
function recordSixReceipts(db: Database.Database, projectId: string, projectDir: string): void {
  DYNAMIC_CHECK_ORDER.forEach((key: DynamicCheckKey, idx: number) => {
    const fp = checkScopeFingerprint(projectDir, key);
    expect(fp, `no scope fingerprint for ${key}`).toBeTruthy();
    recordVerificationReceipt(db, projectId, key, fp!, idx);
  });
}

interface Harness {
  dataDir: string;
  projectId: string;
  deploymentId: string;
  candidateId: string;
  projectDir: string;
  db: DatabaseSync;
  driver: DockerDeploymentDriver;
  runner: DockerCommandRunner;
  cfg: DockerDriverConfig;
  args: { deploymentId: string; projectId: string; candidateId: string };
  names: ReturnType<typeof resourceNames>;
}

d('docker integration (fase 7A)', () => {
  let runner!: DockerCommandRunner;
  let testNet!: string;
  let dataVol!: string;
  let baseDir!: string;
  let haveImage = false;
  let haveNetwork = false;
  let preflightDiagnostics: string[] = [];
  const harnesses: Harness[] = [];
  /** Imágenes construidas por los tests (sin TEST_LABEL): rmi explícito. */
  const builtImages = new Set<string>();

  /** Red/volumen/nombres de test, etiquetados con el run id. */
  beforeAll(async () => {
    runner = new DockerCommandRunner();
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-it-base-'));
    testNet = `af-test-net-${RUN_ID}`;
    dataVol = `af-test-data-${RUN_ID}`;

    // Disponibilidad de la imagen base (intento de pull solo en CI).
    const insp = await runner.run({ args: ['inspect', BASE_IMAGE], timeoutMs: 20_000 });
    if (insp.code === 0) {
      haveImage = true;
    } else if (STRICT) {
      const pull = await runner.run({ args: ['pull', BASE_IMAGE], timeoutMs: 180_000 });
      haveImage = pull.code === 0;
    }
    if (!haveImage && STRICT) {
      throw new Error(`strict mode: base image '${BASE_IMAGE}' unavailable and pull failed`);
    }

    // Preflight: en CI debe pasar; en la VM local el kernel no soporta
    // bridges (no se pueden crear redes) → se valida el diagnóstico y se
    // sigue con las secciones que no necesitan red.
    const cfg: DockerDriverConfig = {
      dataDir: baseDir,
      network: testNet,
      dataVolume: dataVol,
      maxConcurrentDeploys: 2,
      dockerBin: 'docker',
      socketPath: '/var/run/docker.sock',
      minDockerVersion: '24.0.0',
    };
    const pf = await preflightDocker(runner, cfg);
    preflightDiagnostics = pf.diagnostics;
    if (pf.ok) {
      haveNetwork = true;
    } else if (/cannot create docker network/.test(pf.diagnostics.join(' '))) {
      haveNetwork = false;
      if (STRICT) {
        throw new Error(`strict mode: preflight must pass in CI: ${pf.diagnostics.join(' | ')}`);
      }
    } else {
      throw new Error(`preflight failed unexpectedly: ${pf.diagnostics.join(' | ')}`);
    }

    if (haveNetwork) {
      // Etiqueta canaria en la red de test (preflight la crea managed).
      await runner.run({
        args: ['network', 'create', '--internal', '--label', `${MANAGED_LABEL}=true`, '--label', `${TEST_LABEL}=${RUN_ID}`, testNet],
        timeoutMs: 20_000,
      }).catch(() => undefined);
      const ninfo = (await inspectResource(runner, 'network', testNet)) as {
        Internal?: boolean;
        Labels?: Record<string, string>;
      };
      expect(ninfo.Internal).toBe(true);
    }
  }, 240_000);

  afterAll(async () => {
    // Limpieza canaria: todo lo del run, en orden inverso de dependencia.
    const labelFilter = ['--filter', `label=${TEST_LABEL}=${RUN_ID}`];
    try {
      const ps = await runner.run({ args: ['ps', '-a', '--format', '{{.ID}}', ...labelFilter], timeoutMs: 30_000 });
      for (const id of ps.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
        await runner.run({ args: ['rm', '-f', id], timeoutMs: 60_000 }).catch(() => undefined);
      }
      const vols = await runner.run({ args: ['volume', 'ls', '--format', '{{.Name}}', ...labelFilter], timeoutMs: 30_000 });
      for (const v of vols.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
        await runner.run({ args: ['volume', 'rm', v], timeoutMs: 60_000 }).catch(() => undefined);
      }
      const imgs = await runner.run({ args: ['images', '--format', '{{.ID}}', ...labelFilter], timeoutMs: 30_000 });
      for (const id of imgs.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
        await runner.run({ args: ['rmi', '-f', id], timeoutMs: 120_000 }).catch(() => undefined);
      }
      for (const ref of builtImages) {
        await runner.run({ args: ['rmi', '-f', ref], timeoutMs: 120_000 }).catch(() => undefined);
      }
      await runner.run({ args: ['network', 'rm', testNet], timeoutMs: 30_000 }).catch(() => undefined);
      await runner.run({ args: ['volume', 'rm', dataVol], timeoutMs: 30_000 }).catch(() => undefined);
    } finally {
      for (const h of harnesses) {
        try { h.db.close(); } catch { /* noop */ }
        fs.rmSync(h.dataDir, { recursive: true, force: true });
      }
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  }, 240_000);

  /** Crea un proyecto de test a partir de la plantilla real. */
  async function makeHarness(opts: { brokenMigration?: boolean } = {}): Promise<Harness> {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-it-'));
    const projectId = randomUUID();
    const deploymentId = randomUUID();
    const candidateId = `cand-${randomUUID().slice(0, 8)}`;
    const projectDir = path.join(dataDir, 'projects', projectId);
    fs.cpSync(TEMPLATE, projectDir, { recursive: true });
    if (opts.brokenMigration) {
      fs.writeFileSync(path.join(projectDir, 'migrations', '002_broken.sql'), 'THIS IS NOT VALID SQL;\n');
    }
    const db = new DatabaseSync(path.join(dataDir, 'studio.db'));
    db.exec('CREATE TABLE deployments(id TEXT PRIMARY KEY)');
    db.exec(`CREATE TABLE IF NOT EXISTS verification_receipts(
       project_id TEXT NOT NULL,
       check_key TEXT NOT NULL,
       fingerprint TEXT NOT NULL,
       seq INTEGER NOT NULL,
       created_at TEXT NOT NULL,
       PRIMARY KEY (project_id, check_key))`);
    db.prepare('INSERT INTO deployments(id) VALUES (?)').run(deploymentId);
    // Seis receipts canónicos reales (Fase 6/7A): la puerta del driver los
    // exige en orden canónico y vigentes sobre las fuentes actuales.
    recordSixReceipts(db as never, projectId, projectDir);
    const cfg: DockerDriverConfig = {
      dataDir,
      network: testNet,
      dataVolume: dataVol,
      maxConcurrentDeploys: 2,
      dockerBin: 'docker',
      socketPath: '/var/run/docker.sock',
      minDockerVersion: '24.0.0',
      templatesDir: path.join(REPO, 'templates'),
    };
    const driver = new DockerDeploymentDriver(cfg, {
      runner,
      db: db as unknown as Database.Database,
    });
    const args = { deploymentId, projectId, candidateId };
    // Nombres esperados (el fingerprint se conoce tras el snapshot; aquí
    // se deriva del snapshot que creará buildCandidate — para asserts
    // previos usamos resourceNames con el fp del snapshot real cuando exista).
    const h: Harness = { dataDir, projectId, deploymentId, candidateId, projectDir, db, driver, runner, cfg, args, names: undefined as never };
    harnesses.push(h);
    return h;
  }

  function snapshotFp(h: Harness): string {
    const m = JSON.parse(
      fs.readFileSync(path.join(h.dataDir, 'deploy-snapshots', h.deploymentId, '.appforge-manifest.json'), 'utf8'),
    ) as { fingerprint: string };
    h.names = resourceNames(h.projectId, h.deploymentId, m.fingerprint);
    return m.fingerprint;
  }

  async function containerIp(name: string): Promise<string> {
    const info = (await inspectResource(runner, 'container', name)) as {
      NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> };
    };
    const ip = info?.NetworkSettings?.Networks?.[testNet]?.IPAddress;
    expect(ip, `no IP for ${name} on ${testNet}`).toBeTruthy();
    return ip!;
  }

  // -- sin imágenes: corre en local ----------------------------------------

  test('preflight: red interna en CI; diagnóstico honesto sin bridge (local)', async () => {
    if (haveNetwork) {
      const vols = await listManagedResources(runner, 'volume');
      expect(vols.some((v) => v.name === dataVol)).toBe(true);
      const nets = await listManagedResources(runner, 'network');
      expect(nets.some((n) => n.name === testNet)).toBe(true);
      const ninfo = (await inspectResource(runner, 'network', testNet)) as { Internal?: boolean };
      expect(ninfo.Internal).toBe(true);
    } else {
      // La VM local no puede crear redes bridge (kernel sin soporte):
      // el preflight debe decirlo, no inventar éxito.
      expect(preflightDiagnostics.join(' ')).toMatch(/cannot create docker network/);
      expect(await resourceExists(runner, 'network', testNet)).toBe(false);
    }
  });

  test('buildCandidate rechaza fuentes cambiadas tras el gate (receipt)', async () => {
    const h = await makeHarness();
    // Sin imagen el build no puede completarse, pero el gate de receipts se
    // evalúa ANTES de cualquier llamada a Docker: con fuentes intactas no
    // debe ser RECEIPT_FINGERPRINT_MISMATCH.
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), haveImage ? 600_000 : 45_000);
    const r1 = await h.driver.buildCandidate({ ...h.args, signal: ctl.signal });
    clearTimeout(to);
    expect(r1.code).not.toMatch(/RECEIPT_GATE_FAILED/);
    if (haveImage) okRes(r1);
    // Manipula las fuentes tras el gate: los receipts quedan stale y la
    // puerta persistida (Fase 6/7A) se cierra antes de tocar Docker.
    fs.appendFileSync(path.join(h.projectDir, 'backend', 'src', 'server.ts'), '\n// tamper\n');
    const dep2 = randomUUID();
    h.db.prepare('INSERT INTO deployments(id) VALUES (?)').run(dep2);
    const r2 = await h.driver.buildCandidate({ ...h.args, deploymentId: dep2 });
    expect(r2.ok).toBe(false);
    expect(r2.code).toBe('RECEIPT_GATE_FAILED');
  }, 700_000);

  test('prepare/discardVerificationDatabase: volumen aislado con labels', async () => {
    const h = await makeHarness();
    createSnapshot({ projectDir: h.projectDir, snapshotsRoot: path.join(h.dataDir, 'deploy-snapshots'), deploymentId: h.deploymentId });
    snapshotFp(h);
    okRes(await h.driver.prepareVerificationDatabase(h.args));
    const info = (await inspectResource(runner, 'volume', h.names.verifyVolume)) as { Labels?: Record<string, string> };
    expect(info.Labels?.[MANAGED_LABEL]).toBe('true');
    expect(info.Labels?.['com.appforge.role']).toBe('verify');
    expect(info.Labels?.[TEST_LABEL]).toBeUndefined(); // labels del driver, no del test
    // Idempotente.
    okRes(await h.driver.prepareVerificationDatabase(h.args));
    okRes(await h.driver.discardVerificationDatabase(h.args));
    expect(await resourceExists(runner, 'volume', h.names.verifyVolume)).toBe(false);
  });

  test('createLiveBackup sin live: backup validado vacío', async () => {
    const h = await makeHarness();
    createSnapshot({ projectDir: h.projectDir, snapshotsRoot: path.join(h.dataDir, 'deploy-snapshots'), deploymentId: h.deploymentId });
    snapshotFp(h);
    const r = await h.driver.createLiveBackup({ ...h.args, previousLiveVersion: null });
    okRes(r);
    expect(isValidBackupId(r.data?.backupId ?? '')).toBe(true);
    expect(r.data?.backupValidated).toBe('true');
    const manifest = JSON.parse(
      fs.readFileSync(path.join(h.dataDir, 'project-backups', h.projectId, r.data!.backupId, 'backup.json'), 'utf8'),
    ) as { hadDatabase: boolean };
    expect(manifest.hadDatabase).toBe(false);
  });

  test('reconcileRuntime sin despliegue: informe de solo lectura', async () => {
    const h = await makeHarness();
    createSnapshot({ projectDir: h.projectDir, snapshotsRoot: path.join(h.dataDir, 'deploy-snapshots'), deploymentId: h.deploymentId });
    snapshotFp(h);
    const r = await h.driver.reconcileRuntime(h.args);
    okRes(r);
    expect(r.data?.liveFound).toBe('false');
    expect(r.data?.liveRunning).toBe('false');
  });

  test('dos proyectos: sin acceso cruzado en volúmenes', async () => {
    const a = await makeHarness();
    const b = await makeHarness();
    for (const h of [a, b]) {
      createSnapshot({ projectDir: h.projectDir, snapshotsRoot: path.join(h.dataDir, 'deploy-snapshots'), deploymentId: h.deploymentId });
      snapshotFp(h);
      okRes(await h.driver.prepareVerificationDatabase(h.args));
    }
    expect(a.names.verifyVolume).not.toBe(b.names.verifyVolume);
    okRes(await a.driver.discardVerificationDatabase(a.args));
    expect(await resourceExists(runner, 'volume', a.names.verifyVolume)).toBe(false);
    expect(await resourceExists(runner, 'volume', b.names.verifyVolume)).toBe(true);
    okRes(await b.driver.discardVerificationDatabase(b.args));
  });

  // -- con imagen: solo CI (haveImage) --------------------------------------
  // Un único harness compartido: el build real se hace UNA vez (D1) y el
  // resto de tests reutilizan la imagen (buildCandidate es idempotente).
  // D2 = despliegue v2 con migración rota. D3 = build abortado.

  let shared: Harness | null = null;
  async function sharedHarness(): Promise<Harness> {
    if (!shared) {
      const h = await makeHarness();
      const b = await h.driver.buildCandidate(h.args);
      okRes(b);
      snapshotFp(h);
      builtImages.add(h.names.image);
      shared = h;
    } else {
      // Revalidar idempotencia en cada uso.
      const b = await shared.driver.buildCandidate(shared.args);
      okRes(b);
    }
    return shared;
  }

  async function httpJsonDirect(
    method: string,
    url: string,
    opts: { body?: unknown; cookie?: string } = {},
  ): Promise<{ status: number; json: unknown; setCookies: string[] }> {
    const headers: Record<string, string> = {};
    if (opts.cookie) headers['cookie'] = opts.cookie;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(url, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(15_000),
      redirect: 'manual',
    });
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* noop */ }
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    return { status: res.status, json, setCookies };
  }

  async function registerAndLogin(
    ip: string,
    email: string,
    password: string,
  ): Promise<string> {
    const reg = await httpJsonDirect('POST', `http://${ip}:8080/api/auth/register`, {
      body: { email, password },
    });
    expect(reg.status).toBe(201);
    const cookie = (reg.setCookies.find((c) => c.startsWith('af_session=')) ?? '').split(';')[0];
    expect(cookie).toBeTruthy();
    return cookie;
  }

  test('build real de la plantilla: imagen etiquetada e idempotente', async () => {
    if (!haveImage) return;
    const h = await sharedHarness();
    expect(await resourceExists(runner, 'image', h.names.image)).toBe(true);
    const info = (await inspectResource(runner, 'image', h.names.image)) as {
      Config?: { Labels?: Record<string, string>; User?: string };
    };
    expect(info.Config?.Labels?.[MANAGED_LABEL]).toBe('true');
    expect(info.Config?.Labels?.['com.appforge.project-id']).toBe(h.projectId);
    expect(info.Config?.Labels?.['com.appforge.deployment-id']).toBe(h.deploymentId);
    expect(info.Config?.Labels?.['com.appforge.role']).toBe('live');
    // El Dockerfile declara `USER appuser` (uid 1001): inspect muestra el
    // nombre. El driver exige no-root (validateImage), no un formato concreto.
    expect(['1001', 'appuser']).toContain(info.Config?.User);
    expect(JSON.stringify(info.Config?.Labels)).not.toContain('docker.sock');
  }, 900_000);

  test('flujo verify completo: migraciones, health y auth con aislamiento A/B', async () => {
    if (!haveImage) return;
    const h = await sharedHarness();
    okRes(await h.driver.prepareVerificationDatabase(h.args));
    okRes(await h.driver.runVerificationMigrations(h.args));
    okRes(await h.driver.startVerificationRuntime(h.args));

    // Endurecimiento inspeccionado directamente (postcondiciones, no fe).
    const vinfo = (await inspectResource(runner, 'container', h.names.verifyContainer)) as {
      Config?: { User?: string };
      Mounts?: Array<{ Type?: string; Source?: string; Destination?: string }>;
      HostConfig?: { ReadonlyRootfs?: boolean; CapDrop?: string[]; Memory?: number; NanoCpus?: number; PidsLimit?: number };
      NetworkSettings?: { Networks?: Record<string, unknown>; Ports?: Record<string, unknown> };
    };
    expect(vinfo.Config?.User).toBe('1001');
    expect(vinfo.HostConfig?.ReadonlyRootfs).toBe(true);
    expect(vinfo.HostConfig?.CapDrop).toContain('ALL');
    expect(vinfo.HostConfig?.Memory).toBe(512 * 1024 * 1024);
    expect(vinfo.HostConfig?.NanoCpus).toBe(1_000_000_000);
    expect(vinfo.HostConfig?.PidsLimit).toBe(128);
    expect(Object.keys(vinfo.NetworkSettings?.Networks ?? {})).toEqual([testNet]);
    expect(Object.keys(vinfo.NetworkSettings?.Ports ?? {})).toEqual([]);
    for (const m of vinfo.Mounts ?? []) {
      expect(m.Source).not.toContain('docker.sock');
      expect(m.Type).not.toBe('bind');
      expect(m.Destination).not.toBe('/var/run/docker.sock');
    }

    const health = await h.driver.runHealthCheck({ ...h.args, runtime: 'verify' });
    okRes(health);
    expect(health.data?.version).toBeTruthy();

    // Flujo autenticado con aislamiento A/B (lo ejecuta el driver).
    okRes(await h.driver.runAuthenticatedVerification(h.args));

    okRes(await h.driver.stopVerificationRuntime(h.args));
    expect(await resourceExists(runner, 'container', h.names.verifyContainer)).toBe(false);
    okRes(await h.driver.discardVerificationDatabase(h.args));
  }, 600_000);

  test('sin egress ni metadata desde la red interna', async () => {
    if (!haveImage) return;
    const h = await sharedHarness();
    const probe = `node -e "Promise.all([
      fetch('http://8.8.8.8/',{signal:AbortSignal.timeout(4000)}).then(()=> 'EGRESS_OK').catch(()=> 'NO_EGRESS'),
      fetch('http://169.254.169.254/',{signal:AbortSignal.timeout(4000)}).then(()=> 'META_OK').catch(()=> 'NO_META'),
    ]).then((r)=>console.log(r.join(' ')))"`;
    const r = await runner.run({
      args: ['run', '--rm', '--network', testNet, '--label', `${TEST_LABEL}=${RUN_ID}`, h.names.image, 'sh', '-c', probe],
      timeoutMs: 60_000,
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('NO_EGRESS');
    expect(r.stdout).toContain('NO_META');
    expect(r.stdout).not.toContain('EGRESS_OK');
    expect(r.stdout).not.toContain('META_OK');
  }, 180_000);

  test('promoción a live: migraciones, arranque, health y volumen etiquetado', async () => {
    if (!haveImage) return;
    const h = await sharedHarness();
    okRes(await h.driver.runLiveMigrations(h.args));
    const vinfo = (await inspectResource(runner, 'volume', h.names.liveVolume)) as { Labels?: Record<string, string> };
    expect(vinfo.Labels?.[MANAGED_LABEL]).toBe('true');
    expect(vinfo.Labels?.['com.appforge.role']).toBe('live');
    okRes(await h.driver.startCandidateAsLive(h.args));
    okRes(await h.driver.runHealthCheck({ ...h.args, runtime: 'live' }));
    const rec = await h.driver.reconcileRuntime(h.args);
    okRes(rec);
    expect(rec.data?.liveFound).toBe('true');
    expect(rec.data?.liveRunning).toBe('true');
    expect(rec.data?.liveImage).toContain(h.names.image);
  }, 600_000);

  test('persistencia tras reinicio del contenedor live', async () => {
    if (!haveImage) return;
    const h = await sharedHarness();
    const ip = await containerIp(h.names.liveContainer);
    const email = `persist-${RUN_ID}@example.com`;
    const cookie = await registerAndLogin(ip, email, 'Persist-1234-xY9!');
    const t1 = await httpJsonDirect('POST', `http://${ip}:8080/api/todos`, {
      body: { title: 'persist-me' }, cookie,
    });
    expect(t1.status).toBe(201);
    const todoId = (t1.json as { id?: string }).id!;
    // Reinicio: stop + start (el runner no expone 'restart' a propósito).
    const st = await runner.run({ args: ['stop', '-t', '10', h.names.liveContainer], timeoutMs: 60_000 });
    expect(st.code).toBe(0);
    const rs = await runner.run({ args: ['start', h.names.liveContainer], timeoutMs: 60_000 });
    expect(rs.code).toBe(0);
    okRes(await h.driver.runHealthCheck({ ...h.args, runtime: 'live' }));
    const ip2 = await containerIp(h.names.liveContainer);
    const cookie2 = await registerAndLogin(ip2, email, 'Persist-1234-xY9!').catch(() =>
      // El usuario ya existe tras el reinicio: login directo.
      httpJsonDirect('POST', `http://${ip2}:8080/api/auth/login`, {
        body: { email, password: 'Persist-1234-xY9!' },
      }).then((r) => {
        expect(r.status).toBe(200);
        return (r.setCookies.find((c) => c.startsWith('af_session=')) ?? '').split(';')[0];
      }),
    );
    const got = await httpJsonDirect('GET', `http://${ip2}:8080/api/todos/${todoId}`, { cookie: cookie2 });
    expect(got.status).toBe(200);
  }, 600_000);

  test('backup con datos, restore verificado y retención', async () => {
    if (!haveImage) return;
    const h = await sharedHarness();
    const ip = await containerIp(h.names.liveContainer);
    const email = `backup-${RUN_ID}@example.com`;
    const cookie = await registerAndLogin(ip, email, 'Backup-1234-xY9!');
    const t1 = await httpJsonDirect('POST', `http://${ip}:8080/api/todos`, { body: { title: 'before-backup' }, cookie });
    const todoId = (t1.json as { id?: string }).id!;

    const bk = await h.driver.createLiveBackup({ ...h.args, previousLiveVersion: null });
    okRes(bk);
    const backupId = bk.data!.backupId;
    expect(isValidBackupId(backupId)).toBe(true);
    expect(bk.data?.backupValidated).toBe('true');
    const manifest = JSON.parse(
      fs.readFileSync(path.join(h.dataDir, 'project-backups', h.projectId, backupId, 'backup.json'), 'utf8'),
    ) as { hadDatabase: boolean; files: Array<{ name: string; sha256: string }> };
    expect(manifest.hadDatabase).toBe(true);
    expect(manifest.files.some((f) => f.name === 'app.db' && /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true);

    // El backup detuvo live: rearrancar y añadir datos posteriores.
    await runner.run({ args: ['start', h.names.liveContainer], timeoutMs: 30_000 });
    okRes(await h.driver.runHealthCheck({ ...h.args, runtime: 'live' }));
    const ip2 = await containerIp(h.names.liveContainer);
    const t2 = await httpJsonDirect('POST', `http://${ip2}:8080/api/todos`, { body: { title: 'after-backup' }, cookie });
    expect(t2.status).toBe(201);

    // Restore: vuelve al estado del backup (verificado por checksums).
    okRes(await h.driver.restoreBackup({ ...h.args, backupId }));
    okRes(await h.driver.startCandidateAsLive(h.args));
    okRes(await h.driver.runHealthCheck({ ...h.args, runtime: 'live' }));
    const ip3 = await containerIp(h.names.liveContainer);
    const login = await httpJsonDirect('POST', `http://${ip3}:8080/api/auth/login`, {
      body: { email, password: 'Backup-1234-xY9!' },
    });
    expect(login.status).toBe(200);
    const cookie3 = (login.setCookies.find((c) => c.startsWith('af_session=')) ?? '').split(';')[0];
    const list = await httpJsonDirect('GET', `http://${ip3}:8080/api/todos`, { cookie: cookie3 });
    const titles = ((list.json as { items?: Array<{ title?: string }> }).items ?? []).map((t) => t.title);
    expect(titles).toContain('before-backup');
    expect(titles).not.toContain('after-backup');
    const got = await httpJsonDirect('GET', `http://${ip3}:8080/api/todos/${todoId}`, { cookie: cookie3 });
    expect(got.status).toBe(200);

    // Retención: 12 backups en total → quedan 10.
    for (let i = 0; i < 11; i++) {
      const r = await h.driver.createLiveBackup({ ...h.args, previousLiveVersion: null });
      okRes(r);
      await runner.run({ args: ['start', h.names.liveContainer], timeoutMs: 30_000 }).catch(() => undefined);
    }
    const dirs = fs.readdirSync(path.join(h.dataDir, 'project-backups', h.projectId));
    expect(dirs).toHaveLength(10);
    // Live queda arrancado para el siguiente test.
    await runner.run({ args: ['start', h.names.liveContainer], timeoutMs: 30_000 }).catch(() => undefined);
  }, 900_000);

  test('reconcile tras parada: informa sin curar (7A solo lectura)', async () => {
    if (!haveImage) return;
    const h = await sharedHarness();
    // Asegura live corriendo (el test anterior lo deja arrancado).
    const running = await runner.run({
      args: ['ps', '--format', '{{.Names}}', '--filter', `name=${h.names.liveContainer}`], timeoutMs: 30_000,
    });
    if (!running.stdout.includes(h.names.liveContainer)) {
      okRes(await h.driver.startCandidateAsLive(h.args));
    }
    // Stop explícito: con `unless-stopped` el daemon NO lo reanima solo
    // (con `kill` sí lo haría: carrera). Simula live caído de forma
    // determinista.
    const stopped = await runner.run({ args: ['stop', '-t', '1', h.names.liveContainer], timeoutMs: 30_000 });
    expect(stopped.code).toBe(0);
    const rec = await h.driver.reconcileRuntime(h.args);
    okRes(rec);
    expect(rec.data?.liveFound).toBe('true');
    expect(rec.data?.liveRunning).toBe('false');
    // 7A no reanima solo: el arranque lo ordena el orquestador.
    await runner.run({ args: ['start', h.names.liveContainer], timeoutMs: 30_000 });
    okRes(await h.driver.runHealthCheck({ ...h.args, runtime: 'live' }));
  }, 600_000);

  test('migración rota → la versión live anterior sigue sirviendo', async () => {
    if (!haveImage) return;
    const h = await sharedHarness();
    const v1Image = h.names.image;

    // v2 con migración rota (re-verificada: se re-registran los receipts).
    fs.writeFileSync(path.join(h.projectDir, 'migrations', '002_broken.sql'), 'THIS IS NOT VALID SQL;\n');
    recordSixReceipts(h.db as never, h.projectId, h.projectDir);
    const dep2 = randomUUID();
    h.db.prepare('INSERT INTO deployments(id) VALUES (?)').run(dep2);
    const args2 = { ...h.args, deploymentId: dep2 };
    const b2 = await h.driver.buildCandidate(args2);
    okRes(b2);
    const m2 = JSON.parse(
      fs.readFileSync(path.join(h.dataDir, 'deploy-snapshots', dep2, '.appforge-manifest.json'), 'utf8'),
    ) as { fingerprint: string };
    const v2names = resourceNames(h.projectId, dep2, m2.fingerprint);
    builtImages.add(v2names.image);
    okRes(await h.driver.prepareVerificationDatabase(args2));
    const mig = await h.driver.runVerificationMigrations(args2);
    expect(mig.ok).toBe(false);
    expect(mig.code).toBe('MIGRATION_FAILED');

    // Rollback físico: v1 sigue live y sana; v2 nunca se promocionó
    // (el nombre del contenedor live solo depende del proyecto: sigue
    // siendo el de v1, con la imagen v1).
    okRes(await h.driver.runHealthCheck({ ...h.args, runtime: 'live' }));
    const rec = await h.driver.reconcileRuntime(h.args);
    okRes(rec);
    expect(rec.data?.liveRunning).toBe('true');
    expect(rec.data?.liveImage).toContain(v1Image);
    // Limpieza de v2.
    okRes(await h.driver.discardVerificationDatabase(args2));
    okRes(await h.driver.discardCandidate(args2));
    builtImages.delete(v2names.image);
  }, 900_000);

  test('abort durante el build: sin imagen parcial ni contenedores colgados', async () => {
    if (!haveImage) return;
    const h = await sharedHarness();
    // Build determinísticamente lento SIN tocar el Dockerfile (B3 exige el
    // Dockerfile byte a byte igual a la plantilla): se inyecta `sleep 45`
    // en el `preinstall` del frontend, que `npm ci` ejecuta en la primera
    // etapa del build. Así el abort a los 5s siempre pilla el build a mitad,
    // sin carreras con la caché.
    const fpkgPath = path.join(h.projectDir, 'frontend', 'package.json');
    const fpkg = JSON.parse(fs.readFileSync(fpkgPath, 'utf8')) as { scripts?: Record<string, string> };
    fpkg.scripts = { ...(fpkg.scripts ?? {}), preinstall: 'sleep 45' };
    fs.writeFileSync(fpkgPath, JSON.stringify(fpkg, null, 2));
    recordSixReceipts(h.db as never, h.projectId, h.projectDir);
    const dep3 = randomUUID();
    h.db.prepare('INSERT INTO deployments(id) VALUES (?)').run(dep3);
    const ctl = new AbortController();
    const t0 = Date.now();
    const p = h.driver.buildCandidate({ ...h.args, deploymentId: dep3, signal: ctl.signal });
    await new Promise((r) => setTimeout(r, 5_000));
    ctl.abort();
    const res = await p;
    const dt = Date.now() - t0;
    expect(res.ok).toBe(false);
    expect(['OPERATION_ABORTED', 'BUILD_TIMEOUT']).toContain(res.code);
    // Resuelve pronto (no cuelga hasta el timeout de build).
    expect(dt).toBeLessThan(120_000);
    // Sin imagen parcial con el nombre del deployment abortado.
    const m = JSON.parse(
      fs.readFileSync(path.join(h.dataDir, 'deploy-snapshots', dep3, '.appforge-manifest.json'), 'utf8'),
    ) as { fingerprint: string };
    const iname = resourceNames(h.projectId, dep3, m.fingerprint).image;
    expect(await resourceExists(runner, 'image', iname)).toBe(false);
    // Sin contenedores verify/live de este deployment.
    const vname = `appforge-app-${h.projectId.slice(0, 8)}-verify-${dep3.slice(0, 8)}`;
    expect(await resourceExists(runner, 'container', vname)).toBe(false);
  }, 300_000);

  test('fallo de limpieza visible: volumen en uso no se oculta', async () => {
    if (!haveImage) return;
    const h = await sharedHarness();
    okRes(await h.driver.prepareVerificationDatabase(h.args));
    const blocker = `af-test-blocker-${RUN_ID}`;
    const bc = await runner.run({
      args: ['run', '-d', '--name', blocker, '--network', testNet, '--label', `${TEST_LABEL}=${RUN_ID}`,
        '-v', `${h.names.verifyVolume}:/data`, h.names.image, 'sleep', '120'],
      timeoutMs: 60_000,
    });
    expect(bc.code).toBe(0);
    try {
      const bad = await h.driver.discardVerificationDatabase(h.args);
      expect(bad.ok).toBe(false);
      expect(bad.code).toBe('VERIFY_VOLUME_RM_FAILED');
      expect(bad.error).toBeTruthy();
      expect(await resourceExists(runner, 'volume', h.names.verifyVolume)).toBe(true);
    } finally {
      await runner.run({ args: ['rm', '-f', blocker], timeoutMs: 60_000 });
    }
    okRes(await h.driver.discardVerificationDatabase(h.args));
  }, 300_000);

  test('B4: dos despliegues consecutivos comparten volumen live y datos', async () => {
    if (!haveImage) return;
    const h = await makeHarness();
    // v1 live con datos.
    okRes(await h.driver.buildCandidate(h.args));
    snapshotFp(h);
    const v1Image = h.names.image;
    builtImages.add(v1Image);
    okRes(await h.driver.runLiveMigrations(h.args));
    okRes(await h.driver.startCandidateAsLive(h.args));
    okRes(await h.driver.runHealthCheck({ ...h.args, runtime: 'live' }));
    const ip1 = await containerIp(h.names.liveContainer);
    const email = `b4-${RUN_ID}@example.com`;
    const password = 'B4-1234-xY9!';
    const cookie1 = await registerAndLogin(ip1, email, password);
    const t1 = await httpJsonDirect('POST', `http://${ip1}:8080/api/todos`, {
      body: { title: 'b4-data' }, cookie: cookie1,
    });
    expect(t1.status).toBe(201);
    const liveVolumeV1 = h.names.liveVolume;

    // v2: mismo proyecto, deployment distinto, fuentes ligeramente distintas.
    fs.appendFileSync(path.join(h.projectDir, 'backend', 'src', 'server.ts'), '\n// v2\n');
    recordSixReceipts(h.db as never, h.projectId, h.projectDir);
    const dep2 = randomUUID();
    h.db.prepare('INSERT INTO deployments(id) VALUES (?)').run(dep2);
    const args2 = { ...h.args, deploymentId: dep2 };
    okRes(await h.driver.buildCandidate(args2));
    const m2 = JSON.parse(
      fs.readFileSync(path.join(h.dataDir, 'deploy-snapshots', dep2, '.appforge-manifest.json'), 'utf8'),
    ) as { fingerprint: string };
    const names2 = resourceNames(h.projectId, dep2, m2.fingerprint);
    builtImages.add(names2.image);
    okRes(await h.driver.runLiveMigrations(args2));
    okRes(await h.driver.startCandidateAsLive(args2));
    okRes(await h.driver.runHealthCheck({ ...args2, runtime: 'live' }));

    // Mismo volumen live (identidad estable de proyecto, sin deployment ni
    // fingerprint en las labels) y mismos datos.
    expect(names2.liveVolume).toBe(liveVolumeV1);
    const vinfo = (await inspectResource(runner, 'volume', liveVolumeV1)) as { Labels?: Record<string, string> };
    expect(vinfo.Labels?.[MANAGED_LABEL]).toBe('true');
    expect(vinfo.Labels?.['com.appforge.project-id']).toBe(h.projectId);
    expect(vinfo.Labels?.['com.appforge.role']).toBe('live');
    expect(vinfo.Labels?.['com.appforge.deployment-id']).toBeUndefined();
    const ip2 = await containerIp(names2.liveContainer);
    const login = await httpJsonDirect('POST', `http://${ip2}:8080/api/auth/login`, {
      body: { email, password },
    });
    expect(login.status).toBe(200);
    const cookie2 = (login.setCookies.find((c) => c.startsWith('af_session=')) ?? '').split(';')[0];
    const list = await httpJsonDirect('GET', `http://${ip2}:8080/api/todos`, { cookie: cookie2 });
    const titles = ((list.json as { items?: Array<{ title?: string }> }).items ?? []).map((t) => t.title);
    expect(titles).toContain('b4-data');
    // Solo existe UN volumen live para el proyecto.
    const vols = await runner.run({
      args: ['volume', 'ls', '--format', '{{.Name}}', '--filter', `label=com.appforge.project-id=${h.projectId}`],
      timeoutMs: 30_000,
    });
    expect(vols.stdout.split('\n').map((s) => s.trim()).filter(Boolean)).toEqual([liveVolumeV1]);
    // Limpieza: detener el live de v2 (el afterAll elimina el resto).
    await runner.run({ args: ['stop', '-t', '5', names2.liveContainer], timeoutMs: 60_000 }).catch(() => undefined);
    await runner.run({ args: ['rm', names2.liveContainer], timeoutMs: 60_000 }).catch(() => undefined);
  }, 900_000);

  test('B9: rollback físico real conserva versión y datos anteriores', async () => {
    if (!haveImage) return;
    const h = await makeHarness();
    // v1 live con datos.
    okRes(await h.driver.buildCandidate(h.args));
    snapshotFp(h);
    const v1Image = h.names.image;
    builtImages.add(v1Image);
    okRes(await h.driver.runLiveMigrations(h.args));
    okRes(await h.driver.startCandidateAsLive(h.args));
    okRes(await h.driver.runHealthCheck({ ...h.args, runtime: 'live' }));
    const ip1 = await containerIp(h.names.liveContainer);
    const email = `b9-${RUN_ID}@example.com`;
    const password = 'B9-1234-xY9!';
    const cookie1 = await registerAndLogin(ip1, email, password);
    const t1 = await httpJsonDirect('POST', `http://${ip1}:8080/api/todos`, {
      body: { title: 'rollback-data' }, cookie: cookie1,
    });
    expect(t1.status).toBe(201);

    // v2 verificada (migración válida).
    fs.writeFileSync(path.join(h.projectDir, 'migrations', '002_v2.sql'), 'CREATE TABLE IF NOT EXISTS v2_marker(id INTEGER);\n');
    recordSixReceipts(h.db as never, h.projectId, h.projectDir);
    const dep2 = randomUUID();
    h.db.prepare('INSERT INTO deployments(id) VALUES (?)').run(dep2);
    const args2 = { ...h.args, deploymentId: dep2 };
    okRes(await h.driver.buildCandidate(args2));
    const m2 = JSON.parse(
      fs.readFileSync(path.join(h.dataDir, 'deploy-snapshots', dep2, '.appforge-manifest.json'), 'utf8'),
    ) as { fingerprint: string };
    const names2 = resourceNames(h.projectId, dep2, m2.fingerprint);
    builtImages.add(names2.image);
    okRes(await h.driver.prepareVerificationDatabase(args2));
    okRes(await h.driver.runVerificationMigrations(args2));
    okRes(await h.driver.startVerificationRuntime(args2));
    okRes(await h.driver.runHealthCheck({ ...args2, runtime: 'verify' }));
    okRes(await h.driver.stopVerificationRuntime(args2));
    okRes(await h.driver.discardVerificationDatabase(args2));

    // Backup del live (v1 con datos). El backup detiene el live.
    const bk = await h.driver.createLiveBackup({ ...h.args, previousLiveVersion: null });
    okRes(bk);
    const backupId = bk.data!.backupId;
    expect(isValidBackupId(backupId)).toBe(true);

    // Dato posterior al backup: debe DESAPARECER tras el restore (prueba
    // física de que el volumen se sustituyó por el contenido del backup).
    await runner.run({ args: ['start', h.names.liveContainer], timeoutMs: 30_000 });
    okRes(await h.driver.runHealthCheck({ ...h.args, runtime: 'live' }));
    const ipPost = await containerIp(h.names.liveContainer);
    const loginPost = await httpJsonDirect('POST', `http://${ipPost}:8080/api/auth/login`, {
      body: { email, password },
    });
    expect(loginPost.status).toBe(200);
    const cookiePost = (loginPost.setCookies.find((c) => c.startsWith('af_session=')) ?? '').split(';')[0];
    const tPost = await httpJsonDirect('POST', `http://${ipPost}:8080/api/todos`, {
      body: { title: 'post-backup' }, cookie: cookiePost,
    });
    expect(tPost.status).toBe(201);
    await runner.run({ args: ['stop', '-t', '10', h.names.liveContainer], timeoutMs: 60_000 });

    // v3 = v2 + migración rota → FALLO REAL durante la migración live
    // (el contenedor de migración la ejecuta contra el volumen live).
    fs.writeFileSync(path.join(h.projectDir, 'migrations', '003_broken.sql'), 'THIS IS NOT VALID SQL;\n');
    recordSixReceipts(h.db as never, h.projectId, h.projectDir);
    const dep3 = randomUUID();
    h.db.prepare('INSERT INTO deployments(id) VALUES (?)').run(dep3);
    const args3 = { ...h.args, deploymentId: dep3 };
    okRes(await h.driver.buildCandidate(args3));
    const m3 = JSON.parse(
      fs.readFileSync(path.join(h.dataDir, 'deploy-snapshots', dep3, '.appforge-manifest.json'), 'utf8'),
    ) as { fingerprint: string };
    const names3 = resourceNames(h.projectId, dep3, m3.fingerprint);
    builtImages.add(names3.image);
    const mig = await h.driver.runLiveMigrations(args3);
    expect(mig.ok).toBe(false);
    expect(mig.code).toBe('MIGRATION_FAILED');

    // Rollback físico: restore del backup + arranque de la versión anterior.
    // Las operaciones físicas deben ejecutarse (staging → swap → start).
    okRes(await h.driver.restoreBackup({ ...args3, backupId }));
    okRes(await h.driver.startPreviousVersion({ ...args3, previousLiveVersion: v1Image }));
    okRes(await h.driver.runHealthCheck({ ...args3, runtime: 'live' }));

    // La versión anterior sirve y los datos anteriores están intactos.
    const rec = await h.driver.reconcileRuntime(args3);
    okRes(rec);
    expect(rec.data?.liveImage).toContain(v1Image);
    const ip3 = await containerIp(h.names.liveContainer);
    const login3 = await httpJsonDirect('POST', `http://${ip3}:8080/api/auth/login`, {
      body: { email, password },
    });
    expect(login3.status).toBe(200);
    const cookie3 = (login3.setCookies.find((c) => c.startsWith('af_session=')) ?? '').split(';')[0];
    const list = await httpJsonDirect('GET', `http://${ip3}:8080/api/todos`, { cookie: cookie3 });
    const titles = ((list.json as { items?: Array<{ title?: string }> }).items ?? []).map((t) => t.title);
    expect(titles).toContain('rollback-data');
    expect(titles).not.toContain('post-backup');
    // Limpieza de v2/v3 (el afterAll elimina el resto).
    okRes(await h.driver.discardCandidate(args3));
    builtImages.delete(names3.image);
    okRes(await h.driver.discardCandidate(args2));
    builtImages.delete(names2.image);
  }, 900_000);
});
