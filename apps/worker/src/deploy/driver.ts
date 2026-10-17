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
 * En Fase 6 solo existe `FakeDeploymentDriver` (determinista, para
 * pruebas). `DockerDeploymentDriver` se añadirá en Fase 7.
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
 * Valida que los argumentos sean identificadores seguros derivados
 * internamente. Rechaza comandos, rutas, espacios y cadenas vacías: el
 * driver nunca debe recibir entrada libre del modelo. Los campos opcionales
 * (`previousLiveVersion`, `backupId`) admiten `null`; `runtime` solo
 * admite 'verify'|'live'. Interfaz cerrada: claves desconocidas → error.
 */
export function assertDriverArgs(args: DriverOpArgs): void {
  const extra = args as Record<string, unknown>;
  for (const k of ['deploymentId', 'projectId', 'candidateId'] as const) {
    const v = extra[k];
    if (typeof v !== 'string' || !SAFE_ID.test(v)) {
      throw new Error(`invalid driver argument '${k}': must be an internally-derived identifier`);
    }
  }
  if ('runtime' in extra && extra.runtime !== 'verify' && extra.runtime !== 'live') {
    throw new Error(`invalid driver argument 'runtime': must be 'verify' or 'live'`);
  }
  for (const k of ['previousLiveVersion', 'backupId'] as const) {
    if (k in extra) {
      const v = extra[k];
      if (v !== null && (typeof v !== 'string' || !SAFE_ID.test(v))) {
        throw new Error(`invalid driver argument '${k}': must be an internally-derived identifier or null`);
      }
    }
  }
  const allowed = new Set([
    'deploymentId', 'projectId', 'candidateId', 'runtime', 'previousLiveVersion', 'backupId',
  ]);
  for (const k of Object.keys(extra)) {
    if (!allowed.has(k)) throw new Error(`invalid driver argument '${k}': unknown argument`);
  }
}

export interface DeploymentDriver {
  readonly name: string;
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
  removeCandidate(args: DriverOpArgs): Promise<DriverResult>;
  reconcileRuntime(args: ReconcileArgs): Promise<DriverResult>;
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
  | 'removeCandidate'
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
  'removeCandidate',
  'reconcileRuntime',
];

/** Comportamiento configurable por operación. */
export type FakeOpBehavior = 'success' | 'fail' | 'timeout';

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

  constructor(opts: FakeDriverOptions = {}) {
    this.opts = opts;
  }

  callsOf(op: FakeOpName): FakeCall[] {
    return this.calls.filter((c) => c.op === op);
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
    const gate = this.opts.gates?.[op];
    if (gate) await gate();
    const hook = this.opts.hooks?.[op];
    if (hook) await hook(call);
    const delay = this.opts.delayMs?.[op] ?? 0;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    const behavior = this.opts.decide?.(op, args) ?? this.opts.behavior?.[op] ?? 'success';
    if (behavior === 'success') {
      const data: Record<string, string> | undefined =
        op === 'createLiveBackup' ? { backupId: this.opts.backupId ?? `backup-${args.deploymentId.slice(0, 8)}` } : undefined;
      return { ok: true, code: `${op.toUpperCase()}_OK`, output: this.opts.outputOverride?.[op] ?? `fake ${op} ok`, data };
    }
    const code =
      behavior === 'timeout'
        ? 'OPERATION_TIMEOUT'
        : (this.opts.failCode?.[op] ?? `${op.toUpperCase()}_FAILED`);
    const error = this.opts.failError?.[op] ?? `fake ${op} failed`;
    return { ok: false, code, error, output: `fake ${op}: ${error}` };
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
  removeCandidate(args: DriverOpArgs): Promise<DriverResult> { return this.run('removeCandidate', args); }
  reconcileRuntime(args: ReconcileArgs): Promise<DriverResult> {
    return this.run('reconcileRuntime', {
      deploymentId: args.deploymentId,
      projectId: args.projectId,
      candidateId: args.candidateId,
    });
  }
}
