/**
 * Fase 6 — Interfaz interna del adaptador de despliegue (CONTRACT.md §9.21).
 *
 * Separación estricta:
 * - El ORQUESTADOR decide el orden, persiste estados ANTES de operar,
 *   gestiona fallos/cancelación/limpieza/rollback. No conoce Docker.
 * - El DRIVER expone operaciones semánticas cerradas y agnósticas de
 *   Docker. No acepta comandos, shell, nombres de contenedor ni rutas del
 *   LLM: los identificadores los deriva internamente el orquestador y los
 *   argumentos son tipados y validados.
 * - El adaptador NUNCA muta el estado del deployment: únicamente el
 *   orquestador decide transiciones (vía la máquina de estados).
 * - El LLM nunca recibe acceso directo al driver.
 *
 * `FakeDeploymentDriver` es exclusivo de pruebas. Desde 7B el Studio puede
 * inyectar el `DockerDeploymentDriver` real tras kill switches + preflight.
 *
 * Este módulo no ejecuta shell, no abre red y no importa Docker.
 */

import type Database from 'better-sqlite3';

/** Argumentos base: identificadores derivados internamente por el orquestador. */
export interface DriverOpArgs {
  deploymentId: string;
  projectId: string;
  /** Identificador del candidato, derivado como `cand-<8 del deployment id>`. */
  candidateId: string;
  /**
   * Revisión Codex (Fase 6): señal de aborto. Toda implementación del driver
   * DEBE abortar el trabajo real cuando se dispare y resolver su promesa con
   * prontitud (`{ ok:false, code:'OPERATION_ABORTED' }`). El orquestador la
   * dispara ante timeout de operación, timeout total del pipeline o
   * cancelación (fuera de la sección crítica de `promoting`) y ESPERA a que
   * la operación termine: nunca deja trabajo en segundo plano.
   */
  signal?: AbortSignal;
}

export interface HealthCheckArgs extends DriverOpArgs {
  runtime: 'verify' | 'live';
}

export interface LiveBackupArgs extends DriverOpArgs {
  previousLiveVersion: string | null;
}

export interface RestoreBackupArgs extends DriverOpArgs {
  backupId: string | null;
}

export interface StartPreviousVersionArgs extends DriverOpArgs {
  previousLiveVersion: string | null;
}

export interface ReconcileArgs {
  deploymentId: string;
  projectId: string;
  candidateId: string;
}

export interface DriverResult {
  ok: boolean;
  /** Código máquina estable, p. ej. 'BUILD_FAILED'. */
  code?: string;
  /** Diagnóstico humano (el orquestador lo sanitiza antes de persistir). */
  error?: string;
  /** Salida bruta de la operación (el orquestador la sanitiza y trunca). */
  output?: string;
  /** Datos estructurados de la operación, p. ej. `{ backupId: '...' }`. */
  data?: Record<string, string>;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,120}$/;

/**
 * Referencia completa de imagen AppForge (`appforge/app-<p8>:dep-<d8>-<sha12>`).
 * Es el único formato aceptado para `previousLiveVersion`: la fija el Studio
 * desde `project_runtime` (7B), nunca el modelo.
 */
export const APPFORGE_IMAGE_REF_RE = /^appforge\/app-[0-9a-f]{8}:dep-[0-9a-f]{8}-[0-9a-f]{12}$/;

/**
 * Valida que los argumentos sean identificadores seguros derivados
 * internamente. Rechaza comandos, rutas, espacios y cadenas vacías: el
 * driver nunca debe recibir entrada libre del modelo. Los campos opcionales
 * (`previousLiveVersion`, `backupId`) admiten `null`; `runtime` solo
 * admite 'verify'|'live'. Interfaz cerrada: claves desconocidas → error.
 */
export function assertDriverArgs(args: DriverOpArgs): void {
  const extra = args as unknown as Record<string, unknown>;
  for (const k of ['deploymentId', 'projectId', 'candidateId'] as const) {
    const v = extra[k];
    if (typeof v !== 'string' || !SAFE_ID.test(v)) {
      throw new Error(`invalid driver argument '${k}': must be an internally-derived identifier`);
    }
  }
  if ('runtime' in extra && extra.runtime !== 'verify' && extra.runtime !== 'live') {
    throw new Error(`invalid driver argument 'runtime': must be 'verify' or 'live'`);
  }
  if ('signal' in extra && extra.signal !== undefined) {
    const s = extra.signal as unknown;
    if (
      typeof s !== 'object' ||
      s === null ||
      typeof (s as AbortSignal).addEventListener !== 'function' ||
      typeof (s as AbortSignal).aborted !== 'boolean'
    ) {
      throw new Error(`invalid driver argument 'signal': must be an AbortSignal`);
    }
  }
  for (const k of ['backupId'] as const) {
    if (k in extra) {
      const v = extra[k];
      if (v !== null && (typeof v !== 'string' || !SAFE_ID.test(v))) {
        throw new Error(`invalid driver argument '${k}': must be an internally-derived identifier or null`);
      }
    }
  }
  // previousLiveVersion: null o referencia completa de imagen AppForge.
  if ('previousLiveVersion' in extra) {
    const v = extra['previousLiveVersion'];
    if (v !== null && (typeof v !== 'string' || !APPFORGE_IMAGE_REF_RE.test(v))) {
      throw new Error(
        `invalid driver argument 'previousLiveVersion': must be null or a full appforge image reference`,
      );
    }
  }
  const allowed = new Set([
    'deploymentId', 'projectId', 'candidateId', 'signal', 'runtime', 'previousLiveVersion', 'backupId',
  ]);
  for (const k of Object.keys(extra)) {
    if (!allowed.has(k)) throw new Error(`invalid driver argument '${k}': unknown argument`);
  }
}

