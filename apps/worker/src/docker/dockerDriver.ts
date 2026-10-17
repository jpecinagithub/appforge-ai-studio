/**
 * Fase 7A — DockerDeploymentDriver: implementación real de la interfaz
 * `DeploymentDriver` de Fase 6 (orquestador inalterado).
 *
 * Principios (§2 de la especificación de Fase 7):
 * - Solo este módulo accede a Docker. El LLM nunca recibe tools, nombres,
 *   rutas ni argumentos Docker.
 * - Todo es ejecutable + vector fijo de argumentos, sin shell, sin
 *   concatenar texto de usuario, sin `docker compose exec` dinámico.
 * - Desactivado por defecto: sin doble kill switch + preflight, este driver
 *   ni siquiera se construye; la API conserva
 *   `501 DEPLOYMENT_DRIVER_NOT_CONFIGURED`. Nunca hay fallback al fake.
 * - Nunca se afirma éxito por haber ejecutado el comando: cada operación
 *   valida su postcondición (`docker inspect`, health, checksums, SQLite).
 * - `previousLiveVersion` para este driver es la REFERENCIA COMPLETA de la
 *   imagen (`appforge/app-<id8>:dep-<dep8>-<sha12>`); el cableado 7B la
 *   tomará de `project_runtime.live_image`.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import {
  DockerCommandRunner,
  DockerCommandError,
  type DockerRunResult,
} from './commandRunner.js';
import {
  createSnapshot,
  verifySnapshot,
  newBackupId,
  isValidBackupId,
  SnapshotError,
} from './snapshot.js';
import {
  resourceNames,
  labelArgs,
  assertLabelsMatch,
  assertUuid,
  id8,
  inspectResource,
  resourceExists,
  listManagedResources,
  MANAGED_LABEL,
  LABEL_PROJECT,
  LABEL_DEPLOYMENT,
  LABEL_ROLE,
  LABEL_FINGERPRINT,
  ResourceError,
  type ManagedLabels,
  type ResourceRole,
} from './resources.js';
import { hardenedRunArgs, assertNoForbiddenFlags } from './hardening.js';
import { writeValidatedEnvFile } from './env.js';
import {
  backupDirFor,
  writeBackupManifest,
  readBackupManifest,
  quickCheck,
  enforceRetention,
  sha256File,
  BackupError,
} from './sqliteBackup.js';
import { sourceFingerprint } from '../fingerprint.js';
import { sanitizeSecrets } from '../secrets.js';
import {
  assertDriverArgs,
  type DriverOpArgs,
  type DriverResult,
  type DeploymentDriver,
  type HealthCheckArgs,
  type LiveBackupArgs,
  type RestoreBackupArgs,
  type StartPreviousVersionArgs,
  type ReconcileArgs,
} from '../deploy/driver.js';

export class DockerDriverError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DockerDriverError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Configuración y kill switches (§4)
// ---------------------------------------------------------------------------

export interface DockerDriverConfig {
  dataDir: string;
  /** Red interna (p. ej. appforge-apps). */
  network: string;
  /** Volumen de datos del Studio. */
  dataVolume: string;
  maxConcurrentDeploys: number;
  dockerBin: string;
  socketPath: string;
  minDockerVersion: string;
}

/**
 * Resuelve la configuración desde el entorno. Devuelve `null` si el doble
 * kill switch no está completo: en ese caso el driver NO existe.
 */
export function resolveDockerDriverConfig(
  env: NodeJS.ProcessEnv,
  dataDir: string,
): DockerDriverConfig | null {
  if (env.APPFORGE_DEPLOY_DRIVER !== 'docker') return null;
  if (env.APPFORGE_ENABLE_DOCKER_DEPLOY !== '1') return null;
  const network = (env.APPFORGE_DOCKER_NETWORK ?? '').trim();
  const dataVolume = (env.APPFORGE_DOCKER_DATA_VOLUME ?? '').trim();
  if (!network || !dataVolume) return null;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(network)) return null;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(dataVolume)) return null;
  const maxRaw = Number.parseInt(env.APPFORGE_MAX_CONCURRENT_DEPLOYS ?? '1', 10);
  return {
    dataDir,
    network,
    dataVolume,
    maxConcurrentDeploys: Number.isFinite(maxRaw) && maxRaw >= 1 ? Math.floor(maxRaw) : 1,
    dockerBin: 'docker',
    socketPath: '/var/run/docker.sock',
    minDockerVersion: '24.0.0',
  };
}

// ---------------------------------------------------------------------------
// Semáforo de despliegues simultáneos (vida del proceso)
// ---------------------------------------------------------------------------

let processActiveDeploys = 0;

/** Intenta adquirir un slot de despliegue. false = límite alcanzado. */
export function acquireDeploySlot(maxConcurrentDeploys: number): boolean {
  const max = Math.max(1, Math.floor(maxConcurrentDeploys));
  if (processActiveDeploys >= max) return false;
  processActiveDeploys += 1;
  return true;
}

export function releaseDeploySlot(): void {
  processActiveDeploys = Math.max(0, processActiveDeploys - 1);
}

export function activeDeploySlots(): number {
  return processActiveDeploys;
}

// ---------------------------------------------------------------------------
// Preflight (§4)
// ---------------------------------------------------------------------------

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

export interface PreflightResult {
  ok: boolean;
  diagnostics: string[];
}

/**
 * Preflight: Linux, CLI compatible, socket Unix real, daemon accesible,
 * red y volumen (se crean etiquetados si faltan), data dir escribible,
 * versión mínima. Si falla → 501 con diagnóstico sanitizado; el Studio
 * sigue funcionando y NUNCA se instala un fake como fallback.
 */
export async function preflightDocker(
  runner: DockerCommandRunner,
  config: DockerDriverConfig,
): Promise<PreflightResult> {
  const diagnostics: string[] = [];
  const fail = (d: string): PreflightResult => ({ ok: false, diagnostics: [...diagnostics, d] });

  if (process.platform !== 'linux') return fail('docker deploy requires linux');
  try {
    const st = fs.statSync(config.socketPath);
    if (!st.isSocket()) return fail('docker socket path is not a socket');
  } catch {
    return fail('docker socket not found');
  }
  const ver = await runner.run({ args: ['version', '--format', '{{.Server.Version}}'], timeoutMs: 15_000 });
  if (ver.code !== 0 || ver.timedOut || ver.aborted) {
    return fail(`docker daemon unreachable: ${ver.stderr.slice(0, 200)}`);
  }
  const serverVersion = ver.stdout.trim();
  if (compareVersions(serverVersion, config.minDockerVersion) < 0) {
    return fail(`docker server ${serverVersion} < minimum ${config.minDockerVersion}`);
  }
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.accessSync(config.dataDir, fs.constants.W_OK);
  } catch {
    return fail('data dir not writable');
  }
  // Red interna: verificar o crear (internal=true, etiquetada).
  const netInspect = await runner.run({
    args: ['network', 'inspect', config.network],
    timeoutMs: 15_000,
  });
  if (netInspect.code !== 0) {
    const created = await runner.run({
      args: [
        'network',
        'create',
        '--internal',
        '--label',
        `${MANAGED_LABEL}=true`,
        '--label',
        'com.appforge.component=network',
        config.network,
      ],
      timeoutMs: 30_000,
    });
    if (created.code !== 0) {
      return fail(`cannot create docker network '${config.network}': ${created.stderr.slice(0, 200)}`);
    }
    diagnostics.push(`created internal network '${config.network}'`);
  }
  // Volumen de datos del Studio: verificar o crear.
  const volInspect = await runner.run({
    args: ['volume', 'inspect', config.dataVolume],
    timeoutMs: 15_000,
  });
  if (volInspect.code !== 0) {
    const created = await runner.run({
      args: ['volume', 'create', '--label', `${MANAGED_LABEL}=true`, config.dataVolume],
      timeoutMs: 30_000,
    });
    if (created.code !== 0) {
      return fail(`cannot create data volume '${config.dataVolume}': ${created.stderr.slice(0, 200)}`);
    }
    diagnostics.push(`created data volume '${config.dataVolume}'`);
  }
  diagnostics.push(`docker preflight ok (server ${serverVersion})`);
  return { ok: true, diagnostics };
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export interface DockerDriverOptions {
  runner?: DockerCommandRunner;
  /** Opcional: para vincular receipts→snapshot y persistir el fingerprint. */
  db?: Database.Database;
}

