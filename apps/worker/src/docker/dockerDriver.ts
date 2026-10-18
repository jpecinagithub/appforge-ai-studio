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

import { randomUUID, timingSafeEqual } from 'node:crypto';
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
  APPFORGE_DOCKERIGNORE,
  SnapshotError,
} from './snapshot.js';
import { persistedDynamicGateStatus, checkScopeFingerprint } from '../dynamicTools.js';
import {
  resourceNames,
  projectLiveVolumeName,
  liveVolumeLabelArgs,
  assertLiveVolumeLabels,
  labelArgs,
  assertLabelsMatch,
  assertUuid,
  assertFingerprint,
  id8,
  inspectResource,
  resourceExists,
  listManagedResources,
  MANAGED_LABEL,
  LABEL_PROJECT,
  LABEL_DEPLOYMENT,
  LABEL_ROLE,
  LABEL_FINGERPRINT,
  LABEL_COMPONENT,
  ResourceError,
  type ManagedLabels,
  type ResourceRole,
} from './resources.js';
import { hardenedRunArgs, hardenedTempVolumeArgs, assertNoForbiddenFlags } from './hardening.js';
import { writeValidatedEnvFile } from './env.js';
import {
  backupDirFor,
  writeBackupManifest,
  readBackupManifest,
  quickCheck,
  enforceRetention,
  sha256File,
  BackupError,
  type BackupManifest,
  type BackupFileEntry,
} from './sqliteBackup.js';
import { listVerificationReceipts } from '../deploy/receipts.js';
import { sanitizeSecrets } from '../secrets.js';
import {
  assertDriverArgs,
  APPFORGE_IMAGE_REF_RE,
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

/** Mensajes equivalentes emitidos por distintas versiones de `docker cp`. */
function isMissingContainerPath(stderr: string): boolean {
  return /(?:no such file|could not find the file)/i.test(stderr);
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
  /**
   * Raíz de plantillas confiables (p. ej. `<repo>/templates`). El Dockerfile
   * usado en el build se compara byte a byte con
   * `<templatesDir>/dynamic-react-node/Dockerfile`. Vacío o ausente → el
   * build falla cerrado (nunca se confía en un Dockerfile del proyecto sin
   * verificar).
   */
  templatesDir?: string;
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
    templatesDir: (env.APPFORGE_TEMPLATES_DIR ?? '').trim(),
  };
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
 * Normaliza la arquitectura reportada por Docker a los identificadores
 * canónicos usados en los inspect de imagen (`amd64`/`arm64`).
 * `docker info` devuelve `x86_64`/`aarch64`; el inspect de imagen,
 * `amd64`/`arm64`. Cualquier otro valor se devuelve tal cual (la
 * comparación posterior lo rechazará).
 */
export function normalizeArch(raw: string): string {
  const a = raw.trim().toLowerCase();
  if (a === 'x86_64' || a === 'amd64') return 'amd64';
  if (a === 'aarch64' || a === 'arm64') return 'arm64';
  return a;
}

/**
 * Arquitectura del daemon Docker (`docker info --format '{{.Architecture}}'`).
 * La usa el preflight (diagnóstico) y la validación posterior de
 * contenedores (la imagen debe coincidir con el daemon/host).
 */
export async function detectDaemonArchitecture(runner: DockerCommandRunner): Promise<string> {
  const r = await runner.run({ args: ['info', '--format', '{{.Architecture}}'], timeoutMs: 15_000 });
  if (r.code !== 0 || r.timedOut || r.aborted) {
    throw new DockerDriverError(
      'DAEMON_ARCH_UNKNOWN',
      `cannot detect docker daemon architecture: ${r.stderr.slice(0, 200)}`,
    );
  }
  const arch = normalizeArch(r.stdout);
  if (!arch) {
    throw new DockerDriverError('DAEMON_ARCH_UNKNOWN', 'docker daemon reported an empty architecture');
  }
  return arch;
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
  // Arquitectura del daemon/host (revisión Codex, NO-GO 2, bloqueo 5): la
  // validación posterior exige que la imagen coincida con esta arquitectura.
  let daemonArch: string;
  try {
    daemonArch = await detectDaemonArchitecture(runner);
  } catch (e) {
    return fail((e as Error).message);
  }
  diagnostics.push(`docker daemon architecture: ${daemonArch} (server ${serverVersion})`);
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.accessSync(config.dataDir, fs.constants.W_OK);
  } catch {
    return fail('data dir not writable');
  }
  // Red interna: si ya existe, inspeccionar y exigir propiedad EXACTA
  // (managed + componente + interna). Ante colisión o labels ajenas →
  // fallar SIN modificar el recurso (revisión Codex, Fase 7A).
  const netInspect = await runner.run({
    args: ['network', 'inspect', config.network],
    timeoutMs: 15_000,
  });
  if (netInspect.code === 0) {
    let net: { Internal?: boolean; Labels?: Record<string, string> };
    try {
      const arr = JSON.parse(netInspect.stdout) as unknown[];
      net = (Array.isArray(arr) && arr.length > 0 ? arr[0] : {}) as typeof net;
    } catch {
      return fail(`cannot parse inspect of existing network '${config.network}'`);
    }
    const labels = net.Labels ?? {};
    if (labels[MANAGED_LABEL] !== 'true' || labels[LABEL_COMPONENT] !== 'network') {
      return fail(
        `network '${config.network}' exists with foreign/missing labels; refusing to adopt or modify it`,
      );
    }
    if (net.Internal !== true) {
      return fail(`network '${config.network}' exists but is not internal; refusing to use it`);
    }
    diagnostics.push(`using existing internal network '${config.network}'`);
  } else {
    const created = await runner.run({
      args: [
        'network',
        'create',
        '--internal',
        '--label',
        `${MANAGED_LABEL}=true`,
        '--label',
        `${LABEL_COMPONENT}=network`,
        config.network,
      ],
      timeoutMs: 30_000,
    });
    if (created.code !== 0) {
      return fail(`cannot create docker network '${config.network}': ${created.stderr.slice(0, 200)}`);
    }
    diagnostics.push(`created internal network '${config.network}'`);
  }
  // Volumen de datos del Studio: igual exigencia de propiedad exacta.
  const volInspect = await runner.run({
    args: ['volume', 'inspect', config.dataVolume],
    timeoutMs: 15_000,
  });
  if (volInspect.code === 0) {
    let vol: { Labels?: Record<string, string> };
    try {
      const arr = JSON.parse(volInspect.stdout) as unknown[];
      vol = (Array.isArray(arr) && arr.length > 0 ? arr[0] : {}) as typeof vol;
    } catch {
      return fail(`cannot parse inspect of existing volume '${config.dataVolume}'`);
    }
    const labels = vol.Labels ?? {};
    if (labels[MANAGED_LABEL] !== 'true' || labels[LABEL_COMPONENT] !== 'studio-data') {
      return fail(
        `data volume '${config.dataVolume}' exists with foreign/missing labels; refusing to adopt or modify it`,
      );
    }
    diagnostics.push(`using existing data volume '${config.dataVolume}'`);
  } else {
    const created = await runner.run({
      args: [
        'volume',
        'create',
        '--label',
        `${MANAGED_LABEL}=true`,
        '--label',
        `${LABEL_COMPONENT}=studio-data`,
        config.dataVolume,
      ],
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
  /**
   * Obligatoria (revisión Codex, Fase 7A): el driver real exige acceso a
   * los seis receipts canónicos de `verification_receipts`. Sin DB, el
   * constructor lanza `RECEIPT_DB_REQUIRED` (fail closed).
   */
  db: Database.Database;
}

const BUILD_TIMEOUT_MS = 600_000;
const MIGRATION_TIMEOUT_MS = 300_000;
const HEALTH_ATTEMPTS = 12;
const HEALTH_INTERVAL_MS = 5_000;
const HEALTH_REQUEST_MS = 10_000;

/**
 * Valores exactos permitidos de PidMode/IpcMode (revisión Codex, NO-GO 2,
 * bloqueo 5). Los contenedores endurecidos se crean sin `--pid`/`--ipc`,
 * por lo que `docker inspect` solo muestra los valores por defecto:
 * PidMode `""` e IpcMode `"private"` (algunas versiones reportan `""`).
 */
const ALLOWED_PID_MODES = new Set(['', 'private']);
const ALLOWED_IPC_MODES = new Set(['', 'private']);

function err(code: string, message: string): DriverResult {
  return { ok: false, code, error: sanitizeSecrets(message).slice(0, 2000) };
}

function ok(data?: Record<string, string>): DriverResult {
  return { ok: true, data };
}

/** Opaque, API-safe metadata. Host paths and manifest filenames never leave the driver. */
function validatedBackupData(manifest: BackupManifest): Record<string, string> {
  return {
    backupId: manifest.backupId,
    backupValidated: 'true',
    createdAt: manifest.createdAt,
    sizeBytes: String(manifest.files.reduce((total, file) => total + file.size, 0)),
    hadDatabase: String(manifest.hadDatabase),
  };
}

export class DockerDeploymentDriver implements DeploymentDriver {
  readonly name = 'docker';
  readonly maxConcurrentDeploys: number;
  readonly requiresCandidateVersion = true;
  private readonly runner: DockerCommandRunner;
  private readonly config: DockerDriverConfig;
  /**
   * Revisión Codex (Fase 7A): el driver real EXIGE la DB. Sin acceso a los
   * seis receipts canónicos de `verification_receipts`, la puerta de
   * verificación no puede abrirse y el driver ni siquiera se construye
   * (fail closed en el constructor, nunca puerta desactivada en silencio).
   */
  private readonly db: Database.Database;
  /**
   * Arquitectura del daemon/host, detectada una vez por proceso-driver
   * (revisión Codex, NO-GO 2, bloqueo 5): `validateRunningContainer` exige
   * que la imagen del contenedor coincida EXACTAMENTE con ella.
   */
  private daemonArch: string | null = null;

  /** Arquitectura del daemon (cacheada); lanza si no puede detectarse. */
  private async getDaemonArch(): Promise<string> {
    if (this.daemonArch === null) {
      this.daemonArch = await detectDaemonArchitecture(this.runner);
    }
    return this.daemonArch;
  }

  constructor(config: DockerDriverConfig, opts: DockerDriverOptions = {} as DockerDriverOptions) {
    this.config = config;
    this.maxConcurrentDeploys = config.maxConcurrentDeploys;
    this.runner = opts.runner ?? new DockerCommandRunner({ dockerBin: config.dockerBin });
    if (!opts.db) {
      throw new DockerDriverError(
        'RECEIPT_DB_REQUIRED',
        'DockerDeploymentDriver requires a database handle for the six verification receipts (fail closed)',
      );
    }
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

  /**
   * Columnas aditivas del snapshot en deployments (idempotente). Revisión
   * Codex (Fase 7A): se persisten POR SEPARADO el fingerprint de fuentes
   * verificado por la puerta (`verified_source_fingerprint`) y el
   * fingerprint del contenido del snapshot (`snapshot_fingerprint`).
   */
  private ensureSnapshotColumns(): void {
    for (const ddl of [
      'ALTER TABLE deployments ADD COLUMN snapshot_fingerprint TEXT',
      'ALTER TABLE deployments ADD COLUMN snapshot_path TEXT',
      'ALTER TABLE deployments ADD COLUMN verified_source_fingerprint TEXT',
    ]) {
      try {
        this.db.exec(ddl);
      } catch {
        /* la columna ya existe */
      }
    }
  }

  private persistSnapshot(
    deploymentId: string,
    verifiedSourceFingerprint: string,
    snapshotFingerprint: string,
    snapshotPath: string,
  ): void {
    this.ensureSnapshotColumns();
    this.db
      .prepare(
        'UPDATE deployments SET verified_source_fingerprint=?, snapshot_fingerprint=?, snapshot_path=? WHERE id=?',
      )
      .run(verifiedSourceFingerprint, snapshotFingerprint, snapshotPath, deploymentId);
  }

  /**
   * Backup_ids que la retención NO debe eliminar (revisión Codex, NO-GO 2,
   * bloqueo 1): backups referenciados por deployments activos (no
   * terminales, incluido un rollback pendiente) y el backup del último
   * despliegue `live` (objetivo de un eventual rollback). Se leen de
   * SQLite. Si la lectura falla, se falla cerrado: ejecutar retención sin
   * conocer los protegidos podría borrar el único rollback recuperable.
   */
  private protectedBackupIds(projectId: string): Set<string> {
    const ids = new Set<string>();
    try {
      const active = this.db
        .prepare(
          `SELECT backup_id FROM deployments WHERE project_id = ? AND backup_id IS NOT NULL
           AND status IN ('pending','building','migrating','verifying','promoting')`,
        )
        .all(projectId) as Array<{ backup_id: string }>;
      for (const r of active) {
        if (isValidBackupId(r.backup_id)) ids.add(r.backup_id);
      }
      const lastLive = this.db
        .prepare(
          `SELECT backup_id FROM deployments WHERE project_id = ? AND status = 'live'
           AND backup_id IS NOT NULL
           ORDER BY COALESCE(finished_at, updated_at, started_at, '') DESC, id DESC LIMIT 1`,
        )
        .get(projectId) as { backup_id: string } | undefined;
      if (lastLive && isValidBackupId(lastLive.backup_id)) ids.add(lastLive.backup_id);
    } catch (e) {
      throw new DockerDriverError(
        'BACKUP_RETENTION_STATE_ERROR',
        `cannot determine protected backups; retention skipped: ${(e as Error).message}`,
      );
    }
    return ids;
  }

  /** Registro persistido del snapshot para verificar reutilizaciones. */
  private readPersistedSnapshot(deploymentId: string): {
    verifiedSourceFingerprint: string | null;
    snapshotFingerprint: string | null;
    snapshotPath: string | null;
  } | null {
    this.ensureSnapshotColumns();
    try {
      const row = this.db
        .prepare(
          'SELECT verified_source_fingerprint, snapshot_fingerprint, snapshot_path FROM deployments WHERE id=?',
        )
        .get(deploymentId) as
        | { verified_source_fingerprint: string | null; snapshot_fingerprint: string | null; snapshot_path: string | null }
        | undefined;
      if (!row) return null;
      return {
        verifiedSourceFingerprint: row.verified_source_fingerprint,
        snapshotFingerprint: row.snapshot_fingerprint,
        snapshotPath: row.snapshot_path,
      };
    } catch {
      return null;
    }
  }

  /**
   * Puerta de receipts REAL (revisión Codex, Fase 7A): exige los SEIS
   * receipts canónicos de `verification_receipts`, en orden canónico y
   * vigentes sobre las fuentes actuales (delegado en
   * `persistedDynamicGateStatus`, la misma puerta autoritativa de la ruta
   * HTTP). Fail closed: ausencia de receipts, orden incorrecto,
   * fingerprints distintos, scopes no vigentes o error de lectura NUNCA
   * desactivan la puerta; siempre lanzan `DockerDriverError`.
   *
   * Devuelve el fingerprint raíz (`authenticatedFlow`, scope = proyecto
   * completo) para ligar el snapshot a las fuentes verificadas.
   */
  private verifyReceiptGate(projectId: string, projectDir: string): { rootFingerprint: string } {
    let gate: { ok: boolean; reason?: string };
    try {
      gate = persistedDynamicGateStatus(this.db, projectDir, projectId);
    } catch (e) {
      throw new DockerDriverError(
        'RECEIPT_GATE_ERROR',
        `cannot read verification receipts (fail closed): ${(e as Error).message}`,
      );
    }
    if (!gate.ok) {
      throw new DockerDriverError('RECEIPT_GATE_FAILED', gate.reason ?? 'verification receipts gate failed');
    }
    const receipts = listVerificationReceipts(this.db, projectId);
    const root = receipts.find((r) => r.checkKey === 'authenticatedFlow');
    if (!root || typeof root.fingerprint !== 'string' || root.fingerprint.length === 0) {
      throw new DockerDriverError('RECEIPT_GATE_FAILED', 'authenticatedFlow root receipt missing after gate check');
    }
    return { rootFingerprint: root.fingerprint };
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
        if (isMissingContainerPath(raw.stderr)) return ok({ candidateVersion: image });
        return err('SCAN_CP_FAILED', raw.stderr.slice(0, 300));
      }
      if (raw.truncated) return err('IMAGE_SCAN_TRUNCATED', 'image /app too large to scan');
      const bad = DockerDeploymentDriver.scanTarForForbidden(raw.stdoutBytes);
      if (bad) return err('IMAGE_FORBIDDEN_FILE', `image contains forbidden file: ${bad}`);
      return ok({ candidateVersion: image });
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
      // Puerta autoritativa (revisión Codex, Fase 7A): seis receipts reales
      // de `verification_receipts`, en orden canónico y vigentes sobre las
      // fuentes actuales. Fail closed: nunca se abre por defecto.
      let gate: { rootFingerprint: string };
      try {
        gate = this.verifyReceiptGate(projectId, projectDir);
      } catch (e) {
        if (e instanceof DockerDriverError) return err(e.code, e.message);
        return err('RECEIPT_GATE_ERROR', (e as Error).message);
      }
      // Fingerprint raíz (receipt `authenticatedFlow`, scope = proyecto
      // completo) ANTES de crear el snapshot.
      const rootFpBefore = checkScopeFingerprint(projectDir, 'authenticatedFlow');
      if (rootFpBefore === null || rootFpBefore !== gate.rootFingerprint) {
        return err('RECEIPT_FINGERPRINT_MISMATCH', 'project sources changed after the verification gate');
      }
      // Idempotencia antes de tocar el snapshot.
      const manifestPath = path.join(this.snapshotDir(deploymentId), '.appforge-manifest.json');
      if (fs.existsSync(manifestPath)) {
        return await this.reuseSnapshot(args, gate.rootFingerprint);
      }
      const snap = createSnapshot({ projectDir, snapshotsRoot: this.snapshotsRoot(), deploymentId });
      // Las fuentes no pueden haber mutado durante la copia del snapshot;
      // si lo hicieron, el snapshot se descarta (fail closed).
      const rootFpAfter = checkScopeFingerprint(projectDir, 'authenticatedFlow');
      if (rootFpAfter === null || rootFpAfter !== rootFpBefore) {
        fs.rmSync(snap.dir, { recursive: true, force: true });
        return err(
          'SOURCE_MUTATED_DURING_SNAPSHOT',
          'project sources changed while creating the snapshot; snapshot discarded',
        );
      }
      this.persistSnapshot(deploymentId, rootFpBefore, snap.fingerprint, snap.dir);
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
   * Reutilización de snapshot (revisión Codex, Fase 7A): el manifiesto es
   * editable y NO basta. Se comprueba contra SQLite la ruta registrada, el
   * fingerprint del snapshot y el fingerprint de fuentes verificado, y se
   * re-hasea el contenido real con `verifySnapshot`.
   */
  private async reuseSnapshot(args: DriverOpArgs, rootFingerprint: string): Promise<DriverResult> {
    const { deploymentId, projectId } = args;
    const dir = this.snapshotDir(deploymentId);
    const rec = this.readPersistedSnapshot(deploymentId);
    if (!rec || !rec.snapshotFingerprint || !rec.snapshotPath) {
      return err(
        'SNAPSHOT_DB_MISMATCH',
        'no persisted snapshot record for this deployment; refusing to reuse an unverified snapshot',
      );
    }
    if (path.resolve(rec.snapshotPath) !== path.resolve(dir)) {
      return err('SNAPSHOT_DB_MISMATCH', 'snapshot path does not match the persisted record');
    }
    let fp: string;
    try {
      fp = verifySnapshot(dir);
    } catch (e) {
      if (e instanceof SnapshotError) return err('SNAPSHOT_FAILED', `${e.code}: ${(e as Error).message}`);
      throw e;
    }
    if (fp !== rec.snapshotFingerprint) {
      return err('SNAPSHOT_DB_MISMATCH', 'snapshot content fingerprint does not match the persisted record');
    }
    // Revisión Codex (NO-GO 2, bloqueo 6): verified_source_fingerprint debe
    // estar presente Y bien formado; no basta con comprobarlo solo cuando
    // sea truthy. Ausente, NULL, vacío, malformado o distinto → fail closed.
    const vsfp = rec.verifiedSourceFingerprint;
    if (typeof vsfp !== 'string' || !/^[0-9a-f]{64}$/i.test(vsfp)) {
      return err(
        'SNAPSHOT_SOURCE_FP_INVALID',
        'persisted verified_source_fingerprint is missing or malformed; refusing to reuse snapshot (fail closed)',
      );
    }
    if (vsfp.toLowerCase() !== rootFingerprint.toLowerCase()) {
      return err('SNAPSHOT_SOURCE_MISMATCH', 'snapshot was built from different verified sources');
    }
    // El Dockerfile confiable y el .dockerignore controlado también se
    // verifican al reutilizar (no solo al construir): el manifiesto no los
    // hasea y son editables en disco.
    try {
      this.assertTrustedDockerfile(dir);
    } catch (e) {
      if (e instanceof DockerDriverError) return err(e.code, e.message);
      return err('DOCKERFILE_VERIFY_ERROR', (e as Error).message);
    }
    const reused = await this.reuseBuiltImage(projectId, deploymentId, fp);
    if (reused) return reused;
    // Snapshot verificado pero imagen ausente: reconstruir desde él.
    return await this.buildFromSnapshot(args, dir, fp);
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

  /**
   * Dockerfile confiable (revisión Codex, Fase 7A): el proyecto NUNCA puede
   * aportar un Dockerfile arbitrario. El usado en el build debe ser byte a
   * byte idéntico al de la plantilla confiable
   * `<templatesDir>/dynamic-react-node/Dockerfile`. Sin templatesDir o sin
   * plantilla legible → fail closed.
   */
  private trustedDockerfileBytes(): Buffer {
    const tdir = (this.config.templatesDir ?? '').trim();
    if (!tdir) {
      throw new DockerDriverError(
        'TEMPLATES_DIR_REQUIRED',
        'cannot verify the Dockerfile without a trusted templates dir (fail closed)',
      );
    }
    const p = path.join(tdir, 'dynamic-react-node', 'Dockerfile');
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) throw new Error('not a file');
      return fs.readFileSync(p);
    } catch {
      throw new DockerDriverError(
        'TRUSTED_DOCKERFILE_MISSING',
        `trusted template Dockerfile not readable: ${p}`,
      );
    }
  }

  /** Compara byte a byte el Dockerfile del snapshot con el de la plantilla. */
  private assertTrustedDockerfile(snapDir: string): void {
    const dockerfile = path.join(snapDir, 'Dockerfile');
    let actual: Buffer;
    try {
      const st = fs.statSync(dockerfile);
      if (!st.isFile()) throw new Error('not a file');
      actual = fs.readFileSync(dockerfile);
    } catch {
      throw new DockerDriverError('DOCKERFILE_MISSING', 'controlled Dockerfile not found in snapshot');
    }
    const trusted = this.trustedDockerfileBytes();
    if (actual.length !== trusted.length || !timingSafeEqual(actual, trusted)) {
      throw new DockerDriverError(
        'DOCKERFILE_UNTRUSTED',
        'snapshot Dockerfile differs from the trusted template (byte comparison); refusing to build',
      );
    }
    // El .dockerignore controlado también forma parte de la integridad.
    const diPath = path.join(snapDir, '.dockerignore');
    let diActual: string;
    try {
      diActual = fs.readFileSync(diPath, 'utf8');
    } catch {
      throw new DockerDriverError('DOCKERIGNORE_MISSING', 'controlled .dockerignore not found in snapshot');
    }
    if (diActual !== APPFORGE_DOCKERIGNORE) {
      throw new DockerDriverError(
        'DOCKERIGNORE_UNTRUSTED',
        'snapshot .dockerignore differs from the AppForge-controlled content; refusing to build',
      );
    }
  }

  /** Construye la imagen desde un snapshot ya verificado. */
  private async buildFromSnapshot(
    args: DriverOpArgs,
    snapDir: string,
    fp: string,
  ): Promise<DriverResult> {
    const { deploymentId, projectId } = args;
    try {
      this.assertTrustedDockerfile(snapDir);
    } catch (e) {
      if (e instanceof DockerDriverError) return err(e.code, e.message);
      return err('DOCKERFILE_VERIFY_ERROR', (e as Error).message);
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

  /**
   * Crea el volumen live con labels ESTABLES por proyecto (revisión Codex,
   * Fase 7A): managed + project-id + rol live. Sin deployment-id ni
   * fingerprint: dos despliegues consecutivos comparten el volumen y los
   * datos. Sin él, `docker run -v` lo autocrearía SIN labels y quedaría
   * fuera del inventario managed.
   */
  private async ensureLiveVolume(projectId: string, signal?: AbortSignal): Promise<DriverResult | null> {
    const liveVolume = projectLiveVolumeName(projectId);
    if (await resourceExists(this.runner, 'volume', liveVolume)) {
      const info = (await inspectResource(this.runner, 'volume', liveVolume)) as {
        Labels?: Record<string, string>;
      };
      try {
        assertLiveVolumeLabels(info?.Labels, projectId);
      } catch {
        return err('FOREIGN_RESOURCE', `refusing to use live volume '${liveVolume}' with non-matching labels`);
      }
      return null;
    }
    const c = await this.sh(['volume', 'create', ...liveVolumeLabelArgs(projectId), liveVolume], {
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
      const v = await this.ensureLiveVolume(args.projectId, args.signal);
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
      Config?: { Labels?: Record<string, string>; User?: string; Image?: string };
      State?: { Running?: boolean };
      Mounts?: Array<{ Type?: string; Name?: string; Source?: string; Destination?: string }>;
      NetworkSettings?: { Networks?: Record<string, unknown>; Ports?: Record<string, unknown[]> };
      HostConfig?: {
        Memory?: number;
        MemorySwap?: number;
        NanoCpus?: number;
        PidsLimit?: number;
        CapDrop?: string[];
        SecurityOpt?: string[];
        ReadonlyRootfs?: boolean;
        RestartPolicy?: { Name?: string };
        Privileged?: boolean;
        Devices?: unknown[];
        PidMode?: string;
        IpcMode?: string;
        NetworkMode?: string;
        Tmpfs?: Record<string, string>;
      };
    };
    try {
      assertLabelsMatch(info?.Config?.Labels, labels);
    } catch {
      return err('CONTAINER_LABEL_MISMATCH', `container '${name}' labels do not match`);
    }
    if (info?.State?.Running !== true) return err('CONTAINER_NOT_RUNNING', `container '${name}' is not running`);
    // Arquitectura y SO de la imagen (revisión Codex, Fase 7A).
    const imageName = String(info?.Config?.Image ?? '');
    if (!imageName) return err('CONTAINER_IMAGE_UNKNOWN', `container '${name}' has no image reference`);
    let imgInfo: { Os?: string; Architecture?: string };
    try {
      imgInfo = (await inspectResource(this.runner, 'image', imageName)) as typeof imgInfo;
    } catch {
      return err('IMAGE_INSPECT_FAILED', `cannot inspect image '${imageName}'`);
    }
    if (String(imgInfo?.Os ?? '').toLowerCase() !== 'linux') {
      return err('IMAGE_OS_MISMATCH', `image OS is '${imgInfo?.Os}', expected linux`);
    }
    // Arquitectura y SO de la imagen (revisión Codex, Fase 7A + NO-GO 2):
    // la imagen debe ser linux/amd64|arm64 Y coincidir EXACTAMENTE con la
    // arquitectura del daemon/host detectada en preflight.
    const arch = normalizeArch(String(imgInfo?.Architecture ?? ''));
    if (arch !== 'amd64' && arch !== 'arm64') {
      return err('IMAGE_ARCH_MISMATCH', `image architecture '${imgInfo?.Architecture}' is not supported (amd64/arm64)`);
    }
    let hostArch: string;
    try {
      hostArch = await this.getDaemonArch();
    } catch (e) {
      return err('DAEMON_ARCH_UNKNOWN', (e as Error).message);
    }
    if (arch !== hostArch) {
      return err(
        'IMAGE_ARCH_MISMATCH',
        `image architecture '${arch}' does not match docker daemon/host architecture '${hostArch}'`,
      );
    }
    const mounts = info?.Mounts ?? [];
    if (!mounts.some((m) => m?.Name === volume && m?.Destination === '/data')) {
      return err('CONTAINER_MOUNT_MISMATCH', `container '${name}' does not mount '${volume}' at /data`);
    }
    // Mounts exactos: solo /data (volumen propio) y /tmp (tmpfs). Nada más.
    for (const m of mounts) {
      const dest = String(m?.Destination ?? '');
      if (dest !== '/data' && dest !== '/tmp') {
        return err('CONTAINER_MOUNT_UNEXPECTED', `container '${name}' has unexpected mount at '${dest}'`);
      }
      const src = String(m?.Source ?? m?.Name ?? '');
      if (src.includes('docker.sock')) {
        return err('CONTAINER_SOCKET_MOUNT', `container '${name}' mounts the docker socket`);
      }
      if (src === this.config.dataVolume) {
        return err('CONTAINER_STUDIO_VOLUME_MOUNT', `container '${name}' mounts the Studio data volume`);
      }
    }
    // Red: EXACTAMENTE una, la interna configurada (revisión Codex, NO-GO 2,
    // bloqueo 5). Una red adicional (p. ej. bridge) es un escape del
    // aislamiento y se rechaza.
    const networks = Object.keys(info?.NetworkSettings?.Networks ?? {});
    if (networks.length !== 1 || networks[0] !== this.config.network) {
      return err(
        'CONTAINER_NETWORK_MISMATCH',
        `container '${name}' must be attached to exactly one network ('${this.config.network}'); found: ${networks.join(',') || 'none'}`,
      );
    }
    const hc = info?.HostConfig ?? {};
    // El tmpfs de `--tmpfs` puede aparecer en `Mounts` (Type=tmpfs) o solo
    // en `HostConfig.Tmpfs` según la versión de Docker; se acepta cualquiera
    // de las dos representaciones (ambas salen del flag --tmpfs auditado).
    // Pero si hay un mount en /tmp, DEBE ser tmpfs (no un volumen encubierto).
    const tmpfsMount = mounts.find((m) => m?.Destination === '/tmp');
    const hasHostTmpfs = Object.prototype.hasOwnProperty.call(hc.Tmpfs ?? {}, '/tmp');
    if (tmpfsMount !== undefined && tmpfsMount.Type !== 'tmpfs') {
      return err('CONTAINER_TMPFS_MISMATCH', `container '${name}' has non-tmpfs mount at /tmp`);
    }
    if (tmpfsMount === undefined && !hasHostTmpfs) {
      return err('CONTAINER_TMPFS_MISMATCH', `container '${name}' has no tmpfs at /tmp`);
    }
    if (hc.Memory !== 512 * 1024 * 1024) return err('CONTAINER_LIMIT_MISMATCH', `memory is ${hc.Memory}`);
    if (hc.MemorySwap !== 512 * 1024 * 1024) {
      return err('CONTAINER_SWAP_MISMATCH', `memory-swap is ${hc.MemorySwap}, expected 512m (swap capped)`);
    }
    if (hc.NanoCpus !== 1_000_000_000) return err('CONTAINER_LIMIT_MISMATCH', `cpus is ${hc.NanoCpus}`);
    if (hc.PidsLimit !== 128) return err('CONTAINER_LIMIT_MISMATCH', `pids-limit is ${hc.PidsLimit}`);
    if (!Array.isArray(hc.CapDrop) || !hc.CapDrop.includes('ALL')) return err('CONTAINER_CAP_MISMATCH', 'cap-drop ALL missing');
    if (!Array.isArray(hc.SecurityOpt) || !hc.SecurityOpt.some((s) => s.includes('no-new-privileges'))) {
      return err('CONTAINER_SECOPT_MISMATCH', 'no-new-privileges missing');
    }
    if (hc.ReadonlyRootfs !== true) return err('CONTAINER_READONLY_MISMATCH', 'read-only rootfs not set');
    if (hc.Privileged === true) return err('CONTAINER_PRIVILEGED', `container '${name}' is privileged`);
    // Devices: debe estar EXPLÍCITAMENTE vacío (revisión Codex, NO-GO 2,
    // bloqueo 5). Ausente o con dispositivos → rechazado.
    if (!Array.isArray(hc.Devices) || hc.Devices.length !== 0) {
      return err('CONTAINER_DEVICES', `container '${name}' must have an explicitly empty Devices list`);
    }
    // PidMode/IpcMode: solo los valores exactos permitidos (revisión Codex,
    // NO-GO 2, bloqueo 5). Nuestros contenedores se crean sin --pid/--ipc,
    // así que solo aparecen los valores por defecto de Docker.
    if (!ALLOWED_PID_MODES.has(String(hc.PidMode ?? ''))) {
      return err('CONTAINER_PID_MODE', `container '${name}' has disallowed PidMode '${hc.PidMode}'`);
    }
    if (!ALLOWED_IPC_MODES.has(String(hc.IpcMode ?? ''))) {
      return err('CONTAINER_IPC_MODE', `container '${name}' has disallowed IpcMode '${hc.IpcMode}'`);
    }
    if (hc.NetworkMode !== this.config.network) {
      return err('CONTAINER_NETWORKMODE_MISMATCH', `network mode is '${hc.NetworkMode}', expected '${this.config.network}'`);
    }
    if (hc.RestartPolicy?.Name !== expectRestart) {
      return err('CONTAINER_RESTART_MISMATCH', `restart policy is '${hc.RestartPolicy?.Name}'`);
    }
    const ports = info?.NetworkSettings?.Ports ?? {};
    if (Object.values(ports).some((b) => Array.isArray(b) && b.length > 0)) {
      return err('CONTAINER_PORTS_PUBLISHED', `container '${name}' publishes host ports`);
    }
    // Usuario exacto 1001 (el endurecimiento lo fija con --user 1001).
    if (String(info?.Config?.User ?? '') !== '1001') {
      return err('CONTAINER_USER_MISMATCH', `container '${name}' user is '${info?.Config?.User}', expected '1001'`);
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
      const hasPrevious =
        typeof args.previousLiveVersion === 'string' && APPFORGE_IMAGE_REF_RE.test(args.previousLiveVersion);
      const liveContainerExists = await resourceExists(this.runner, 'container', names.liveContainer);
      if (!liveContainerExists) {
        const liveVolumeExists = await resourceExists(this.runner, 'volume', names.liveVolume);
        // hadDatabase=false SOLO si no hay versión anterior, ni contenedor
        // live, ni volumen live con datos (revisión Codex, NO-GO 2, bloqueo
        // 2). "Contenedor live ausente" NO equivale a "primer despliegue".
        if (!hasPrevious && !liveVolumeExists) {
          const manifest: BackupManifest = { backupId, projectId, deploymentId, createdAt: stamp, hadDatabase: false, files: [] };
          writeBackupManifest(dir, manifest);
          enforceRetention({ dataDir: this.config.dataDir, projectId, protectedIds: this.protectedBackupIds(projectId) });
          return ok(validatedBackupData(manifest));
        }
        if (liveVolumeExists) {
          // Volumen live huérfano (existe sin contenedor): verificar sus
          // labels y respaldar sus datos con un contenedor temporal
          // endurecido.
          const info = (await inspectResource(this.runner, 'volume', names.liveVolume)) as {
            Labels?: Record<string, string>;
          };
          try {
            assertLiveVolumeLabels(info?.Labels, projectId);
          } catch {
            return err('FOREIGN_RESOURCE', `refusing to back up foreign live volume '${names.liveVolume}'`);
          }
          return await this.backupOrphanLiveVolume(args, names.liveVolume, backupId, stamp);
        }
        // Una versión anterior persistida sin contenedor ni volumen es una
        // inconsistencia peligrosa, no un primer despliegue vacío. Afirmar
        // hadDatabase=false aquí permitiría que el rollback borrase datos.
        return err(
          'LIVE_DATA_MISSING',
          'previousLiveVersion exists but both live container and live volume are missing; refusing an empty backup',
        );
      }
      await this.assertLiveSlot(projectId, names.liveContainer);
      // Detener de forma controlada antes de copiar.
      await this.stopContainerBounded(names.liveContainer, args.signal, 30);
      if (await this.containerRunning(names.liveContainer)) {
        return err('BACKUP_STOP_FAILED', 'live container did not stop before backup');
      }
      // A partir de aquí el live está detenido: cualquier fallo o abort debe
      // intentar re-levantarlo y verificar health ANTES de devolver el error.
      // Nunca se deja el servicio parado por un backup fallido (bloqueo 2).
      try {
        const copied = await this.copyDatabaseFilesFromContainer(args, names.liveContainer, dir);
        if (!copied.some((c) => c.name === 'app.db')) {
          throw new DockerDriverError('BACKUP_SOURCE_MISSING', 'live container has no app.db');
        }
        try {
          quickCheck(path.join(dir, 'app.db'));
        } catch (e) {
          throw new DockerDriverError('BACKUP_QUICK_CHECK_FAILED', (e as Error).message);
        }
        const manifest: BackupManifest = { backupId, projectId, deploymentId, createdAt: stamp, hadDatabase: true, files: copied };
        writeBackupManifest(dir, manifest);
        // Retención real (revisión Codex, NO-GO 2, bloqueo 1): se protegen los
        // backups referenciados por deployments activos y por el último live.
        enforceRetention({ dataDir: this.config.dataDir, projectId, protectedIds: this.protectedBackupIds(projectId) });
        return ok(validatedBackupData(manifest));
      } catch (e) {
        const backupErr =
          e instanceof DockerDriverError || e instanceof ResourceError || e instanceof BackupError
            ? err(e.code, e.message)
            : err('BACKUP_ERROR', (e as Error).message);
        const recovered = await this.recoverStoppedLive(args, names.liveContainer);
        if (!recovered.ok) {
          return err(
            'BACKUP_RECOVERY_FAILED',
            `backup failed (${backupErr.code}); live recovery also failed (${recovered.code}): ${recovered.error} — service may be down`,
          );
        }
        // El live se re-levantó y pasó health: se devuelve el error ORIGINAL
        // del backup, sin ocultar que hubo recuperación.
        return err(backupErr.code ?? 'BACKUP_ERROR', `${backupErr.error} (live container restarted and healthy)`);
      }
    } catch (e) {
      if (e instanceof DockerDriverError || e instanceof ResourceError || e instanceof BackupError) {
        return err(e.code, e.message);
      }
      return err('BACKUP_ERROR', (e as Error).message);
    }
  }

  /**
   * Copia `app.db` (+ `app.db-wal` si existe) desde un contenedor al
   * directorio del backup, con chown 1001 y SHA-256 por fichero. Lanza
   * `DockerDriverError` ante cualquier problema (el llamador decide si
   * `app.db` ausente es error o `hadDatabase=false`).
   */
  private async copyDatabaseFilesFromContainer(
    args: LiveBackupArgs,
    containerName: string,
    dir: string,
  ): Promise<Array<{ name: string; size: number; sha256: string }>> {
    fs.mkdirSync(dir, { recursive: true });
    const copied: Array<{ name: string; size: number; sha256: string }> = [];
    // Solo app.db + app.db-wal: el -shm es memoria compartida transitoria
    // (SQLite lo recrea al abrir); su checksum no es estable entre copias.
    for (const f of ['app.db', 'app.db-wal']) {
      const dest = path.join(dir, f);
      const cp = await this.sh(['cp', `${containerName}:/data/${f}`, dest], {
        timeoutMs: 120_000,
        signal: args.signal,
      });
      if (cp.aborted) throw new DockerDriverError('OPERATION_ABORTED', 'backup aborted during copy');
      if (cp.timedOut) throw new DockerDriverError('BACKUP_CP_TIMEOUT', `docker cp ${f} timed out`);
      if (cp.code !== 0) {
        if (isMissingContainerPath(cp.stderr)) continue;
        throw new DockerDriverError('BACKUP_CP_FAILED', `docker cp ${f}: ${cp.stderr.slice(0, 200)}`);
      }
      try {
        fs.chownSync(dest, 1001, 1001);
      } catch (e) {
        throw new DockerDriverError('BACKUP_CHOWN_FAILED', `cannot chown ${f}: ${(e as Error).message.slice(0, 150)}`);
      }
      copied.push({ name: f, ...sha256File(dest) });
    }
    return copied;
  }

  /**
   * Backup de un volumen live huérfano (existe sin contenedor live).
   * Revisión Codex (NO-GO 2, bloqueo 2): el volumen ya tiene sus labels
   * verificadas por el llamador. Los datos se extraen con un contenedor
   * temporal ENDURECIDO (`hardenedTempVolumeArgs`: sin red, sin
   * privilegios, efímero, sin labels de managed).
   */
  private async backupOrphanLiveVolume(
    args: LiveBackupArgs,
    liveVolume: string,
    backupId: string,
    stamp: string,
  ): Promise<DriverResult> {
    const { projectId, deploymentId } = args;
    if (args.signal?.aborted) return err('OPERATION_ABORTED', 'aborted before start');
    const names = this.names(projectId, deploymentId);
    const dir = backupDirFor(this.config.dataDir, projectId, backupId);
    const tmp = `appforge-tmp-backup-${randomUUID().slice(0, 8)}`;
    const createArgs = hardenedTempVolumeArgs({ name: tmp, image: names.image, volume: liveVolume });
    assertNoForbiddenFlags(createArgs);
    const cc = await this.sh(createArgs, { timeoutMs: 30_000, signal: args.signal });
    if (cc.aborted) return err('OPERATION_ABORTED', 'orphan volume backup aborted');
    if (cc.timedOut || cc.code !== 0) {
      return err('BACKUP_TMP_CREATE_FAILED', `cannot create hardened temp container: ${cc.stderr.slice(0, 300)}`);
    }
    try {
      const copied = await this.copyDatabaseFilesFromContainer(args, tmp, dir);
      const hadDatabase = copied.some((c) => c.name === 'app.db');
      if (hadDatabase) {
        try {
          quickCheck(path.join(dir, 'app.db'));
        } catch (e) {
          throw new DockerDriverError('BACKUP_QUICK_CHECK_FAILED', (e as Error).message);
        }
      }
      const manifest: BackupManifest = { backupId, projectId, deploymentId, createdAt: stamp, hadDatabase, files: copied };
      writeBackupManifest(dir, manifest);
      enforceRetention({ dataDir: this.config.dataDir, projectId, protectedIds: this.protectedBackupIds(projectId) });
      return ok(validatedBackupData(manifest));
    } catch (e) {
      if (e instanceof DockerDriverError || e instanceof ResourceError || e instanceof BackupError) {
        return err(e.code, e.message);
      }
      return err('BACKUP_ERROR', (e as Error).message);
    } finally {
      await this.sh(['rm', tmp], { timeoutMs: 30_000 }).catch(() => undefined);
    }
  }

  /**
   * Re-levanta el contenedor live detenido por `createLiveBackup` y verifica
   * su health. Se usa cuando el backup falla o se aborta DESPUÉS de detener
   * el live: el servicio nunca debe quedar parado por un backup fallido
   * (revisión Codex, NO-GO 2, bloqueo 2).
   */
  private async recoverStoppedLive(args: DriverOpArgs, containerName: string): Promise<DriverResult> {
    // La señal de la operación original puede estar ya abortada por timeout.
    // La recuperación necesita un presupuesto independiente o el runner ni
    // siquiera ejecutaría `docker start`.
    const recoverySignal = AbortSignal.timeout(120_000);
    const start = await this.sh(['start', containerName], { timeoutMs: 60_000, signal: recoverySignal });
    if (start.aborted) return err('OPERATION_ABORTED', 'live recovery aborted');
    if (start.timedOut || start.code !== 0) {
      return err('BACKUP_RECOVERY_START_FAILED', `could not restart live container: ${start.stderr.slice(0, 200)}`);
    }
    for (let i = 0; i < 10; i++) {
      if (await this.containerRunning(containerName)) break;
      await this.abortAwareSleep(1000, recoverySignal);
    }
    if (!(await this.containerRunning(containerName))) {
      return err('BACKUP_RECOVERY_NOT_RUNNING', 'live container did not come back up after restart');
    }
    const health = await this.runHealthCheck({
      projectId: args.projectId,
      deploymentId: args.deploymentId,
      candidateId: args.candidateId,
      runtime: 'live',
      signal: recoverySignal,
    });
    if (!health.ok) {
      return err('BACKUP_RECOVERY_UNHEALTHY', `live restarted but health check failed: ${health.error}`);
    }
    return ok({ recovered: 'true' });
  }

  async resumeCurrentLiveRuntime(args: DriverOpArgs): Promise<DriverResult> {
    assertDriverArgs(args);
    try {
      const names = this.names(args.projectId, args.deploymentId);
      if (!(await resourceExists(this.runner, 'container', names.liveContainer))) {
        return err('LIVE_MISSING', 'live container is missing; cannot resume it after backup');
      }
      await this.assertLiveSlot(args.projectId, names.liveContainer);
      if (await this.containerRunning(names.liveContainer)) {
        return await this.runHealthCheck({ ...args, runtime: 'live' });
      }
      return await this.recoverStoppedLive(args, names.liveContainer);
    } catch (e) {
      if (e instanceof DockerDriverError || e instanceof ResourceError) return err(e.code, e.message);
      return err('RESUME_LIVE_ERROR', (e as Error).message);
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
      const v = await this.ensureLiveVolume(args.projectId, args.signal);
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

  /**
   * Valida ÍNTEGRAMENTE un backup antes de detener/eliminar nada (revisión
   * Codex, Fase 7A): manifiesto, projectId, backupId, nombres permitidos,
   * unicidad, tamaños, SHA-256 de cada fichero en disco y
   * `PRAGMA quick_check`. Un backup corrupto se rechaza aquí, con el live
   * intacto. Lanza `DockerDriverError` ante cualquier problema.
   */
  private validateBackupForRestore(projectId: string, backupId: string): BackupManifest {
    const bdir = backupDirFor(this.config.dataDir, projectId, backupId);
    let manifest: BackupManifest;
    try {
      manifest = readBackupManifest(bdir);
    } catch (e) {
      throw new DockerDriverError(
        'BACKUP_MANIFEST_INVALID',
        `cannot read backup manifest: ${(e as Error).message}`,
      );
    }
    if (manifest.projectId !== projectId) {
      throw new DockerDriverError('BACKUP_PROJECT_MISMATCH', 'backup manifest projectId does not match');
    }
    if (manifest.backupId !== backupId) {
      throw new DockerDriverError('BACKUP_ID_MISMATCH', 'backup manifest backupId does not match');
    }
    if (typeof manifest.deploymentId !== 'string' || !/^[0-9a-f-]{36}$/i.test(manifest.deploymentId)) {
      throw new DockerDriverError('BACKUP_MANIFEST_INVALID', 'backup manifest deploymentId is invalid');
    }
    const allowed = new Set(['app.db', 'app.db-wal']);
    const seen = new Set<string>();
    for (const f of manifest.files) {
      if (!allowed.has(f.name)) {
        throw new DockerDriverError('BACKUP_FILE_FORBIDDEN', `backup manifest lists forbidden file: ${f.name}`);
      }
      if (seen.has(f.name)) {
        throw new DockerDriverError('BACKUP_FILE_DUPLICATE', `backup manifest lists duplicate file: ${f.name}`);
      }
      seen.add(f.name);
      if (!Number.isInteger(f.size) || f.size <= 0 || f.size > 10 * 1024 * 1024 * 1024) {
        throw new DockerDriverError('BACKUP_FILE_SIZE_INVALID', `backup file ${f.name} has invalid size`);
      }
      if (!/^[0-9a-f]{64}$/i.test(f.sha256)) {
        throw new DockerDriverError('BACKUP_FILE_HASH_INVALID', `backup file ${f.name} has invalid sha256`);
      }
      const abs = path.join(bdir, f.name);
      try {
        const st = fs.statSync(abs);
        if (!st.isFile()) throw new Error('not a file');
      } catch {
        throw new DockerDriverError('BACKUP_FILE_MISSING', `backup file missing on disk: ${f.name}`);
      }
      const got = sha256File(abs);
      if (got.size !== f.size || got.sha256.toLowerCase() !== f.sha256.toLowerCase()) {
        throw new DockerDriverError(
          'BACKUP_FILE_CORRUPT',
          `backup file ${f.name} checksum mismatch: refusing to restore a corrupt backup`,
        );
      }
    }
    if (manifest.hadDatabase) {
      if (!seen.has('app.db')) {
        throw new DockerDriverError('BACKUP_MANIFEST_INVALID', 'backup claims hadDatabase but app.db is missing');
      }
      try {
        quickCheck(path.join(bdir, 'app.db'));
      } catch (e) {
        throw new DockerDriverError(
          'BACKUP_QUICK_CHECK_FAILED',
          `backup app.db failed PRAGMA quick_check: ${(e as Error).message}`,
        );
      }
    }
    // Revisión Codex (NO-GO 2, bloqueo 3): hadDatabase es booleano
    // obligatorio; hadDatabase=false exige files=[] y hadDatabase=true
    // exige app.db presente (ya comprobado arriba).
    if (typeof manifest.hadDatabase !== 'boolean') {
      throw new DockerDriverError('BACKUP_MANIFEST_INVALID', 'backup manifest hadDatabase must be a boolean');
    }
    if (!manifest.hadDatabase && manifest.files.length > 0) {
      throw new DockerDriverError(
        'BACKUP_MANIFEST_INVALID',
        'backup with hadDatabase=false must list no files',
      );
    }
    return manifest;
  }

  /**
   * Rescate del volumen live actual a un temporal del host (revisión Codex,
   * NO-GO 2, bloqueo 3). Se ejecuta en `restoreBackup` ANTES de tocar el
   * live: si la sustitución falla, la compensación devuelve estos datos al
   * volumen live. Verifica las labels estables del volumen (un volumen
   * ajeno aborta el restore con FOREIGN_RESOURCE) y extrae `app.db` /
   * `app.db-wal` con un contenedor temporal endurecido. Si no hay volumen
   * o no hay datos, devuelve `files` vacío. Cualquier otro fallo LANZA
   * (no se continúa sin rescate).
   */
  private async rescueLiveVolume(
    projectId: string,
    liveVolume: string,
    image: string,
    signal?: AbortSignal,
  ): Promise<{ dir: string; files: BackupFileEntry[] }> {
    const dir = fs.mkdtempSync(path.join('/tmp', 'af-restore-rescue-'));
    const files: BackupFileEntry[] = [];
    if (!(await resourceExists(this.runner, 'volume', liveVolume))) return { dir, files };
    const info = (await inspectResource(this.runner, 'volume', liveVolume)) as {
      Labels?: Record<string, string>;
    };
    try {
      assertLiveVolumeLabels(info?.Labels, projectId);
    } catch {
      throw new DockerDriverError('FOREIGN_RESOURCE', `refusing to rescue foreign live volume '${liveVolume}'`);
    }
    const tmp = `appforge-tmp-rescue-${randomUUID().slice(0, 8)}`;
    const createArgs = hardenedTempVolumeArgs({ name: tmp, image, volume: liveVolume });
    assertNoForbiddenFlags(createArgs);
    const cc = await this.sh(createArgs, { timeoutMs: 30_000, signal });
    if (cc.aborted) throw new DockerDriverError('OPERATION_ABORTED', 'live rescue aborted');
    if (cc.timedOut || cc.code !== 0) {
      throw new DockerDriverError('RESTORE_RESCUE_CREATE_FAILED', cc.stderr.slice(0, 300));
    }
    try {
      for (const f of ['app.db', 'app.db-wal']) {
        const cp = await this.sh(['cp', `${tmp}:/data/${f}`, path.join(dir, f)], {
          timeoutMs: 120_000,
          signal,
        });
        if (cp.aborted) throw new DockerDriverError('OPERATION_ABORTED', 'live rescue aborted');
        if (cp.timedOut) throw new DockerDriverError('RESTORE_RESCUE_TIMEOUT', `rescue cp ${f} timed out`);
        if (cp.code !== 0) {
          if (isMissingContainerPath(cp.stderr)) continue;
          throw new DockerDriverError('RESTORE_RESCUE_CP_FAILED', `rescue ${f}: ${cp.stderr.slice(0, 200)}`);
        }
        files.push({ name: f, ...sha256File(path.join(dir, f)) });
      }
    } finally {
      await this.sh(['rm', tmp], { timeoutMs: 30_000 }).catch(() => undefined);
    }
    return { dir, files };
  }

  /**
   * Compensación automática tras un fallo en la sustitución del volumen
   * live (revisión Codex, NO-GO 2, bloqueo 3): recrea el volumen live con
   * labels estables si falta, devuelve los datos rescatados y verifica sus
   * checksums (+ `quick_check` si hay `app.db`). Nunca deja el live borrado
   * o incompleto sin intentarlo. El contenedor NO se arranca aquí: eso lo
   * hace `startPreviousVersion` (el orquestador).
   */
  private async compensateRestoreFailure(
    projectId: string,
    liveVolume: string,
    image: string,
    rescue: { dir: string; files: BackupFileEntry[] },
    signal?: AbortSignal,
  ): Promise<DriverResult> {
    try {
      if (await resourceExists(this.runner, 'volume', liveVolume)) {
        const info = (await inspectResource(this.runner, 'volume', liveVolume)) as {
          Labels?: Record<string, string>;
        };
        try {
          assertLiveVolumeLabels(info?.Labels, projectId);
        } catch {
          return err('FOREIGN_RESOURCE', `refusing to compensate foreign live volume '${liveVolume}'`);
        }
        // El volumen existente puede contener una copia parcial del backup
        // que falló. Se elimina y recrea incluso cuando el rescate original
        // estaba vacío, para restaurar exactamente el estado previo.
        const rm = await this.sh(['volume', 'rm', liveVolume], { timeoutMs: 30_000, signal });
        if (rm.code !== 0) {
          return err('RESTORE_COMPENSATION_FAILED', `cannot clear partial live volume: ${rm.stderr.slice(0, 200)}`);
        }
      }
      const vc = await this.sh(['volume', 'create', ...liveVolumeLabelArgs(projectId), liveVolume], {
        timeoutMs: 30_000,
        signal,
      });
      if (vc.code !== 0) {
        return err('RESTORE_COMPENSATION_FAILED', `cannot recreate live volume: ${vc.stderr.slice(0, 200)}`);
      }
      if (rescue.files.length > 0) {
        await this.copyHostFilesToVolume(image, liveVolume, rescue.files, rescue.dir, signal);
        await this.verifyVolumeFiles(
          image,
          liveVolume,
          rescue.files,
          rescue.files.some((f) => f.name === 'app.db'),
          signal,
        );
      }
      return ok({ compensated: 'true' });
    } catch (e) {
      if (e instanceof DockerDriverError || e instanceof ResourceError || e instanceof BackupError) {
        return err('RESTORE_COMPENSATION_FAILED', `${e.code}: ${e.message}`);
      }
      return err('RESTORE_COMPENSATION_FAILED', (e as Error).message);
    }
  }

  /** Extrae ficheros de un volumen al host usando un contenedor temporal. */
  private async extractVolumeToHost(
    image: string,
    volume: string,
    mountPoint: string,
    files: Array<{ name: string }>,
    destDir: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const tmp = `appforge-tmp-extract-${randomUUID().slice(0, 8)}`;
    const cc = await this.sh(['create', '--name', tmp, '-v', `${volume}:${mountPoint}`, image], {
      timeoutMs: 30_000,
      signal,
    });
    if (cc.code !== 0) {
      throw new DockerDriverError('RESTORE_EXTRACT_CREATE_FAILED', cc.stderr.slice(0, 300));
    }
    try {
      for (const f of files) {
        const cp = await this.sh(['cp', `${tmp}:${mountPoint}/${f.name}`, path.join(destDir, f.name)], {
          timeoutMs: 120_000,
          signal,
        });
        if (cp.code !== 0) {
          throw new DockerDriverError('RESTORE_EXTRACT_CP_FAILED', `extract ${f.name}: ${cp.stderr.slice(0, 200)}`);
        }
      }
    } finally {
      await this.sh(['rm', tmp], { timeoutMs: 30_000 }).catch(() => undefined);
    }
  }

  /** Copia ficheros del host a un volumen usando un contenedor temporal. */
  private async copyHostFilesToVolume(
    image: string,
    volume: string,
    files: Array<{ name: string }>,
    srcDir: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const tmp = `appforge-tmp-cp-${randomUUID().slice(0, 8)}`;
    const cc = await this.sh(['create', '--name', tmp, '-v', `${volume}:/data`, image], {
      timeoutMs: 30_000,
      signal,
    });
    if (cc.code !== 0) {
      throw new DockerDriverError('RESTORE_TMP_CREATE_FAILED', cc.stderr.slice(0, 300));
    }
    try {
      for (const f of files) {
        const cp = await this.sh(['cp', path.join(srcDir, f.name), `${tmp}:/data/${f.name}`], {
          timeoutMs: 120_000,
          signal,
        });
        if (cp.code !== 0) {
          throw new DockerDriverError('RESTORE_CP_FAILED', `copy ${f.name}: ${cp.stderr.slice(0, 200)}`);
        }
      }
    } finally {
      await this.sh(['rm', tmp], { timeoutMs: 30_000 }).catch(() => undefined);
    }
  }

  /**
   * Verifica ficheros dentro de un volumen: los extrae a un temporal,
   * compara tamaño+SHA-256 con el manifiesto y pasa `quick_check` a
   * app.db cuando se pide.
   */
  private async verifyVolumeFiles(
    image: string,
    volume: string,
    files: BackupFileEntry[],
    doQuickCheck: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const tmp = `appforge-tmp-verify-${randomUUID().slice(0, 8)}`;
    const cc = await this.sh(['create', '--name', tmp, '-v', `${volume}:/data`, image], {
      timeoutMs: 30_000,
      signal,
    });
    if (cc.code !== 0) {
      throw new DockerDriverError('RESTORE_VERIFY_CREATE_FAILED', cc.stderr.slice(0, 300));
    }
    const vdir = fs.mkdtempSync(path.join('/tmp', 'af-restore-verify-'));
    try {
      for (const f of files) {
        const out = path.join(vdir, f.name);
        const cp = await this.sh(['cp', `${tmp}:/data/${f.name}`, out], {
          timeoutMs: 120_000,
          signal,
        });
        if (cp.code !== 0) {
          throw new DockerDriverError('RESTORE_VERIFY_CP_FAILED', `verify ${f.name}: ${cp.stderr.slice(0, 200)}`);
        }
        const got = sha256File(out);
        if (got.size !== f.size || got.sha256.toLowerCase() !== f.sha256.toLowerCase()) {
          throw new DockerDriverError(
            'RESTORE_VERIFY_MISMATCH',
            `restored ${f.name} checksum mismatch`,
          );
        }
      }
      if (doQuickCheck) {
        try {
          quickCheck(path.join(vdir, 'app.db'));
        } catch (e) {
          throw new DockerDriverError(
            'RESTORE_QUICK_CHECK_FAILED',
            `restored app.db failed PRAGMA quick_check: ${(e as Error).message}`,
          );
        }
      }
    } finally {
      fs.rmSync(vdir, { recursive: true, force: true });
      await this.sh(['rm', tmp], { timeoutMs: 30_000 }).catch(() => undefined);
    }
  }

  async restoreBackup(args: RestoreBackupArgs): Promise<DriverResult> {
    assertDriverArgs(args);
    const backupId = args.backupId ?? null;
    if (!isValidBackupId(backupId)) return err('INVALID_BACKUP_ID', 'restoreBackup requires a valid backupId');
    try {
      const { projectId, deploymentId } = args;
      const names = this.names(projectId, deploymentId);
      const liveVolume = projectLiveVolumeName(projectId);

      // ---- 1. Validación TOTAL del backup ANTES de detener/eliminar nada.
      // Un backup corrupto se rechaza aquí, con el live intacto.
      const manifest = this.validateBackupForRestore(projectId, backupId!);

      // ---- 2. Staging: restaurar primero en un volumen staging, validar
      // allí, y solo después sustituir el live (revisión Codex, Fase 7A).
      // Un staging preexistente se inspecciona con labels EXACTAS antes de
      // eliminarlo: un staging ajeno sobrevive y produce FOREIGN_RESOURCE
      // (revisión Codex, NO-GO 2, bloqueo 3).
      const stagingVol = `appforge-restore-staging-${id8(deploymentId)}`;
      const stagingLabels: ManagedLabels = {
        projectId,
        deploymentId,
        role: 'migration',
        fingerprint: this.snapshotFingerprint(deploymentId),
      };
      if (await resourceExists(this.runner, 'volume', stagingVol)) {
        const stagingInfo = (await inspectResource(this.runner, 'volume', stagingVol)) as {
          Labels?: Record<string, string>;
        };
        try {
          assertLabelsMatch(stagingInfo?.Labels, stagingLabels);
        } catch {
          return err('FOREIGN_RESOURCE', `refusing to remove foreign staging volume '${stagingVol}'`);
        }
        const srm = await this.sh(['volume', 'rm', stagingVol], { timeoutMs: 30_000, signal: args.signal });
        if (srm.code !== 0) {
          return err('RESTORE_STAGING_RM_FAILED', `cannot remove own staging volume: ${srm.stderr.slice(0, 300)}`);
        }
      }
      const svc = await this.sh(['volume', 'create', ...labelArgs(stagingLabels), stagingVol], {
        timeoutMs: 30_000,
        signal: args.signal,
      });
      if (svc.code !== 0) {
        throw new DockerDriverError('RESTORE_STAGING_CREATE_FAILED', svc.stderr.slice(0, 300));
      }
      // ---- 2b. Rescate del live actual ANTES de tocarlo (bloqueo 3):
      // copia a un temporal del host para compensar si algo falla después
      // de eliminar el live. Si el rescate falla, NO se continúa (el
      // staging se limpia en el finally).
      let rescue: { dir: string; files: BackupFileEntry[] } | null = null;
      try {
        rescue = await this.rescueLiveVolume(projectId, liveVolume, names.image, args.signal);
        if (manifest.hadDatabase) {
          const bdir = backupDirFor(this.config.dataDir, projectId, backupId!);
          await this.copyHostFilesToVolume(names.image, stagingVol, manifest.files, bdir, args.signal);
          await this.verifyVolumeFiles(names.image, stagingVol, manifest.files, true, args.signal);
        }

        // ---- 3. Liberar el live: detener y quitar el contenedor (si existe).
        if (await resourceExists(this.runner, 'container', names.liveContainer)) {
          await this.assertLiveSlot(projectId, names.liveContainer);
          if (await this.containerRunning(names.liveContainer)) {
            await this.stopContainerBounded(names.liveContainer, args.signal, 10);
            if (await this.containerRunning(names.liveContainer)) {
              throw new DockerDriverError('RESTORE_STOP_FAILED', 'live container still running; cannot restore');
            }
          }
          const rm = await this.sh(['rm', names.liveContainer], { timeoutMs: 30_000, signal: args.signal });
          if (rm.code !== 0) {
            throw new DockerDriverError('RESTORE_RM_FAILED', rm.stderr.slice(0, 300));
          }
        }

        // ---- 4+5. Sustitución del volumen con COMPENSACIÓN AUTOMÁTICA
        // (bloqueo 3): si algo falla a partir de aquí, los datos rescatados
        // se devuelven al volumen live; nunca se deja el live borrado o
        // incompleto sin intentarlo.
        try {
          if (await resourceExists(this.runner, 'volume', liveVolume)) {
            const info = (await inspectResource(this.runner, 'volume', liveVolume)) as {
              Labels?: Record<string, string>;
            };
            try {
              assertLiveVolumeLabels(info?.Labels, projectId);
            } catch {
              throw new DockerDriverError(
                'FOREIGN_RESOURCE',
                `refusing to remove live volume '${liveVolume}' with non-matching labels`,
              );
            }
            const vrm = await this.sh(['volume', 'rm', liveVolume], { timeoutMs: 30_000, signal: args.signal });
            if (vrm.code !== 0) {
              throw new DockerDriverError('RESTORE_VOLUME_RM_FAILED', vrm.stderr.slice(0, 300));
            }
          }
          const vc = await this.sh(['volume', 'create', ...liveVolumeLabelArgs(projectId), liveVolume], {
            timeoutMs: 30_000,
            signal: args.signal,
          });
          if (vc.code !== 0) {
            throw new DockerDriverError('RESTORE_VOLUME_CREATE_FAILED', vc.stderr.slice(0, 300));
          }

          // ---- 5. staging -> live vía un temporal del host + verificación
          // final en el live. (`docker cp` no soporta contenedor→contenedor.)
          if (manifest.hadDatabase) {
            const pdir = fs.mkdtempSync(path.join('/tmp', 'af-restore-promote-'));
            try {
              await this.extractVolumeToHost(names.image, stagingVol, '/data', manifest.files, pdir, args.signal);
              await this.copyHostFilesToVolume(names.image, liveVolume, manifest.files, pdir, args.signal);
            } finally {
              fs.rmSync(pdir, { recursive: true, force: true });
            }
            await this.verifyVolumeFiles(names.image, liveVolume, manifest.files, true, args.signal);
          }
          return ok();
        } catch (e) {
          const orig =
            e instanceof DockerDriverError || e instanceof ResourceError || e instanceof BackupError
              ? `${e.code}: ${e.message}`
              : `RESTORE_ERROR: ${(e as Error).message}`;
          // Igual que el rollback del orquestador, la compensación debe tener
          // presupuesto independiente: la señal que causó el fallo puede
          // estar ya abortada y no debe impedir recuperar los datos.
          const recoverySignal = AbortSignal.timeout(120_000);
          const comp = await this.compensateRestoreFailure(
            projectId,
            liveVolume,
            names.image,
            rescue!,
            recoverySignal,
          );
          if (!comp.ok) {
            return err(
              'RESTORE_COMPENSATION_FAILED',
              `${orig}; compensation also failed (${comp.code}): ${comp.error} — live data may be incomplete`,
            );
          }
          return err(
            'RESTORE_FAILED_COMPENSATED',
            `${orig} (live data restored from the pre-restore rescue copy; start the previous version with startPreviousVersion)`,
          );
        }
      } finally {
        // Limpieza del staging y del rescate en todos los caminos.
        await this.sh(['volume', 'rm', stagingVol], { timeoutMs: 30_000 }).catch(() => undefined);
        if (rescue) fs.rmSync(rescue.dir, { recursive: true, force: true });
      }
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
    if (!APPFORGE_IMAGE_REF_RE.test(prevImage)) {
      return err('INVALID_PREVIOUS_IMAGE', 'previousLiveVersion must be a full appforge image reference');
    }
    try {
      const names = this.names(args.projectId, args.deploymentId);
      if (await resourceExists(this.runner, 'container', names.liveContainer)) {
        return err('LIVE_EXISTS', 'live container already exists; refusing to create a second one');
      }
      // Inspeccionar la imagen anterior ANTES de ejecutarla (revisión Codex,
      // NO-GO 2, bloqueo 4): debe ser una imagen AppForge gestionada DE ESTE
      // PROYECTO. Un nombre con formato válido no basta: una imagen de otro
      // proyecto se rechaza aunque la referencia parezca correcta.
      let prevLabels: Record<string, string>;
      try {
        const imgInfo = (await inspectResource(this.runner, 'image', prevImage)) as {
          Config?: { Labels?: Record<string, string> };
        };
        prevLabels = imgInfo?.Config?.Labels ?? {};
      } catch {
        return err('PREVIOUS_IMAGE_MISSING', `previous image '${prevImage}' not found`);
      }
      const labelProblems: string[] = [];
      if (prevLabels[MANAGED_LABEL] !== 'true') labelProblems.push(`${MANAGED_LABEL}!=true`);
      if ((prevLabels[LABEL_PROJECT] ?? '').toLowerCase() !== args.projectId.toLowerCase()) {
        labelProblems.push(`${LABEL_PROJECT} mismatch: image belongs to another project`);
      }
      try {
        assertUuid(prevLabels[LABEL_DEPLOYMENT] ?? '', 'deployment-id');
      } catch {
        labelProblems.push(`${LABEL_DEPLOYMENT} missing or invalid`);
      }
      if (prevLabels[LABEL_ROLE] !== 'live') {
        labelProblems.push(`${LABEL_ROLE} must be 'live'`);
      }
      try {
        assertFingerprint(prevLabels[LABEL_FINGERPRINT] ?? '');
      } catch {
        labelProblems.push(`${LABEL_FINGERPRINT} missing or invalid`);
      }
      if (labelProblems.length > 0) {
        return err(
          'PREVIOUS_IMAGE_UNTRUSTED',
          `refusing to run previous image with invalid labels: ${labelProblems.join(', ')}`,
        );
      }
      const identity = resourceNames(
        args.projectId,
        prevLabels[LABEL_DEPLOYMENT]!,
        prevLabels[LABEL_FINGERPRINT]!,
      );
      if (identity.image !== prevImage) {
        return err(
          'PREVIOUS_IMAGE_IDENTITY_MISMATCH',
          `previous image reference '${prevImage}' does not match its persisted labels`,
        );
      }
      // El nuevo contenedor live usa las labels REALES de la imagen anterior
      // (deployment + fingerprint de cuando se construyó), no las del
      // deployment fallido.
      const labels: ManagedLabels = {
        projectId: args.projectId,
        deploymentId: prevLabels[LABEL_DEPLOYMENT]!,
        role: 'live',
        fingerprint: prevLabels[LABEL_FINGERPRINT]!,
      };
      const liveVolumeCheck = await this.ensureLiveVolume(args.projectId, args.signal);
      if (liveVolumeCheck) return liveVolumeCheck;
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
      const { projectId, deploymentId } = args;
      const names = this.names(projectId, deploymentId);
      const labels: ManagedLabels = {
        projectId,
        deploymentId,
        role: 'live',
        fingerprint: this.snapshotFingerprint(deploymentId),
      };
      // Nunca eliminar una imagen usada por un contenedor.
      const refs = await this.sh(
        ['ps', '-a', '--filter', `ancestor=${names.image}`, '--format', '{{.ID}}'],
        { timeoutMs: 30_000, signal: args.signal },
      );
      if (refs.code === 0 && refs.stdout.trim() !== '') {
        return err('IMAGE_REFERENCED', `image '${names.image}' is still referenced by a container; refusing to discard`);
      }
      // La imagen debe existir y llevar las labels EXACTAS del deployment:
      // una imagen ajena con el nombre esperado NO se elimina.
      let info: { Config?: { Labels?: Record<string, string> } };
      try {
        info = (await inspectResource(this.runner, 'image', names.image)) as typeof info;
      } catch {
        return ok(); // no existe: nada que descartar
      }
      try {
        assertLabelsMatch(info?.Config?.Labels, labels);
      } catch {
        return err(
          'FOREIGN_RESOURCE',
          `refusing to discard image '${names.image}' with non-matching labels`,
        );
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
          Config?: { Image?: string; Labels?: Record<string, string> };
          State?: { Running?: boolean };
        };
        // El slot puede contener el deployment consultado O una versión
        // anterior legítimamente restaurada por rollback. Se valida la
        // identidad autoconsistente de sus labels reales, no las del
        // deployment fallido que provocó la reconciliación.
        const labels = info?.Config?.Labels ?? {};
        if (labels[MANAGED_LABEL] !== 'true') {
          throw new DockerDriverError('FOREIGN_RESOURCE', 'live container is not AppForge-managed');
        }
        if ((labels[LABEL_PROJECT] ?? '').toLowerCase() !== args.projectId.toLowerCase()) {
          throw new DockerDriverError('FOREIGN_RESOURCE', 'live container belongs to another project');
        }
        if (labels[LABEL_ROLE] !== 'live') {
          throw new DockerDriverError('FOREIGN_RESOURCE', 'live container has a non-live role');
        }
        assertUuid(labels[LABEL_DEPLOYMENT] ?? '', 'deployment-id');
        assertFingerprint(labels[LABEL_FINGERPRINT] ?? '');
        const actualIdentity = resourceNames(
          args.projectId,
          labels[LABEL_DEPLOYMENT]!,
          labels[LABEL_FINGERPRINT]!,
        );
        if (String(info?.Config?.Image ?? '') !== actualIdentity.image) {
          throw new DockerDriverError(
            'FOREIGN_RESOURCE',
            'live image reference does not match its deployment/fingerprint labels',
          );
        }
        liveRunning = info?.State?.Running === true;
        liveImage = String(info?.Config?.Image ?? '');
      }
      const volumeExists = await resourceExists(this.runner, 'volume', names.liveVolume);
      if (volumeExists) {
        const volume = (await inspectResource(this.runner, 'volume', names.liveVolume)) as {
          Labels?: Record<string, string>;
        };
        assertLiveVolumeLabels(volume?.Labels, args.projectId);
      }
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
   * Poda imágenes administradas DEL PROYECTO indicado (revisión Codex,
   * Fase 7A). Lee `live_image`/`previous_image` de `project_runtime` en
   * SQLite ANTES de aplicar retención: esas imágenes nunca se podan.
   * Exige labels completas, inspecciona las labels exactas antes de cada
   * `rmi` y nunca toca imágenes de otros proyectos. Los fallos se
   * devuelven, nunca se ocultan. (7B lo llamará tras la promoción; en 7A
   * se prueba de forma aislada.)
   */
  async pruneManagedImages(
    projectId: string,
    keepImages: string[] = [],
  ): Promise<{ removed: string[]; failures: string[] }> {
    assertUuid(projectId, 'projectId');
    const keep = new Set(keepImages);
    try {
      const row = this.db
        .prepare('SELECT live_image, previous_image FROM project_runtime WHERE project_id=?')
        .get(projectId) as { live_image: string | null; previous_image: string | null } | undefined;
      if (row?.live_image) keep.add(row.live_image);
      if (row?.previous_image) keep.add(row.previous_image);
    } catch {
      /* project_runtime puede no existir aún; se sigue sin protegidos extra */
    }
    const images = await listManagedResources(this.runner, 'image');
    const removed: string[] = [];
    const failures: string[] = [];
    for (const img of images) {
      const ref = img.name || img.id;
      const labels = img.labels ?? {};
      // Scope: solo este proyecto. Las imágenes de otros proyectos son
      // intocables (ni siquiera se inspeccionan para podar).
      if ((labels[LABEL_PROJECT] ?? '').toLowerCase() !== projectId.toLowerCase()) continue;
      // Labels incompletas → se rechaza, no se poda a ciegas.
      const missing = [LABEL_DEPLOYMENT, LABEL_ROLE, LABEL_FINGERPRINT].filter((k) => !labels[k]);
      if (labels[MANAGED_LABEL] !== 'true' || missing.length > 0) {
        failures.push(
          `${ref || img.id}: incomplete labels (${missing.join(', ') || 'managed!=true'}); refusing to prune`,
        );
        continue;
      }
      if (!ref || keep.has(ref) || keep.has(img.id)) continue;
      const refs = await this.sh(['ps', '-a', '--filter', `ancestor=${img.id}`, '--format', '{{.ID}}'], {
        timeoutMs: 30_000,
      });
      if (refs.code === 0 && refs.stdout.trim() !== '') {
        failures.push(`${ref}: still referenced by a container`);
        continue;
      }
      // Inspección de labels exactas inmediatamente antes del rmi.
      try {
        const info = (await inspectResource(this.runner, 'image', img.id)) as {
          Config?: { Labels?: Record<string, string> };
        };
        assertLabelsMatch(info?.Config?.Labels, {
          projectId: labels[LABEL_PROJECT]!,
          deploymentId: labels[LABEL_DEPLOYMENT]!,
          role: labels[LABEL_ROLE] as ResourceRole,
          fingerprint: labels[LABEL_FINGERPRINT]!,
        });
      } catch (e) {
        failures.push(`${ref}: label re-inspection failed (${(e as Error).message.slice(0, 120)}); refusing rmi`);
        continue;
      }
      const r = await this.sh(['rmi', img.id], { timeoutMs: 120_000 });
      if (r.code === 0) removed.push(ref);
      else failures.push(`${ref}: ${r.stderr.slice(0, 200)}`);
    }
    return { removed, failures };
  }
}