export interface DeploymentDriver {
  readonly name: string;
  /**
   * Límite de pipelines completos que puede atender esta instancia. Ausente
   * significa que el driver no impone límite (fakes y adaptadores de tests).
   * 7B comparte una sola instancia entre HTTP y worker.
   */
  readonly maxConcurrentDeploys?: number;
  /** Drivers reales pueden exigir una versión inmutable devuelta por build. */
  readonly requiresCandidateVersion?: boolean;
  buildCandidate(args: DriverOpArgs): Promise<DriverResult>;
  prepareVerificationDatabase(args: DriverOpArgs): Promise<DriverResult>;
  runVerificationMigrations(args: DriverOpArgs): Promise<DriverResult>;
  discardVerificationDatabase(args: DriverOpArgs): Promise<DriverResult>;
  startVerificationRuntime(args: DriverOpArgs): Promise<DriverResult>;
  runHealthCheck(args: HealthCheckArgs): Promise<DriverResult>;
  runAuthenticatedVerification(args: DriverOpArgs): Promise<DriverResult>;
  stopVerificationRuntime(args: DriverOpArgs): Promise<DriverResult>;
  createLiveBackup(args: LiveBackupArgs): Promise<DriverResult>;
  runLiveMigrations(args: DriverOpArgs): Promise<DriverResult>;
  stopCurrentLiveRuntime(args: DriverOpArgs): Promise<DriverResult>;
  startCandidateAsLive(args: DriverOpArgs): Promise<DriverResult>;
  restoreBackup(args: RestoreBackupArgs): Promise<DriverResult>;
  startPreviousVersion(args: StartPreviousVersionArgs): Promise<DriverResult>;
  /**
   * Revisión Codex (Fase 6): descarta un candidato FALLIDO o NO PROMOCIONADO.
   * Semántica estricta:
   * - Solo para candidatos que nunca llegaron a live (fallo en
   *   building/migrating/verifying, cancelación pre-promoting, rollback).
   * - NUNCA debe llamarse después de que el candidato arrancase como live:
   *   en ese momento el candidato ES la versión live y descartarlo podría
   *   eliminar la imagen/runtime que acaba de promocionarse (Fase 7).
   * - La limpieza de recursos temporales de verificación usa
   *   `stopVerificationRuntime` + `discardVerificationDatabase`, no esta op.
   */
  discardCandidate(args: DriverOpArgs): Promise<DriverResult>;
  reconcileRuntime(args: ReconcileArgs): Promise<DriverResult>;
  /** Limpieza post-live opcional; jamás puede invalidar una promoción sana. */
  pruneManagedImages?(projectId: string, keepImages?: string[]): Promise<{ removed: string[]; failures: string[] }>;
}

const activeByDriver = new WeakMap<DeploymentDriver, number>();

/**
 * Reserva capacidad para un pipeline completo. Devuelve una liberación
 * idempotente, o null antes de que se cree/persista ningún deployment.
 */
export function acquireDeploymentCapacity(driver: DeploymentDriver): (() => void) | null {
  const configured = driver.maxConcurrentDeploys;
  if (configured === undefined) return () => undefined;
  const max = Math.max(1, Math.floor(configured));
  const active = activeByDriver.get(driver) ?? 0;
  if (active >= max) return null;
  activeByDriver.set(driver, active + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = activeByDriver.get(driver) ?? 0;
    if (current <= 1) activeByDriver.delete(driver);
    else activeByDriver.set(driver, current - 1);
  };
}

/** Solo para diagnóstico/pruebas; no muta el contador. */
export function activeDeploymentCapacity(driver: DeploymentDriver): number {
  return activeByDriver.get(driver) ?? 0;
}

// ---------------------------------------------------------------------------
// FakeDeploymentDriver — solo para pruebas (Fase 6)
// ---------------------------------------------------------------------------