const BUILD_TIMEOUT_MS = 600_000;
const MIGRATION_TIMEOUT_MS = 300_000;
const HEALTH_ATTEMPTS = 12;
const HEALTH_INTERVAL_MS = 5_000;
const HEALTH_REQUEST_MS = 10_000;

function err(code: string, message: string): DriverResult {
  return { ok: false, code, error: sanitizeSecrets(message).slice(0, 2000) };
}

function ok(data?: Record<string, string>): DriverResult {
  return { ok: true, data };
}

export class DockerDeploymentDriver implements DeploymentDriver {
  readonly name = 'docker';
  private readonly runner: DockerCommandRunner;
  private readonly config: DockerDriverConfig;
  private readonly db?: Database.Database;

  constructor(config: DockerDriverConfig, opts: DockerDriverOptions = {}) {
    this.config = config;
    this.runner = opts.runner ?? new DockerCommandRunner({ dockerBin: config.dockerBin });
    this.db = opts.db;
  }

  // -- helpers -----------------------------------------------------------

  private projectDir(projectId: string): string {
    return path.join(this.config.dataDir, 'projects', projectId);
  }

  private snapshotsRoot(): string {
    return path.join(this.config.dataDir, 'deploy-snapshots');
  }

  private snapshotDir(deploymentId: string): string {
    return path.join(this.snapshotsRoot(), deploymentId);
  }

  /** Lee el fingerprint del manifiesto del snapshot (falla si no existe). */
  private snapshotFingerprint(deploymentId: string): string {
    const manifestPath = path.join(this.snapshotDir(deploymentId), '.appforge-manifest.json');
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { fingerprint: string };
      if (typeof m.fingerprint !== 'string' || !/^[0-9a-f]{64}$/i.test(m.fingerprint)) {
        throw new DockerDriverError('SNAPSHOT_INVALID', 'snapshot manifest has no valid fingerprint');
      }
      return m.fingerprint.toLowerCase();
    } catch (e) {
      if (e instanceof DockerDriverError) throw e;
      throw new DockerDriverError('SNAPSHOT_MISSING', `snapshot manifest not found for deployment ${deploymentId}`);
    }
  }

  private names(projectId: string, deploymentId: string) {
    return resourceNames(projectId, deploymentId, this.snapshotFingerprint(deploymentId));
  }

  private opLabels(projectId: string, deploymentId: string, role: ResourceRole): ManagedLabels {
    return { projectId, deploymentId, role, fingerprint: this.snapshotFingerprint(deploymentId) };
  }

  private async sh(args: string[], opts: { timeoutMs?: number; signal?: AbortSignal; maxOutputBytes?: number } = {}) {
    return this.runner.run({ args, timeoutMs: opts.timeoutMs, signal: opts.signal, maxOutputBytes: opts.maxOutputBytes });
  }

  /** IP del contenedor en la red interna (derivada de inspect, nunca de entrada). */
  private async containerIp(containerName: string): Promise<string> {
    const info = (await inspectResource(this.runner, 'container', containerName)) as {
      NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> };
    };
    const ip = info?.NetworkSettings?.Networks?.[this.config.network]?.IPAddress;
    if (!ip) {
      throw new DockerDriverError('NO_CONTAINER_IP', `container '${containerName}' has no IP on network '${this.config.network}'`);
    }
    return ip;
  }

  /** Comprueba las labels del slot live (managed + proyecto + role live). */
  private async assertLiveSlot(projectId: string, containerName: string): Promise<void> {
    const info = (await inspectResource(this.runner, 'container', containerName)) as {
      Config?: { Labels?: Record<string, string> };
    };
    const labels = info?.Config?.Labels ?? {};
    if (labels[MANAGED_LABEL] !== 'true') {
      throw new DockerDriverError('FOREIGN_RESOURCE', `refusing to touch unmanaged container '${containerName}'`);
    }
    if ((labels[LABEL_PROJECT] ?? '').toLowerCase() !== projectId.toLowerCase()) {
      throw new DockerDriverError('FOREIGN_RESOURCE', `container '${containerName}' belongs to another project`);
    }
    if (labels[LABEL_ROLE] !== 'live') {
      throw new DockerDriverError('FOREIGN_RESOURCE', `container '${containerName}' is not a live container`);
    }
  }

  private async containerRunning(name: string): Promise<boolean> {
    try {
      const info = (await inspectResource(this.runner, 'container', name)) as {
        State?: { Running?: boolean };
      };
      return info?.State?.Running === true;
    } catch (e) {
      if (e instanceof ResourceError && e.code === 'INSPECT_FAILED') return false;
      throw e;
    }
  }

  /** Stop gracioso acotado + kill si es necesario + espera de salida. */
  private async stopContainerBounded(name: string, signal?: AbortSignal, stopSecs = 10): Promise<void> {
    if (!(await this.containerRunning(name))) return;
    await this.sh(['stop', '-t', String(stopSecs), name], { timeoutMs: (stopSecs + 15) * 1000, signal });
    if (await this.containerRunning(name)) {
      await this.sh(['kill', name], { timeoutMs: 15_000, signal });
      const w = await this.sh(['wait', name], { timeoutMs: 30_000, signal });
      if (w.code !== 0) {
        throw new DockerDriverError('STOP_FAILED', `container '${name}' did not stop: ${w.stderr.slice(0, 200)}`);
      }
    }
  }

  private async httpJson(
    method: string,
    url: string,
    opts: { body?: unknown; cookie?: string; signal?: AbortSignal } = {},
  ): Promise<{ status: number; json: unknown; setCookies: string[] }> {
    const headers: Record<string, string> = {};
    if (opts.cookie) headers['cookie'] = opts.cookie;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(url, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(HEALTH_REQUEST_MS)]) : AbortSignal.timeout(HEALTH_REQUEST_MS),
      redirect: 'manual',
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    return { status: res.status, json, setCookies };
  }

  /** Columnas aditivas del snapshot en deployments (idempotente). */
  private ensureSnapshotColumns(): void {
    if (!this.db) return;
    for (const ddl of [
      'ALTER TABLE deployments ADD COLUMN snapshot_fingerprint TEXT',
      'ALTER TABLE deployments ADD COLUMN snapshot_path TEXT',
    ]) {
      try {
        this.db.exec(ddl);
      } catch {
        /* la columna ya existe */
      }
    }
  }

  private persistSnapshot(deploymentId: string, fingerprint: string, snapshotPath: string): void {
    if (!this.db) return;
    this.ensureSnapshotColumns();
    this.db
      .prepare('UPDATE deployments SET snapshot_fingerprint=?, snapshot_path=? WHERE id=?')
      .run(fingerprint, snapshotPath, deploymentId);
  }

  /** Fingerprint de los receipts vigentes (o null si no hay). */
  private receiptsFingerprint(projectId: string): string | null {
    if (!this.db) return null;
    try {
      const rows = this.db
        .prepare('SELECT fingerprint FROM verification_receipts WHERE project_id=?')
        .all(projectId) as Array<{ fingerprint: string }>;
      if (rows.length === 0) return null;
      const fps = new Set(rows.map((r) => r.fingerprint));
      if (fps.size !== 1) return null;
      return [...fps][0];
    } catch {
      return null;
    }
  }

  // -- operaciones --------------------------------------------------------
  // (implementadas a continuación)

  // =======================================================================
  // Operaciones de la interfaz DeploymentDriver (§10)
  // =======================================================================

  /**
   * runtime.env vive FUERA del snapshot (el snapshot es inmutable; escribir
   * dentro lo invalidaría y expondría el env al contexto de build).
   */
  private ensureEnvFile(projectId: string, deploymentId: string): string {
    const dir = path.join(this.config.dataDir, 'deploy-env', deploymentId);
    const dest = path.join(dir, 'runtime.env');
    if (!fs.existsSync(dest)) {
      writeValidatedEnvFile({
        projectEnvPath: path.join(this.projectDir(projectId), '.env'),
        destPath: dest,
        projectId,
      });
    }
    return dest;
  }

  /** Escanea el tar de `docker cp <c>:/app -` buscando .env / *.db*. */
  private static scanTarForForbidden(buf: Buffer): string | null {
    const isForbidden = (name: string): boolean => {
      const base = name.split('/').pop() ?? '';
      return base === '.env' || base.startsWith('.env.') || /\.db(-wal|-shm|-journal)?$/.test(base);
    };
    let off = 0;
    while (off + 512 <= buf.length) {
      const header = buf.subarray(off, off + 512);
      let allZero = true;
      for (let i = 0; i < 512; i++) {
        if (header[i] !== 0) { allZero = false; break; }
      }
      if (allZero) break;
      const rawName = header.subarray(0, 100).toString('utf8').split('\0')[0];
      const typeflag = String.fromCharCode(header[156]);
      const sizeStr = header.subarray(124, 136).toString('utf8').split('\0')[0].trim();
      const size = Number.parseInt(sizeStr, 8) || 0;
      if ((typeflag === '0' || typeflag === '\0') && isForbidden(rawName)) return rawName;
      off += 512 + Math.ceil(size / 512) * 512;
    }
    return null;
  }

  private async validateImage(image: string, labels: ManagedLabels): Promise<DriverResult> {
    let info: {
      Os?: string;
      Config?: { User?: string; Labels?: Record<string, string> };
    };
    try {
      info = (await inspectResource(this.runner, 'image', image)) as typeof info;
    } catch {
      return err('IMAGE_MISSING', `built image '${image}' not found`);
    }
    try {
      assertLabelsMatch(info?.Config?.Labels, labels);
    } catch (e) {
      return err('IMAGE_LABEL_MISMATCH', (e as Error).message);
    }
    const user = String(info?.Config?.User ?? '');
    if (!user || user === '0' || user.toLowerCase() === 'root') {
      return err('IMAGE_ROOT_USER', `image runs as root/empty user ('${user}')`);
    }
    if (String(info?.Os ?? '').toLowerCase() !== 'linux') {
      return err('IMAGE_OS_MISMATCH', 'image OS is not linux');
    }
    // Sin .env ni bases de datos en /app (vía docker cp + escaneo tar).
    const cname = `appforge-tmp-scan-${randomUUID().slice(0, 8)}`;
    const created = await this.sh(['create', '--name', cname, image], { timeoutMs: 30_000 });
    if (created.code !== 0) return err('SCAN_CREATE_FAILED', created.stderr.slice(0, 300));
    try {
      const raw = await this.runner.runRaw({
        args: ['cp', `${cname}:/app`, '-'],
        timeoutMs: 120_000,
        maxOutputBytes: 134_217_728,
      });
      if (raw.code !== 0) {
        if (/no such file/i.test(raw.stderr)) return ok();
        return err('SCAN_CP_FAILED', raw.stderr.slice(0, 300));
      }
      if (raw.truncated) return err('IMAGE_SCAN_TRUNCATED', 'image /app too large to scan');
      const bad = DockerDeploymentDriver.scanTarForForbidden(raw.stdoutBytes);
      if (bad) return err('IMAGE_FORBIDDEN_FILE', `image contains forbidden file: ${bad}`);
      return ok();
    } finally {
      await this.sh(['rm', cname], { timeoutMs: 30_000 }).catch(() => undefined);
    }
  }

  async buildCandidate(args: DriverOpArgs): Promise<DriverResult> {
    assertDriverArgs(args);
    if (args.signal?.aborted) return err('OPERATION_ABORTED', 'buildCandidate aborted before start');
    const { deploymentId, projectId } = args;
    try {
      const projectDir = this.projectDir(projectId);
      if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
        return err('PROJECT_NOT_FOUND', `project dir not found for ${projectId}`);
      }
      // §6.6: el fingerprint de los receipts debe coincidir con el proyecto.
      const receiptFp = this.receiptsFingerprint(projectId);
      if (receiptFp && sourceFingerprint(projectDir) !== receiptFp) {
        return err('RECEIPT_FINGERPRINT_MISMATCH', 'project sources changed after the verification gate');
      }
      // Idempotencia antes de tocar el snapshot.
      const manifestPath = path.join(this.snapshotDir(deploymentId), '.appforge-manifest.json');
      if (fs.existsSync(manifestPath)) {
        // El snapshot ya existe: re-verificar (lanza si fue manipulado).
        const fp = verifySnapshot(this.snapshotDir(deploymentId));
        const reused = await this.reuseBuiltImage(projectId, deploymentId, fp);
        if (reused) return reused;
        // Snapshot verificado pero imagen ausente: reconstruir desde él.
        return await this.buildFromSnapshot(args, this.snapshotDir(deploymentId), fp);
      }
      const snap = createSnapshot({ projectDir, snapshotsRoot: this.snapshotsRoot(), deploymentId });
      this.persistSnapshot(deploymentId, snap.fingerprint, snap.dir);
      // Re-verificación TOCTOU inmediatamente antes del build.
      if (verifySnapshot(snap.dir) !== snap.fingerprint) {
        return err('SNAPSHOT_TAMPERED', 'snapshot changed between creation and build');
      }
      return await this.buildFromSnapshot(args, snap.dir, snap.fingerprint);
    } catch (e) {
      if (e instanceof SnapshotError) return err('SNAPSHOT_FAILED', `${e.code}: ${e.message}`);
      if (e instanceof DockerDriverError || e instanceof ResourceError) return err(e.code, e.message);
      return err('BUILD_ERROR', (e as Error).message);
    }
  }

  /**
   * Idempotencia de build: si el snapshot ya existe y la imagen está
   * construida con labels exactas, se reutiliza sin reconstruir.
   * Llamar antes de createSnapshot.
   */
  private async reuseBuiltImage(
    projectId: string,
    deploymentId: string,
    fp: string,
  ): Promise<DriverResult | null> {
    const names = resourceNames(projectId, deploymentId, fp);
    const labels: ManagedLabels = { projectId, deploymentId, role: 'live', fingerprint: fp };
    if (await resourceExists(this.runner, 'image', names.image)) {
      return this.validateImage(names.image, labels);
    }
    return null;
  }

  /** Construye la imagen desde un snapshot ya verificado. */
  private async buildFromSnapshot(
    args: DriverOpArgs,
    snapDir: string,
    fp: string,
  ): Promise<DriverResult> {
    const { deploymentId, projectId } = args;
    const dockerfile = path.join(snapDir, 'Dockerfile');
    if (!fs.existsSync(dockerfile) || !fs.statSync(dockerfile).isFile()) {
      return err('DOCKERFILE_MISSING', 'controlled Dockerfile not found in snapshot');
    }
    const names = resourceNames(projectId, deploymentId, fp);
    const labels: ManagedLabels = { projectId, deploymentId, role: 'live', fingerprint: fp };
    const buildArgs = ['build', '-t', names.image, ...labelArgs(labels), '-f', path.join(snapDir, 'Dockerfile'), snapDir];
    assertNoForbiddenFlags(buildArgs);
    const b = await this.sh(buildArgs, { timeoutMs: BUILD_TIMEOUT_MS, signal: args.signal, maxOutputBytes: 2_097_152 });
    if (b.aborted) {
      await this.sh(['rmi', names.image], { timeoutMs: 60_000 }).catch(() => undefined);
      return err('OPERATION_ABORTED', 'buildCandidate aborted; partial image removed');
    }
    if (b.timedOut) {
      await this.sh(['rmi', names.image], { timeoutMs: 60_000 }).catch(() => undefined);
      return err('BUILD_TIMEOUT', `docker build timed out: ${b.stderr.slice(0, 300)}`);
    }
    if (b.code !== 0) {
      return err('BUILD_FAILED', `docker build failed (code ${b.code}): ${(b.stdout + '\n' + b.stderr).slice(0, 800)}`);
    }
    return await this.validateImage(names.image, labels);
  }

  async prepareVerificationDatabase(args: DriverOpArgs): Promise<DriverResult> {
    assertDriverArgs(args);
    if (args.signal?.aborted) return err('OPERATION_ABORTED', 'aborted before start');
    try {
      const names = this.names(args.projectId, args.deploymentId);
      const labels = this.opLabels(args.projectId, args.deploymentId, 'verify');
      // El nombre garantiza que nunca es el volumen live.
      if (await resourceExists(this.runner, 'volume', names.verifyVolume)) {
        const info = (await inspectResource(this.runner, 'volume', names.verifyVolume)) as {
          Labels?: Record<string, string>;
        };
        try {
          assertLabelsMatch(info?.Labels, labels);
        } catch {
          return err('FOREIGN_RESOURCE', `refusing to reuse volume '${names.verifyVolume}' with non-matching labels`);
        }
        const rm = await this.sh(['volume', 'rm', names.verifyVolume], { timeoutMs: 30_000, signal: args.signal });
        if (rm.code !== 0) return err('VOLUME_RM_FAILED', rm.stderr.slice(0, 300));
      }
      const c = await this.sh(['volume', 'create', ...labelArgs(labels), names.verifyVolume], {
        timeoutMs: 30_000,
        signal: args.signal,
      });
      if (c.code !== 0) return err('VOLUME_CREATE_FAILED', c.stderr.slice(0, 300));
      const info = (await inspectResource(this.runner, 'volume', names.verifyVolume)) as {
        Labels?: Record<string, string>;
      };
      try {
        assertLabelsMatch(info?.Labels, labels);
      } catch {
        return err('VOLUME_LABEL_MISMATCH', 'verify volume labels do not match');
      }
      return ok();
    } catch (e) {
      if (e instanceof DockerDriverError || e instanceof ResourceError) return err(e.code, e.message);
      return err('PREPARE_VERIFY_DB_ERROR', (e as Error).message);
    }
  }

  /** Migraciones en contenedor efímero: red none, exit 0 y SQLite validada. */
  private async runMigrations(
    args: DriverOpArgs,
    volume: string,
    role: ResourceRole,
    timeoutMs: number,
  ): Promise<DriverResult> {
    const names = this.names(args.projectId, args.deploymentId);
    const labels = this.opLabels(args.projectId, args.deploymentId, role);
    const migName = `appforge-mig-${id8(args.deploymentId)}`;
    const runArgs = hardenedRunArgs({
      name: migName,
      image: names.image,
      volume,
      labels,
      envFile: this.ensureEnvFile(args.projectId, args.deploymentId),
      network: this.config.network,
      role: 'migration',
      command: ['node', 'backend/dist/migrate.js'],
    });
    assertNoForbiddenFlags(runArgs);
    const r = await this.sh(runArgs, { timeoutMs, signal: args.signal, maxOutputBytes: 1_048_576 });
    if (r.aborted) return err('OPERATION_ABORTED', 'migrations aborted');
    if (r.timedOut) return err('MIGRATION_TIMEOUT', `migrations timed out: ${r.stderr.slice(0, 300)}`);
    if (r.code !== 0) {
      return err('MIGRATION_FAILED', `migrations exited ${r.code}: ${(r.stdout + '\n' + r.stderr).slice(0, 800)}`);
    }
    return this.validateVolumeDatabase(volume, names.image, args.signal);
  }

  /** Extrae app.db del volumen y le pasa PRAGMA quick_check. */
  private async validateVolumeDatabase(volume: string, image: string, signal?: AbortSignal): Promise<DriverResult> {
    const tmp = `appforge-tmp-dbcheck-${randomUUID().slice(0, 8)}`;
    const c = await this.sh(['create', '--name', tmp, '-v', `${volume}:/data`, image], { timeoutMs: 30_000, signal });
    if (c.code !== 0) return err('DBCHECK_CREATE_FAILED', c.stderr.slice(0, 300));
    try {
      const workdir = fs.mkdtempSync(path.join('/tmp', 'af-dbcheck-'));
      try {
        const dest = path.join(workdir, 'app.db');
        const cp = await this.sh(['cp', `${tmp}:/data/app.db`, dest], { timeoutMs: 60_000, signal });
        if (cp.code !== 0) return err('DBCHECK_CP_FAILED', `app.db not found in volume: ${cp.stderr.slice(0, 200)}`);
        try {
          quickCheck(dest);
        } catch (e) {
          return err('DBCHECK_QUICK_CHECK_FAILED', (e as Error).message);
        }
        return ok();
      } finally {
        fs.rmSync(workdir, { recursive: true, force: true });
      }
    } finally {
      await this.sh(['rm', tmp], { timeoutMs: 30_000 }).catch(() => undefined);
    }
  }

  async runVerificationMigrations(args: DriverOpArgs): Promise<DriverResult> {
    assertDriverArgs(args);
    if (args.signal?.aborted) return err('OPERATION_ABORTED', 'aborted before start');
    try {
      const names = this.names(args.projectId, args.deploymentId);
      return await this.runMigrations(args, names.verifyVolume, 'verify', MIGRATION_TIMEOUT_MS);
    } catch (e) {
      if (e instanceof DockerDriverError || e instanceof ResourceError) return err(e.code, e.message);
      return err('VERIFY_MIGRATION_ERROR', (e as Error).message);
    }
  }

  /** Crea el volumen live con labels si falta (sin él, `docker run -v` lo
   * autocrearía SIN labels y quedaría fuera del inventario managed). */
  private async ensureLiveVolume(
    projectId: string,
    deploymentId: string,
    signal?: AbortSignal,
  ): Promise<DriverResult | null> {
    const names = this.names(projectId, deploymentId);
    const labels = this.opLabels(projectId, deploymentId, 'live');
    if (await resourceExists(this.runner, 'volume', names.liveVolume)) {
      const info = (await inspectResource(this.runner, 'volume', names.liveVolume)) as {
        Labels?: Record<string, string>;
      };
      try {
        assertLabelsMatch(info?.Labels, labels);
      } catch {
        return err('FOREIGN_RESOURCE', `refusing to use volume '${names.liveVolume}' with non-matching labels`);
      }
      return null;
    }
    const c = await this.sh(['volume', 'create', ...labelArgs(labels), names.liveVolume], {
      timeoutMs: 30_000,
      signal,
    });
    if (c.code !== 0) return err('VOLUME_CREATE_FAILED', c.stderr.slice(0, 300));
    return null;
  }

  async runLiveMigrations(args: DriverOpArgs): Promise<DriverResult> {
    assertDriverArgs(args);
    if (args.signal?.aborted) return err('OPERATION_ABORTED', 'aborted before start');
    try {
      const names = this.names(args.projectId, args.deploymentId);
      const v = await this.ensureLiveVolume(args.projectId, args.deploymentId, args.signal);
      if (v) return v;
      return await this.runMigrations(args, names.liveVolume, 'migration', MIGRATION_TIMEOUT_MS);
    } catch (e) {
      if (e instanceof DockerDriverError || e instanceof ResourceError) return err(e.code, e.message);
      return err('LIVE_MIGRATION_ERROR', (e as Error).message);
    }
  }

  /** Valida un contenedor en marcha contra identidad, mounts, red y límites. */
  private async validateRunningContainer(
    name: string,
    labels: ManagedLabels,
    volume: string,
    expectRestart: 'unless-stopped' | 'no',
  ): Promise<DriverResult> {
    const info = (await inspectResource(this.runner, 'container', name)) as {
      Config?: { Labels?: Record<string, string>; User?: string };
      State?: { Running?: boolean };
      Mounts?: Array<{ Name?: string; Destination?: string }>;
      NetworkSettings?: { Networks?: Record<string, unknown>; Ports?: Record<string, unknown[]> };
      HostConfig?: {
        Memory?: number;
        NanoCpus?: number;
        PidsLimit?: number;
        CapDrop?: string[];
        SecurityOpt?: string[];
        ReadonlyRootfs?: boolean;
        RestartPolicy?: { Name?: string };
      };
    };
    try {
      assertLabelsMatch(info?.Config?.Labels, labels);
    } catch {
      return err('CONTAINER_LABEL_MISMATCH', `container '${name}' labels do not match`);
    }
    if (info?.State?.Running !== true) return err('CONTAINER_NOT_RUNNING', `container '${name}' is not running`);
    const mounts = info?.Mounts ?? [];
    if (!mounts.some((m) => m?.Name === volume && m?.Destination === '/data')) {
      return err('CONTAINER_MOUNT_MISMATCH', `container '${name}' does not mount '${volume}' at /data`);
    }
    if (!Object.keys(info?.NetworkSettings?.Networks ?? {}).includes(this.config.network)) {
      return err('CONTAINER_NETWORK_MISMATCH', `container '${name}' is not on network '${this.config.network}'`);
    }
    const hc = info?.HostConfig ?? {};
    if (hc.Memory !== 512 * 1024 * 1024) return err('CONTAINER_LIMIT_MISMATCH', `memory is ${hc.Memory}`);
    if (hc.NanoCpus !== 1_000_000_000) return err('CONTAINER_LIMIT_MISMATCH', `cpus is ${hc.NanoCpus}`);
    if (hc.PidsLimit !== 128) return err('CONTAINER_LIMIT_MISMATCH', `pids-limit is ${hc.PidsLimit}`);
    if (!Array.isArray(hc.CapDrop) || !hc.CapDrop.includes('ALL')) return err('CONTAINER_CAP_MISMATCH', 'cap-drop ALL missing');
    if (!Array.isArray(hc.SecurityOpt) || !hc.SecurityOpt.some((s) => s.includes('no-new-privileges'))) {
      return err('CONTAINER_SECOPT_MISMATCH', 'no-new-privileges missing');
    }
    if (hc.ReadonlyRootfs !== true) return err('CONTAINER_READONLY_MISMATCH', 'read-only rootfs not set');
    if (hc.RestartPolicy?.Name !== expectRestart) {
      return err('CONTAINER_RESTART_MISMATCH', `restart policy is '${hc.RestartPolicy?.Name}'`);
    }
    const ports = info?.NetworkSettings?.Ports ?? {};
    if (Object.values(ports).some((b) => Array.isArray(b) && b.length > 0)) {
      return err('CONTAINER_PORTS_PUBLISHED', `container '${name}' publishes host ports`);
    }
    const user = String(info?.Config?.User ?? '');
    if (!user || user === '0' || user.toLowerCase() === 'root') {
      return err('CONTAINER_ROOT_USER', `container '${name}' runs as root`);
    }
    return ok();
  }

  async startVerificationRuntime(args: DriverOpArgs): Promise<DriverResult> {
    assertDriverArgs(args);
    if (args.signal?.aborted) return err('OPERATION_ABORTED', 'aborted before start');
    try {
      const names = this.names(args.projectId, args.deploymentId);
      const labels = this.opLabels(args.projectId, args.deploymentId, 'verify');
      if (await this.containerRunning(names.verifyContainer)) {
        return err('VERIFY_ALREADY_RUNNING', 'verify container already running');
      }
      if (await resourceExists(this.runner, 'container', names.verifyContainer)) {
        const info = (await inspectResource(this.runner, 'container', names.verifyContainer)) as {
          Config?: { Labels?: Record<string, string> };
        };
        try {
          assertLabelsMatch(info?.Config?.Labels, labels);
        } catch {
          return err('FOREIGN_RESOURCE', `refusing to reuse verify container '${names.verifyContainer}'`);
        }
        await this.sh(['rm', names.verifyContainer], { timeoutMs: 30_000, signal: args.signal });
      }
      const runArgs = hardenedRunArgs({
        name: names.verifyContainer,
        image: names.image,
        volume: names.verifyVolume,
        labels,
        envFile: this.ensureEnvFile(args.projectId, args.deploymentId),
        network: this.config.network,
        role: 'verify',
      });
      assertNoForbiddenFlags(runArgs);
      const r = await this.sh(runArgs, { timeoutMs: 120_000, signal: args.signal });
      if (r.aborted) {
        await this.sh(['rm', names.verifyContainer], { timeoutMs: 30_000 }).catch(() => undefined);
        return err('OPERATION_ABORTED', 'startVerificationRuntime aborted');
      }
      if (r.timedOut || r.code !== 0) {
        return err('VERIFY_START_FAILED', `docker run failed: ${r.stderr.slice(0, 500)}`);
      }
      return await this.validateRunningContainer(names.verifyContainer, labels, names.verifyVolume, 'no');
    } catch (e) {
      if (e instanceof DockerDriverError || e instanceof ResourceError) return err(e.code, e.message);
      return err('VERIFY_START_ERROR', (e as Error).message);
    }
  }

  private abortAwareSleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const t = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(t);
        resolve();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  async runHealthCheck(args: HealthCheckArgs): Promise<DriverResult> {
    assertDriverArgs(args);
    try {
      const names = this.names(args.projectId, args.deploymentId);
      const cname = args.runtime === 'verify' ? names.verifyContainer : names.liveContainer;
      const ip = await this.containerIp(cname);
      const url = `http://${ip}:8080/healthz`;
      let lastErr = 'no attempts';
      for (let i = 0; i < HEALTH_ATTEMPTS; i++) {
        if (args.signal?.aborted) return err('OPERATION_ABORTED', 'health check aborted');
        try {
          const { status, json } = await this.httpJson('GET', url, { signal: args.signal });
          if (
            status === 200 &&
            json !== null &&
            typeof json === 'object' &&
            (json as { ok?: unknown }).ok === true &&
            typeof (json as { version?: unknown }).version === 'string' &&
            ((json as { version?: string }).version ?? '').length > 0
          ) {
            return ok({ version: (json as { version: string }).version });
          }
          lastErr = `attempt ${i + 1}: status ${status}`;
        } catch (e) {
          lastErr = `attempt ${i + 1}: ${(e as Error).message.slice(0, 120)}`;
        }
        if (i < HEALTH_ATTEMPTS - 1) await this.abortAwareSleep(HEALTH_INTERVAL_MS, args.signal);
      }
      return err('HEALTH_CHECK_FAILED', `unhealthy after ${HEALTH_ATTEMPTS} attempts: ${lastErr.slice(0, 300)}`);
    } catch (e) {
      if (e instanceof DockerDriverError) return err(e.code, e.message);
      return err('HEALTH_CHECK_ERROR', (e as Error).message);
    }
  }

  async runAuthenticatedVerification(args: DriverOpArgs): Promise<DriverResult> {
    assertDriverArgs(args);
    if (args.signal?.aborted) return err('OPERATION_ABORTED', 'aborted before start');
    const fail = (step: string, detail: string): DriverResult => err('AUTH_FLOW_FAILED', `${step}: ${detail}`);
    try {
      const names = this.names(args.projectId, args.deploymentId);
      const ip = await this.containerIp(names.verifyContainer);
      const base = `http://${ip}:8080`;
      const dep8 = id8(args.deploymentId);
      const emailA = `verify-a-${dep8}@example.com`;
      const emailB = `verify-b-${dep8}@example.com`;
      const password = `Vf-${dep8}-xY9!qwerty`;
      const cookieName = 'af_session';
      const sig = args.signal;

      const r1 = await this.httpJson('POST', `${base}/api/auth/register`, { body: { email: emailA, password }, signal: sig });
      if (r1.status !== 201) return fail('register A', `status ${r1.status}`);
      const scA = r1.setCookies.find((c) => c.startsWith(`${cookieName}=`));
      if (!scA) return fail('register A', 'no session cookie');
      const lc = scA.toLowerCase();
      if (!lc.includes('httponly')) return fail('register A', 'cookie missing HttpOnly');
      if (!lc.includes('samesite=lax')) return fail('register A', 'cookie missing SameSite=Lax');
      if (!lc.includes(`path=/a/${args.projectId}/`)) return fail('register A', 'cookie Path mismatch');
      const cookieA = scA.split(';')[0];

      const r2 = await this.httpJson('GET', `${base}/api/auth/me`, { cookie: cookieA, signal: sig });
      if (r2.status !== 200 || (r2.json as { user?: { email?: string } })?.user?.email !== emailA.toLowerCase()) {
        return fail('me', `status ${r2.status}`);
      }
      const r3 = await this.httpJson('POST', `${base}/api/todos`, { body: { title: `verify ${dep8}` }, cookie: cookieA, signal: sig });
      const todoId = (r3.json as { id?: string })?.id;
      if (r3.status !== 201 || !todoId) return fail('create todo', `status ${r3.status}`);
      const r4 = await this.httpJson('GET', `${base}/api/todos`, { cookie: cookieA, signal: sig });
      const items = (r4.json as { items?: Array<{ id?: string }> })?.items;
      if (!Array.isArray(items) || !items.some((t) => t?.id === todoId)) return fail('list todos', 'created todo not listed');

      const r5 = await this.httpJson('POST', `${base}/api/auth/register`, { body: { email: emailB, password }, signal: sig });
      if (r5.status !== 201) return fail('register B', `status ${r5.status}`);
      const cookieB = (r5.setCookies.find((c) => c.startsWith(`${cookieName}=`)) ?? '').split(';')[0];
      if (!cookieB) return fail('register B', 'no session cookie');

      const r6 = await this.httpJson('GET', `${base}/api/todos/${todoId}`, { cookie: cookieB, signal: sig });
      if (r6.status !== 404) return fail('isolation', `expected 404, got ${r6.status}`);
      const r7 = await this.httpJson('GET', `${base}/api/todos/${todoId}`, { cookie: cookieA, signal: sig });
      if (r7.status !== 200) return fail('isolation A', `expected 200, got ${r7.status}`);

      // Limpieza best-effort de lo creado.
      await this.httpJson('DELETE', `${base}/api/todos/${todoId}`, { cookie: cookieA, signal: sig }).catch(() => undefined);

      const r8 = await this.httpJson('POST', `${base}/api/auth/logout`, { cookie: cookieA, signal: sig });
      if (r8.status !== 200) return fail('logout', `status ${r8.status}`);
      const r9 = await this.httpJson('GET', `${base}/api/auth/me`, { cookie: cookieA, signal: sig });
      if (r9.status !== 401) return fail('post-logout me', `expected 401, got ${r9.status}`);
      return ok();
    } catch (e) {
      if (e instanceof DockerDriverError) return err(e.code, e.message);
      return err('AUTH_FLOW_ERROR', (e as Error).message);
    }
  }

  async stopVerificationRuntime(args: DriverOpArgs): Promise<DriverResult> {
    assertDriverArgs(args);
    try {
      const names = this.names(args.projectId, args.deploymentId);
      const labels = this.opLabels(args.projectId, args.deploymentId, 'verify');
      if (await resourceExists(this.runner, 'container', names.verifyContainer)) {
        const info = (await inspectResource(this.runner, 'container', names.verifyContainer)) as {
          Config?: { Labels?: Record<string, string> };
        };
        try {
          assertLabelsMatch(info?.Config?.Labels, labels);
        } catch {
          return err('FOREIGN_RESOURCE', `refusing to stop verify container '${names.verifyContainer}' with non-matching labels`);
        }
        await this.stopContainerBounded(names.verifyContainer, args.signal, 10);
        const rm = await this.sh(['rm', names.verifyContainer], { timeoutMs: 30_000, signal: args.signal });
        if (rm.code !== 0) return err('VERIFY_RM_FAILED', rm.stderr.slice(0, 300));
      }
      if (await resourceExists(this.runner, 'container', names.verifyContainer)) {
        return err('VERIFY_STOP_FAILED', 'verify container still exists after stop+rm');
      }
      return ok();
    } catch (e) {
      if (e instanceof DockerDriverError || e instanceof ResourceError) return err(e.code, e.message);
      return err('VERIFY_STOP_ERROR', (e as Error).message);
    }
  }

  async discardVerificationDatabase(args: DriverOpArgs): Promise<DriverResult> {
    assertDriverArgs(args);
    try {
      const names = this.names(args.projectId, args.deploymentId);
      const labels = this.opLabels(args.projectId, args.deploymentId, 'verify');
      if (await resourceExists(this.runner, 'volume', names.verifyVolume)) {
        const info = (await inspectResource(this.runner, 'volume', names.verifyVolume)) as {
          Labels?: Record<string, string>;
        };
        try {
          assertLabelsMatch(info?.Labels, labels);
        } catch {
          return err('FOREIGN_RESOURCE', `refusing to remove volume '${names.verifyVolume}' with non-matching labels`);
        }
        const rm = await this.sh(['volume', 'rm', names.verifyVolume], { timeoutMs: 30_000, signal: args.signal });
        if (rm.code !== 0) return err('VERIFY_VOLUME_RM_FAILED', rm.stderr.slice(0, 300));
      }
      if (await resourceExists(this.runner, 'volume', names.verifyVolume)) {
        return err('VERIFY_VOLUME_RM_FAILED', 'verify volume still exists after rm');
      }
      return ok();
    } catch (e) {
      if (e instanceof DockerDriverError || e instanceof ResourceError) return err(e.code, e.message);
      return err('VERIFY_VOLUME_ERROR', (e as Error).message);
    }
  }

  async createLiveBackup(args: LiveBackupArgs): Promise<DriverResult> {
    assertDriverArgs(args);
    if (args.signal?.aborted) return err('OPERATION_ABORTED', 'aborted before start');
    try {
      const { projectId, deploymentId } = args;
      const names = this.names(projectId, deploymentId);
      const backupId = newBackupId();
      const dir = backupDirFor(this.config.dataDir, projectId, backupId);
      const stamp = new Date().toISOString();
      if (!(await resourceExists(this.runner, 'container', names.liveContainer))) {
        // Primer despliegue: backup validado con hadDatabase=false.
        writeBackupManifest(dir, { backupId, projectId, deploymentId, createdAt: stamp, hadDatabase: false, files: [] });
        return ok({ backupId, backupValidated: 'true' });
      }
      await this.assertLiveSlot(projectId, names.liveContainer);
      // Detener de forma controlada antes de copiar.
      await this.stopContainerBounded(names.liveContainer, args.signal, 30);
      if (await this.containerRunning(names.liveContainer)) {
        return err('BACKUP_STOP_FAILED', 'live container did not stop before backup');
      }
      fs.mkdirSync(dir, { recursive: true });
      const copied: Array<{ name: string; size: number; sha256: string }> = [];
      // Solo app.db + app.db-wal: el -shm es memoria compartida transitoria
      // (SQLite lo recrea al abrir); su checksum no es estable entre copias.
      for (const f of ['app.db', 'app.db-wal']) {
        const dest = path.join(dir, f);
        const cp = await this.sh(['cp', `${names.liveContainer}:/data/${f}`, dest], {
          timeoutMs: 120_000,
          signal: args.signal,
        });
        if (cp.code !== 0) {
          if (/no such file/i.test(cp.stderr)) continue;
          return err('BACKUP_CP_FAILED', `docker cp ${f}: ${cp.stderr.slice(0, 200)}`);
        }
        try {
          fs.chownSync(dest, 1001, 1001);
        } catch (e) {
          return err('BACKUP_CHOWN_FAILED', `cannot chown ${f}: ${(e as Error).message.slice(0, 150)}`);
        }
        copied.push({ name: f, ...sha256File(dest) });
      }
      if (!copied.some((c) => c.name === 'app.db')) {
        return err('BACKUP_SOURCE_MISSING', 'live container has no app.db');
      }
      try {
        quickCheck(path.join(dir, 'app.db'));
      } catch (e) {
        return err('BACKUP_QUICK_CHECK_FAILED', (e as Error).message);
      }
      writeBackupManifest(dir, { backupId, projectId, deploymentId, createdAt: stamp, hadDatabase: true, files: copied });
      enforceRetention({ dataDir: this.config.dataDir, projectId });
      return ok({ backupId, backupValidated: 'true' });
    } catch (e) {
      if (e instanceof DockerDriverError || e instanceof ResourceError || e instanceof BackupError) {
        return err(e.code, e.message);
      }
      return err('BACKUP_ERROR', (e as Error).message);
    }
  }

  async stopCurrentLiveRuntime(args: DriverOpArgs): Promise<DriverResult> {
    assertDriverArgs(args);
    try {
      const names = this.names(args.projectId, args.deploymentId);
      if (!(await resourceExists(this.runner, 'container', names.liveContainer))) return ok();
      await this.assertLiveSlot(args.projectId, names.liveContainer);
      await this.stopContainerBounded(names.liveContainer, args.signal, 10);
      if (await this.containerRunning(names.liveContainer)) {
        return err('STOP_FAILED', `live container '${names.liveContainer}' still running after stop`);
      }
      return ok();
    } catch (e) {
      if (e instanceof DockerDriverError || e instanceof ResourceError) return err(e.code, e.message);
      return err('STOP_LIVE_ERROR', (e as Error).message);
    }
  }

  async startCandidateAsLive(args: DriverOpArgs): Promise<DriverResult> {
    assertDriverArgs(args);
    if (args.signal?.aborted) return err('OPERATION_ABORTED', 'aborted before start');
    try {
      const names = this.names(args.projectId, args.deploymentId);
      const labels = this.opLabels(args.projectId, args.deploymentId, 'live');
      const v = await this.ensureLiveVolume(args.projectId, args.deploymentId, args.signal);
      if (v) return v;
      if (await resourceExists(this.runner, 'container', names.liveContainer)) {
        await this.assertLiveSlot(args.projectId, names.liveContainer);
        if (await this.containerRunning(names.liveContainer)) {
          await this.stopContainerBounded(names.liveContainer, args.signal, 10);
          if (await this.containerRunning(names.liveContainer)) {
            return err('LIVE_STILL_RUNNING', 'previous live container still running; refusing to create a second live');
          }
        }
        const rm = await this.sh(['rm', names.liveContainer], { timeoutMs: 30_000, signal: args.signal });
        if (rm.code !== 0) return err('LIVE_RM_FAILED', rm.stderr.slice(0, 300));
      }
      const runArgs = hardenedRunArgs({
        name: names.liveContainer,
        image: names.image,
        volume: names.liveVolume,
        labels,
        envFile: this.ensureEnvFile(args.projectId, args.deploymentId),
        network: this.config.network,
        role: 'live',
      });
      assertNoForbiddenFlags(runArgs);
      const r = await this.sh(runArgs, { timeoutMs: 120_000, signal: args.signal });
      if (r.aborted) {
        await this.sh(['rm', names.liveContainer], { timeoutMs: 30_000 }).catch(() => undefined);
        return err('OPERATION_ABORTED', 'startCandidateAsLive aborted');
      }
      if (r.code !== 0) return err('LIVE_START_FAILED', `docker run failed: ${r.stderr.slice(0, 500)}`);
      return await this.validateRunningContainer(names.liveContainer, labels, names.liveVolume, 'unless-stopped');
    } catch (e) {
      if (e instanceof DockerDriverError || e instanceof ResourceError) return err(e.code, e.message);
      return err('LIVE_START_ERROR', (e as Error).message);
    }
  }

  async restoreBackup(args: RestoreBackupArgs): Promise<DriverResult> {
    assertDriverArgs(args);
    const backupId = args.backupId ?? null;
    if (!isValidBackupId(backupId)) return err('INVALID_BACKUP_ID', 'restoreBackup requires a valid backupId');
    try {
      const { projectId, deploymentId } = args;
      const names = this.names(projectId, deploymentId);
      const manifest = readBackupManifest(backupDirFor(this.config.dataDir, projectId, backupId!));
      // Liberar el volumen: quitar el contenedor live detenido (si existe).
      if (await resourceExists(this.runner, 'container', names.liveContainer)) {
        await this.assertLiveSlot(projectId, names.liveContainer);
        if (await this.containerRunning(names.liveContainer)) {
          await this.stopContainerBounded(names.liveContainer, args.signal, 10);
          if (await this.containerRunning(names.liveContainer)) {
            return err('RESTORE_STOP_FAILED', 'live container still running; cannot restore');
          }
        }
        const rm = await this.sh(['rm', names.liveContainer], { timeoutMs: 30_000, signal: args.signal });
        if (rm.code !== 0) return err('RESTORE_RM_FAILED', rm.stderr.slice(0, 300));
      }
      // Recrear el volumen vacío.
      const vrm = await this.sh(['volume', 'rm', names.liveVolume], { timeoutMs: 30_000, signal: args.signal });
      if (vrm.code !== 0 && !/no such volume/i.test(vrm.stderr)) {
        return err('RESTORE_VOLUME_RM_FAILED', vrm.stderr.slice(0, 300));
      }
      const vlabels = this.opLabels(projectId, deploymentId, 'live');
      const vc = await this.sh(['volume', 'create', ...labelArgs(vlabels), names.liveVolume], {
        timeoutMs: 30_000,
        signal: args.signal,
      });
      if (vc.code !== 0) return err('RESTORE_VOLUME_CREATE_FAILED', vc.stderr.slice(0, 300));
      if (manifest.hadDatabase) {
        const bdir = backupDirFor(this.config.dataDir, projectId, backupId!);
        const tmp = `appforge-tmp-restore-${id8(deploymentId)}`;
        const cc = await this.sh(['create', '--name', tmp, '-v', `${names.liveVolume}:/data`, names.image], {
          timeoutMs: 30_000,
          signal: args.signal,
        });
        if (cc.code !== 0) return err('RESTORE_TMP_CREATE_FAILED', cc.stderr.slice(0, 300));
        try {
          for (const f of manifest.files) {
            const cp = await this.sh(['cp', path.join(bdir, f.name), `${tmp}:/data/${f.name}`], {
              timeoutMs: 120_000,
              signal: args.signal,
            });
            if (cp.code !== 0) return err('RESTORE_CP_FAILED', `restore ${f.name}: ${cp.stderr.slice(0, 200)}`);
          }
          // Verificación: extraer y comparar checksums con el manifiesto.
          const vdir = fs.mkdtempSync(path.join('/tmp', 'af-restore-verify-'));
          try {
            for (const f of manifest.files) {
              const out = path.join(vdir, f.name);
              const cp = await this.sh(['cp', `${tmp}:/data/${f.name}`, out], { timeoutMs: 120_000, signal: args.signal });
              if (cp.code !== 0) return err('RESTORE_VERIFY_CP_FAILED', `verify ${f.name}: ${cp.stderr.slice(0, 200)}`);
              const got = sha256File(out);
              if (got.sha256 !== f.sha256 || got.size !== f.size) {
                return err('RESTORE_VERIFY_MISMATCH', `restored ${f.name} checksum mismatch`);
              }
            }
          } finally {
            fs.rmSync(vdir, { recursive: true, force: true });
          }
        } finally {
          await this.sh(['rm', tmp], { timeoutMs: 30_000 }).catch(() => undefined);
        }
      }
      return ok();
    } catch (e) {
      if (e instanceof DockerDriverError || e instanceof ResourceError || e instanceof BackupError) {
        return err(e.code, e.message);
      }
      return err('RESTORE_ERROR', (e as Error).message);
    }
  }

  async startPreviousVersion(args: StartPreviousVersionArgs): Promise<DriverResult> {
    assertDriverArgs(args);
    if (args.signal?.aborted) return err('OPERATION_ABORTED', 'aborted before start');
    // previousLiveVersion es la referencia completa de imagen (la fija 7B en project_runtime).
    const prevImage = args.previousLiveVersion ?? '';
    if (!/^appforge\/app-[0-9a-f]{8}:dep-[0-9a-f]{8}-[0-9a-f]{12}$/.test(prevImage)) {
      return err('INVALID_PREVIOUS_IMAGE', 'previousLiveVersion must be a full appforge image reference');
    }
    try {
      const names = this.names(args.projectId, args.deploymentId);
      if (await resourceExists(this.runner, 'container', names.liveContainer)) {
        return err('LIVE_EXISTS', 'live container already exists; refusing to create a second one');
      }
      const labels = this.opLabels(args.projectId, args.deploymentId, 'live');
      const runArgs = hardenedRunArgs({
        name: names.liveContainer,
        image: prevImage,
        volume: names.liveVolume,
        labels,
        envFile: this.ensureEnvFile(args.projectId, args.deploymentId),
        network: this.config.network,
        role: 'live',
      });
      assertNoForbiddenFlags(runArgs);
      const r = await this.sh(runArgs, { timeoutMs: 120_000, signal: args.signal });
      if (r.aborted) {
        await this.sh(['rm', names.liveContainer], { timeoutMs: 30_000 }).catch(() => undefined);
        return err('OPERATION_ABORTED', 'startPreviousVersion aborted');
      }
      if (r.code !== 0) return err('PREVIOUS_START_FAILED', `docker run failed: ${r.stderr.slice(0, 500)}`);
      return await this.validateRunningContainer(names.liveContainer, labels, names.liveVolume, 'unless-stopped');
    } catch (e) {
      if (e instanceof DockerDriverError || e instanceof ResourceError) return err(e.code, e.message);
      return err('PREVIOUS_START_ERROR', (e as Error).message);
    }
  }

  async discardCandidate(args: DriverOpArgs): Promise<DriverResult> {
    assertDriverArgs(args);
    try {
      const names = this.names(args.projectId, args.deploymentId);
      // Nunca eliminar una imagen usada por un contenedor.
      const refs = await this.sh(
        ['ps', '-a', '--filter', `ancestor=${names.image}`, '--format', '{{.ID}}'],
        { timeoutMs: 30_000, signal: args.signal },
      );
      if (refs.code === 0 && refs.stdout.trim() !== '') {
        return err('IMAGE_REFERENCED', `image '${names.image}' is still referenced by a container; refusing to discard`);
      }
      const r = await this.sh(['rmi', names.image], { timeoutMs: 120_000, signal: args.signal });
      if (r.code !== 0) {
        if (/no such image/i.test(r.stderr)) return ok();
        return err('DISCARD_FAILED', r.stderr.slice(0, 300));
      }
      if (await resourceExists(this.runner, 'image', names.image)) {
        return err('DISCARD_FAILED', 'image still exists after rmi');
      }
      return ok();
    } catch (e) {
      if (e instanceof DockerDriverError || e instanceof ResourceError) return err(e.code, e.message);
      return err('DISCARD_ERROR', (e as Error).message);
    }
  }

  async reconcileRuntime(args: ReconcileArgs): Promise<DriverResult> {
    assertDriverArgs(args);
    try {
      // 7A: informe de solo lectura. 7B lo conectará al arranque del Studio.
      const names = this.names(args.projectId, args.deploymentId);
      const liveExists = await resourceExists(this.runner, 'container', names.liveContainer);
      let liveRunning = false;
      let liveImage = '';
      if (liveExists) {
        const info = (await inspectResource(this.runner, 'container', names.liveContainer)) as {
          Config?: { Image?: string };
          State?: { Running?: boolean };
        };
        liveRunning = info?.State?.Running === true;
        liveImage = String(info?.Config?.Image ?? '');
      }
      const volumeExists = await resourceExists(this.runner, 'volume', names.liveVolume);
      return ok({
        liveFound: String(liveExists),
        liveRunning: String(liveRunning),
        liveImage,
        volumeExists: String(volumeExists),
      });
    } catch (e) {
      if (e instanceof DockerDriverError || e instanceof ResourceError) return err(e.code, e.message);
      return err('RECONCILE_ERROR', (e as Error).message);
    }
  }

  /**
   * Poda imágenes administradas excepto las indicadas. Inspecciona todos los
   * resultados; los fallos se devuelven, nunca se ocultan. (7B lo llamará
   * tras la promoción; en 7A se prueba de forma aislada.)
   */
  async pruneManagedImages(keepImages: string[]): Promise<{ removed: string[]; failures: string[] }> {
    const keep = new Set(keepImages);
    const images = await listManagedResources(this.runner, 'image');
    const removed: string[] = [];
    const failures: string[] = [];
    for (const img of images) {
      const ref = img.name || img.id;
      if (!ref || keep.has(ref) || keep.has(img.id)) continue;
      const refs = await this.sh(['ps', '-a', '--filter', `ancestor=${img.id}`, '--format', '{{.ID}}'], {
        timeoutMs: 30_000,
      });
      if (refs.code === 0 && refs.stdout.trim() !== '') {
        failures.push(`${ref}: still referenced by a container`);
        continue;
      }
      const r = await this.sh(['rmi', img.id], { timeoutMs: 120_000 });
      if (r.code === 0) removed.push(ref);
      else failures.push(`${ref}: ${r.stderr.slice(0, 200)}`);
    }
    return { removed, failures };
  }
}