export type FakeOpName =
  | 'buildCandidate'
  | 'prepareVerificationDatabase'
  | 'runVerificationMigrations'
  | 'discardVerificationDatabase'
  | 'startVerificationRuntime'
  | 'runHealthCheck'
  | 'runAuthenticatedVerification'
  | 'stopVerificationRuntime'
  | 'createLiveBackup'
  | 'runLiveMigrations'
  | 'stopCurrentLiveRuntime'
  | 'startCandidateAsLive'
  | 'restoreBackup'
  | 'startPreviousVersion'
  | 'discardCandidate'
  | 'reconcileRuntime';

export const FAKE_OP_NAMES: readonly FakeOpName[] = [
  'buildCandidate',
  'prepareVerificationDatabase',
  'runVerificationMigrations',
  'discardVerificationDatabase',
  'startVerificationRuntime',
  'runHealthCheck',
  'runAuthenticatedVerification',
  'stopVerificationRuntime',
  'createLiveBackup',
  'runLiveMigrations',
  'stopCurrentLiveRuntime',
  'startCandidateAsLive',
  'restoreBackup',
  'startPreviousVersion',
  'discardCandidate',
  'reconcileRuntime',
];

/** Comportamiento configurable por operación. 'hang' = no resuelve hasta recibir abort. */
export type FakeOpBehavior = 'success' | 'fail' | 'timeout' | 'hang';

export interface FakeCall {
  op: FakeOpName;
  args: DriverOpArgs;
  /** Estado persistido en `deployments` observado DURANTE la llamada (criterio 2). */
  observedStatus: string | null;
  at: string;
}

export interface FakeDriverOptions {
  /**
   * Conexión a la BD del Studio. Si se proporciona, cada operación lee el
   * estado persistido del deployment durante la llamada para que los tests
   * verifiquen que la transición se persistió ANTES de invocar al driver.
   * Solo lectura: el fake nunca escribe en `deployments`.
   */
  db?: Database.Database;
  behavior?: Partial<Record<FakeOpName, FakeOpBehavior>>;
  /** Códigos de error estables por operación (defecto: `<OP>_FAILED`). */
  failCode?: Partial<Record<FakeOpName, string>>;
  failError?: Partial<Record<FakeOpName, string>>;
  /** Retraso simulado por operación (ms) para probar cancelación/timeouts. */
  delayMs?: Partial<Record<FakeOpName, number>>;
  /**
   * Hooks por operación (p. ej. solicitar cancelación a mitad del
   * pipeline). Reciben la llamada registrada.
   */
  hooks?: Partial<Record<FakeOpName, (call: FakeCall) => void | Promise<void>>>;
  /**
   * Compuertas manuales: la operación espera a que se resuelva la promesa
   * devuelta (para tests de concurrencia deterministas).
   */
  gates?: Partial<Record<FakeOpName, () => Promise<void>>>;
  /** backupId devuelto por createLiveBackup (derivado si se omite). */
  backupId?: string;
  /**
   * Para tests (bloqueo 3, revisión Codex final): omite `backupId` en el
   * resultado de createLiveBackup para simular un backup sin identificador.
   */
  omitBackupId?: boolean;
  /**
   * Para tests (bloqueo 3): valor de `backupValidated` en el resultado de
   * createLiveBackup (defecto 'true'; 'false' simula backup no validado).
   */
  backupValidated?: string;
  /**
   * Decisor dinámico por operación (p. ej. fallar runHealthCheck solo para
   * runtime='live'). Tiene prioridad sobre `behavior`.
   */
  decide?: (op: FakeOpName, args: DriverOpArgs) => FakeOpBehavior | undefined;
  /** Salida bruta por operación (para probar sanitizado y truncado). */
  outputOverride?: Partial<Record<FakeOpName, string>>;
}

/**
 * Adaptador falso determinista. No ejecuta Docker, ni shell, ni red, ni
 * toca Oracle: simula éxito/fallo/timeout por operación y registra cada
 * llamada con el estado persistido observado.
 */
export class FakeDeploymentDriver implements DeploymentDriver {
  readonly name = 'fake';
  readonly calls: FakeCall[] = [];
  private readonly opts: FakeDriverOptions;
  /** Operaciones en vuelo (revisión Codex: debe quedar a 0 tras abort/timeout). */
  private readonly pending = new Set<FakeCall>();

  constructor(opts: FakeDriverOptions = {}) {
    this.opts = opts;
  }

  callsOf(op: FakeOpName): FakeCall[] {
    return this.calls.filter((c) => c.op === op);
  }

  /** Número de operaciones del driver aún sin resolver. */
  pendingOpCount(): number {
    return this.pending.size;
  }

  private abortAwareDelay(signal: AbortSignal | undefined, ms: number): Promise<void> {
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

  /** Revisión Codex: el fake de una operación colgada solo resuelve al recibir abort. */
  private waitForAbort(signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve) => {
      if (!signal || signal.aborted) return resolve();
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  }

  private async run(op: FakeOpName, args: DriverOpArgs): Promise<DriverResult> {
    assertDriverArgs(args);
    let observedStatus: string | null = null;
    if (this.opts.db) {
      try {
        const row = this.opts.db
          .prepare('SELECT status FROM deployments WHERE id=?')
          .get(args.deploymentId) as { status: string } | undefined;
        observedStatus = row?.status ?? null;
      } catch {
        observedStatus = null;
      }
    }
    const call: FakeCall = { op, args: { ...args }, observedStatus, at: new Date().toISOString() };
    // Se registra al invocar (antes de la compuerta): el orquestador ya
    // llamó a la operación aunque esta espere.
    this.calls.push(call);
    this.pending.add(call);
    try {
      const gate = this.opts.gates?.[op];
      if (gate) await gate();
      const hook = this.opts.hooks?.[op];
      if (hook) await hook(call);
      await this.abortAwareDelay(args.signal, this.opts.delayMs?.[op] ?? 0);
      if (args.signal?.aborted) {
        return { ok: false, code: 'OPERATION_ABORTED', error: `fake ${op} aborted` };
      }
      const behavior = this.opts.decide?.(op, args) ?? this.opts.behavior?.[op] ?? 'success';
      if (behavior === 'hang') {
        await this.waitForAbort(args.signal);
        return { ok: false, code: 'OPERATION_ABORTED', error: `fake ${op} aborted after hang` };
      }
      if (behavior === 'success') {
        const data: Record<string, string> | undefined =
          op === 'createLiveBackup'
            ? {
                ...(this.opts.omitBackupId ? {} : { backupId: this.opts.backupId ?? `bk_${args.deploymentId.slice(0, 8)}` }),
                backupValidated: this.opts.backupValidated ?? 'true',
              }
            : undefined;
        return { ok: true, code: `${op.toUpperCase()}_OK`, output: this.opts.outputOverride?.[op] ?? `fake ${op} ok`, data };
      }
      const code =
        behavior === 'timeout'
          ? 'OPERATION_TIMEOUT'
          : (this.opts.failCode?.[op] ?? `${op.toUpperCase()}_FAILED`);
      const error = this.opts.failError?.[op] ?? `fake ${op} failed`;
      return { ok: false, code, error, output: `fake ${op}: ${error}` };
    } finally {
      this.pending.delete(call);
    }
  }

  buildCandidate(args: DriverOpArgs): Promise<DriverResult> { return this.run('buildCandidate', args); }
  prepareVerificationDatabase(args: DriverOpArgs): Promise<DriverResult> { return this.run('prepareVerificationDatabase', args); }
  runVerificationMigrations(args: DriverOpArgs): Promise<DriverResult> { return this.run('runVerificationMigrations', args); }
  discardVerificationDatabase(args: DriverOpArgs): Promise<DriverResult> { return this.run('discardVerificationDatabase', args); }
  startVerificationRuntime(args: DriverOpArgs): Promise<DriverResult> { return this.run('startVerificationRuntime', args); }
  runHealthCheck(args: HealthCheckArgs): Promise<DriverResult> { return this.run('runHealthCheck', args); }
  runAuthenticatedVerification(args: DriverOpArgs): Promise<DriverResult> { return this.run('runAuthenticatedVerification', args); }
  stopVerificationRuntime(args: DriverOpArgs): Promise<DriverResult> { return this.run('stopVerificationRuntime', args); }
  createLiveBackup(args: LiveBackupArgs): Promise<DriverResult> { return this.run('createLiveBackup', args); }
  runLiveMigrations(args: DriverOpArgs): Promise<DriverResult> { return this.run('runLiveMigrations', args); }
  stopCurrentLiveRuntime(args: DriverOpArgs): Promise<DriverResult> { return this.run('stopCurrentLiveRuntime', args); }
  startCandidateAsLive(args: DriverOpArgs): Promise<DriverResult> { return this.run('startCandidateAsLive', args); }
  restoreBackup(args: RestoreBackupArgs): Promise<DriverResult> { return this.run('restoreBackup', args); }
  startPreviousVersion(args: StartPreviousVersionArgs): Promise<DriverResult> { return this.run('startPreviousVersion', args); }
  discardCandidate(args: DriverOpArgs): Promise<DriverResult> { return this.run('discardCandidate', args); }
  reconcileRuntime(args: ReconcileArgs): Promise<DriverResult> {
    return this.run('reconcileRuntime', {
      deploymentId: args.deploymentId,
      projectId: args.projectId,
      candidateId: args.candidateId,
    });
  }
}
