/**
 * Fase 6 — Máquina de estados cerrada del pipeline de despliegue
 * (CONTRACT.md §9.21).
 *
 * Principios:
 * - Toda transición se valida contra una tabla explícita de transiciones
 *   permitidas. No es posible escribir estados arbitrarios desde
 *   controladores HTTP, herramientas del agente o adaptadores: el único
 *   camino es `transitionDeployment`.
 * - Toda transición se persiste ANTES de invocar la operación del driver
 *   correspondiente (el orquestador transiciona primero, luego llama).
 * - Cada transición registra fecha, fase, resultado y diagnóstico en la
 *   tabla append-only `deployment_events`, y actualiza `updated_at`.
 * - Transición inválida → `DeploymentError` con código estable
 *   (`INVALID_TRANSITION`); repetir una transición ya completada es
 *   idempotente (no-op).
 * - Semántica de cancelación durante `promoting`: NO existe la transición
 *   `promoting -> cancelled`. Una cancelación solicitada en la sección
 *   crítica completa una promoción segura o ejecuta el rollback; nunca
 *   deja el deployment colgado a mitad de una migración.
 *
 * Este módulo no ejecuta shell, no toca la red y no conoce Docker.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { DeploymentStatus } from 'appforge-shared';
import { sanitizeSecrets } from '../secrets.js';
import { nowIso } from '../tools.js';

export type { DeploymentStatus };

export const NON_TERMINAL_STATUSES: readonly DeploymentStatus[] = [
  'pending',
  'building',
  'migrating',
  'verifying',
  'promoting',
];

export const TERMINAL_STATUSES: readonly DeploymentStatus[] = [
  'live',
  'failed',
  'rolled_back',
  'cancelled',
];

/** Camino nominal: pending → building → migrating → verifying → promoting → live */
const TRANSITIONS: Record<DeploymentStatus, readonly DeploymentStatus[]> = {
  pending: ['building', 'cancelled', 'failed'],
  building: ['migrating', 'cancelled', 'failed'],
  migrating: ['verifying', 'cancelled', 'failed'],
  verifying: ['promoting', 'cancelled', 'failed'],
  // Sin 'cancelled': la cancelación en la sección crítica completa la
  // promoción o ejecuta rollback (documentado en el orquestador).
  promoting: ['live', 'rolled_back', 'failed'],
  live: [],
  failed: [],
  rolled_back: [],
  cancelled: [],
};

export function isDeploymentStatus(s: string): s is DeploymentStatus {
  return (Object.keys(TRANSITIONS) as string[]).includes(s);
}

export function isTerminalStatus(s: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(s);
}

/** Error estable con código máquina (mapeado a HTTP por el servidor). */
export class DeploymentError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(code: string, message: string, statusCode = 500) {
    super(message);
    this.name = 'DeploymentError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/** Fila de `deployments` (columnas Fase 6 incluidas). */
export interface DeploymentRecord {
  id: string;
  projectId: string;
  target: string;
  status: DeploymentStatus;
  url: string | null;
  createdAt: string;
  logs: string | null;
  candidateId: string | null;
  previousLiveVersion: string | null;
  backupId: string | null;
  cancelRequested: boolean;
  startedAt: string | null;
  updatedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

export function rowToDeploymentRecord(r: Record<string, any>): DeploymentRecord {
  const status = String(r.status);
  if (!isDeploymentStatus(status)) {
    throw new DeploymentError('INVALID_STATE', `deployment ${r.id} has unknown status '${status}'`);
  }
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    target: String(r.target),
    status,
    url: (r.url as string | null) ?? null,
    createdAt: String(r.created_at),
    logs: (r.logs as string | null) ?? null,
    candidateId: (r.candidate_id as string | null) ?? null,
    previousLiveVersion: (r.previous_live_version as string | null) ?? null,
    backupId: (r.backup_id as string | null) ?? null,
    cancelRequested: Number(r.cancel_requested ?? 0) === 1,
    startedAt: (r.started_at as string | null) ?? null,
    updatedAt: (r.updated_at as string | null) ?? null,
    finishedAt: (r.finished_at as string | null) ?? null,
    error: (r.error as string | null) ?? null,
  };
}

export function getDeployment(db: Database.Database, id: string): DeploymentRecord | null {
  const row = db.prepare('SELECT * FROM deployments WHERE id=?').get(id) as Record<string, any> | undefined;
  return row ? rowToDeploymentRecord(row) : null;
}

export function listDeployments(db: Database.Database, projectId: string): DeploymentRecord[] {
  const rows = db
    .prepare('SELECT * FROM deployments WHERE project_id=? ORDER BY created_at DESC')
    .all(projectId) as Record<string, any>[];
  return rows.map(rowToDeploymentRecord);
}

export function getActiveDeployment(db: Database.Database, projectId: string): DeploymentRecord | null {
  const row = db
    .prepare(
      `SELECT * FROM deployments WHERE project_id=? AND status IN ('pending','building','migrating','verifying','promoting')
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(projectId) as Record<string, any> | undefined;
  return row ? rowToDeploymentRecord(row) : null;
}

// ---------------------------------------------------------------------------
// Eventos append-only + límites de logs
// ---------------------------------------------------------------------------

export const MAX_EVENT_OUTPUT_CHARS = 4_000;
export const MAX_DEPLOYMENT_LOGS_CHARS = 20_000;
/** Tope para `deployments.error` (se devuelve por la API: siempre sanitizado). */
export const MAX_ERROR_CHARS = 4_000;

/**
 * Revisión Codex (Fase 6): `deployments.error` se devuelve por la API, así
 * que TODO error (del driver, excepciones, rollback, reconciliación) se
 * sanitiza y limita ANTES de persistirlo. Nunca debe contener passwords,
 * tokens, cookies ni cabeceras Authorization.
 */
export function sanitizeDeploymentError(s: string | null | undefined): string | null {
  if (s === null || s === undefined) return null;
  return sanitizeSecrets(s).slice(0, MAX_ERROR_CHARS);
}

function truncateWithMarker(s: string, max: number, marker: (kept: number, total: number) => string): string {
  if (s.length <= max) return s;
  const kept = s.slice(0, max);
  return `${kept}${marker(kept.length, s.length)}`;
}

export interface DeploymentEventInput {
  phase: string;
  event: string;
  status?: string | null;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number | null;
  output?: string | null;
  error?: string | null;
}

export interface DeploymentEvent {
  seq: number;
  phase: string;
  event: string;
  status: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  output: string | null;
  error: string | null;
  createdAt: string;
}

/**
 * Registra un evento append-only. El output se sanitiza (secretos) y se
 * limita por evento con indicador explícito de truncado; los eventos
 * conservan el orden mediante `seq` por deployment.
 */
/**
 * Inserta el evento SIN abrir transacción propia: el llamador decide la
 * transacción. Revisión Codex (Fase 6): creación/transición/cancelación de
 * un deployment y su evento deben persistirse en UNA sola transacción, de
 * modo que un fallo al insertar el evento revierte también el cambio de
 * estado (nunca "estado sin evento").
 */
function insertEventRow(
  db: Database.Database,
  deploymentId: string,
  input: DeploymentEventInput,
): DeploymentEvent {
  const now = nowIso();
  const rawOutput = input.output ?? null;
  const output =
    rawOutput === null
      ? null
      : truncateWithMarker(sanitizeSecrets(rawOutput), MAX_EVENT_OUTPUT_CHARS, (kept, total) =>
          `\n…[output truncated: kept ${kept} of ${total} chars]`,
        );
  const seq = (
    db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM deployment_events WHERE deployment_id=?')
      .get(deploymentId) as { m: number }
  ).m + 1;
  db.prepare(
    `INSERT INTO deployment_events(deployment_id, seq, phase, event, status, started_at, finished_at,
      duration_ms, output, error, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    deploymentId,
    seq,
    input.phase,
    input.event,
    input.status ?? null,
    input.startedAt ?? now,
    input.finishedAt ?? now,
    input.durationMs ?? null,
    output,
    input.error ? sanitizeSecrets(input.error).slice(0, MAX_EVENT_OUTPUT_CHARS) : null,
    now,
  );
  // Resumen acotado en deployments.logs (una línea por evento).
  const line = `[${input.phase}] ${input.event}${input.status ? ` (${input.status})` : ''}${
    input.error ? `: ${sanitizeSecrets(input.error).slice(0, 300)}` : ''
  }\n`;
  const prev = (
    db.prepare('SELECT logs FROM deployments WHERE id=?').get(deploymentId) as { logs: string | null } | undefined
  )?.logs;
  const next = truncateWithMarker(`${prev ?? ''}${line}`, MAX_DEPLOYMENT_LOGS_CHARS, () =>
    `\n…[deployment logs truncated at ${MAX_DEPLOYMENT_LOGS_CHARS} chars]`,
  );
  db.prepare('UPDATE deployments SET logs=?, updated_at=? WHERE id=?').run(next, now, deploymentId);
  return {
    seq,
    phase: input.phase,
    event: input.event,
    status: input.status ?? null,
    startedAt: input.startedAt ?? now,
    finishedAt: input.finishedAt ?? now,
    durationMs: input.durationMs ?? null,
    output,
    error: input.error ?? null,
    createdAt: now,
  };
}

export function recordEvent(
  db: Database.Database,
  deploymentId: string,
  input: DeploymentEventInput,
): DeploymentEvent {
  // better-sqlite3 anida transacciones con SAVEPOINT: seguro llamarlo dentro
  // o fuera de una transacción existente.
  return db.transaction(() => insertEventRow(db, deploymentId, input))();
}

export function listDeploymentEvents(db: Database.Database, deploymentId: string): DeploymentEvent[] {
  const rows = db
    .prepare(
      `SELECT seq, phase, event, status, started_at, finished_at, duration_ms, output, error, created_at
       FROM deployment_events WHERE deployment_id=? ORDER BY seq ASC`,
    )
    .all(deploymentId) as Record<string, any>[];
  return rows.map((r) => ({
    seq: Number(r.seq),
    phase: String(r.phase),
    event: String(r.event),
    status: (r.status as string | null) ?? null,
    startedAt: (r.started_at as string | null) ?? null,
    finishedAt: (r.finished_at as string | null) ?? null,
    durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
    output: (r.output as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    createdAt: String(r.created_at),
  }));
}

// ---------------------------------------------------------------------------
// Creación (con garantía transaccional anti-concurrencia)
// ---------------------------------------------------------------------------

export interface CreateDeploymentInput {
  projectId: string;
  target: string;
}

/**
 * Crea un deployment en `pending`.
 *
 * Garantía transaccional: la inserción corre en `BEGIN IMMEDIATE` y existe
 * un índice único parcial que impide dos deployments no terminales para el
 * mismo proyecto. Si dos peticiones concurrentes compiten, una gana y la
 * otra recibe `DEPLOYMENT_ACTIVE` (409). El pre-chequeo previo solo sirve
 * para devolver un error limpio en el caso no concurrente.
 */
export function createDeployment(db: Database.Database, input: CreateDeploymentInput): DeploymentRecord {
  const project = db.prepare('SELECT id, type FROM projects WHERE id=?').get(input.projectId) as
    | { id: string; type: string }
    | undefined;
  if (!project) {
    throw new DeploymentError('PROJECT_NOT_FOUND', `project '${input.projectId}' not found`, 404);
  }
  if (project.type !== 'dynamic') {
    throw new DeploymentError(
      'INVALID_TYPE',
      `project '${input.projectId}' is static: this deployment pipeline only supports dynamic projects`,
      400,
    );
  }
  if (getActiveDeployment(db, input.projectId)) {
    throw new DeploymentError(
      'DEPLOYMENT_ACTIVE',
      `project '${input.projectId}' already has an active deployment`,
      409,
    );
  }
  const id = randomUUID();
  const now = nowIso();
  const run = () => {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        `INSERT INTO deployments(id, project_id, target, status, url, created_at, logs,
           candidate_id, previous_live_version, backup_id, cancel_requested,
           started_at, updated_at, finished_at, error)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id,
        input.projectId,
        input.target,
        'pending',
        null,
        now,
        '',
        null,
        null,
        null,
        0,
        now,
        now,
        null,
        null,
      );
      // Revisión Codex: el evento 'created' se inserta en la MISMA
      // transacción: si falla, la creación entera se revierte.
      insertEventRow(db, id, { phase: 'pending', event: 'created', status: 'pending', output: `target=${input.target}` });
      db.exec('COMMIT');
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* already rolled back */
      }
      // El índice único parcial convierte la carrera en un error estable.
      if (e instanceof Error && /UNIQUE constraint failed/i.test(e.message)) {
        throw new DeploymentError(
          'DEPLOYMENT_ACTIVE',
          `project '${input.projectId}' already has an active deployment`,
          409,
        );
      }
      throw e;
    }
  };
  run();
  const created = getDeployment(db, id);
  if (!created) throw new DeploymentError('INTERNAL', 'deployment creation failed');
  return created;
}

// ---------------------------------------------------------------------------
// Transiciones
// ---------------------------------------------------------------------------

export interface TransitionOptions {
  /** Diagnóstico humano (se sanitiza antes de persistir). */
  diagnostic?: string;
  /** Código/detalle de error para estados failed. */
  error?: string;
}

/**
 * Aplica una transición de estado validada y la persiste ANTES de que el
 * orquestador invoque la operación del driver correspondiente.
 *
 * - Estado destino desconocido → `INVALID_STATE`.
 * - Transición no permitida por la tabla → `INVALID_TRANSITION`.
 * - Repetir la transición al estado actual → idempotente (no-op).
 * - Estados terminales fijan `finished_at`.
 * - Revisión Codex: la actualización de estado y su evento se persisten en
 *   UNA sola transacción (nunca "estado sin evento"); `deployments.error`
 *   se sanitiza siempre (se devuelve por la API).
 */
export function transitionDeployment(
  db: Database.Database,
  deploymentId: string,
  to: string,
  opts: TransitionOptions = {},
): DeploymentRecord {
  if (!isDeploymentStatus(to)) {
    throw new DeploymentError('INVALID_STATE', `unknown deployment status '${to}'`);
  }
  const apply = (): { record: DeploymentRecord; repeated: boolean } => {
    const row = db.prepare('SELECT * FROM deployments WHERE id=?').get(deploymentId) as
      | Record<string, any>
      | undefined;
    if (!row) throw new DeploymentError('DEPLOYMENT_NOT_FOUND', `deployment '${deploymentId}' not found`, 404);
    const current = rowToDeploymentRecord(row);
    if (current.status === to) return { record: current, repeated: true }; // idempotente: no-op total
    if (!TRANSITIONS[current.status].includes(to)) {
      throw new DeploymentError(
        'INVALID_TRANSITION',
        `invalid deployment transition: ${current.status} -> ${to}`,
      );
    }
    const now = nowIso();
    const terminal = isTerminalStatus(to);
    const errorToPersist =
      to === 'failed' ? sanitizeDeploymentError(opts.error ?? current.error) : current.error;
    db.prepare(
      `UPDATE deployments SET status=?, updated_at=?, finished_at=COALESCE(finished_at,?), error=?
       WHERE id=?`,
    ).run(to, now, terminal ? now : null, errorToPersist, deploymentId);
    const next = rowToDeploymentRecord(
      db.prepare('SELECT * FROM deployments WHERE id=?').get(deploymentId) as Record<string, any>,
    );
    insertEventRow(db, deploymentId, {
      phase: to,
      event: 'transition',
      status: to,
      output: opts.diagnostic ?? null,
      error: to === 'failed' ? (opts.error ?? null) : null,
    });
    return { record: next, repeated: false };
  };
  return db.transaction(apply)().record;
}

/** Marca `cancel_requested=1` (persistente). Solo tiene efecto en estados no terminales. */
export function requestDeploymentCancel(db: Database.Database, deploymentId: string): DeploymentRecord | null {
  const dep = getDeployment(db, deploymentId);
  if (!dep) return null;
  if (!isTerminalStatus(dep.status) && !dep.cancelRequested) {
    // Revisión Codex: flag + evento en una sola transacción.
    db.transaction(() => {
      db.prepare('UPDATE deployments SET cancel_requested=1, updated_at=? WHERE id=?').run(nowIso(), deploymentId);
      insertEventRow(db, deploymentId, { phase: dep.status, event: 'cancel_requested', status: dep.status });
    })();
  }
  return getDeployment(db, deploymentId);
}

/**
 * Revisión Codex (Fase 6): formato interno obligatorio de identificadores
 * de backup. Antes de tocar live, el orquestador exige: resultado ok +
 * backupId con este formato + confirmación semántica `backupValidated`
 * del driver. Sin las tres cosas: `failed`, sin migraciones live.
 */
const BACKUP_ID_RE = /^bk_[A-Za-z0-9_-]{1,64}$/;
export function isValidBackupId(id: string | null | undefined): id is string {
  return typeof id === 'string' && BACKUP_ID_RE.test(id);
}

export function isDeploymentCancelRequested(db: Database.Database, deploymentId: string): boolean {  const row = db.prepare('SELECT cancel_requested FROM deployments WHERE id=?').get(deploymentId) as
    | { cancel_requested: number }
    | undefined;
  return !!row && Number(row.cancel_requested) === 1;
}

export function setDeploymentCandidate(db: Database.Database, deploymentId: string, candidateId: string): void {
  db.prepare('UPDATE deployments SET candidate_id=?, updated_at=? WHERE id=?').run(candidateId, nowIso(), deploymentId);
}

export function setDeploymentBackup(db: Database.Database, deploymentId: string, backupId: string | null): void {
  db.prepare('UPDATE deployments SET backup_id=?, updated_at=? WHERE id=?').run(backupId, nowIso(), deploymentId);
}

export function setDeploymentPreviousLive(
  db: Database.Database,
  deploymentId: string,
  previousLiveVersion: string | null,
): void {
  db.prepare('UPDATE deployments SET previous_live_version=?, updated_at=? WHERE id=?').run(
    previousLiveVersion,
    nowIso(),
    deploymentId,
  );
}

// ---------------------------------------------------------------------------
// project_runtime
// ---------------------------------------------------------------------------

export interface ProjectRuntimeRecord {
  projectId: string;
  containerName: string;
  liveImage: string;
  previousImage: string | null;
  status: 'running' | 'stopped' | 'missing';
  updatedAt: string;
}

export function getProjectRuntime(db: Database.Database, projectId: string): ProjectRuntimeRecord | null {
  const row = db.prepare('SELECT * FROM project_runtime WHERE project_id=?').get(projectId) as
    | Record<string, any>
    | undefined;
  if (!row) return null;
  return {
    projectId: String(row.project_id),
    containerName: String(row.container_name),
    liveImage: String(row.live_image),
    previousImage: (row.previous_image as string | null) ?? null,
    status: row.status as ProjectRuntimeRecord['status'],
    updatedAt: String(row.updated_at),
  };
}

export function upsertProjectRuntime(
  db: Database.Database,
  r: Omit<ProjectRuntimeRecord, 'updatedAt'>,
): ProjectRuntimeRecord {
  const now = nowIso();
  db.prepare(
    `INSERT INTO project_runtime(project_id, container_name, live_image, previous_image, status, updated_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(project_id) DO UPDATE SET
       container_name=excluded.container_name, live_image=excluded.live_image,
       previous_image=excluded.previous_image, status=excluded.status, updated_at=excluded.updated_at`,
  ).run(r.projectId, r.containerName, r.liveImage, r.previousImage, r.status, now);
  return { ...r, updatedAt: now };
}

// ---------------------------------------------------------------------------
// Reconciliación tras reinicio (CONTRACT.md §9.14 / §9.21)
// ---------------------------------------------------------------------------

/**
 * Al arrancar el Studio, ningún estado no terminal puede sobrevivir:
 * `pending|building|migrating|verifying|promoting` → `failed` con
 * `error='interrupted by server restart'`.
 *
 * Antes de marcar cada deployment se invoca la reconciliación abstracta
 * del driver (`reconcileRuntime`); en Fase 6 el fake driver la demuestra y
 * la reconciliación Docker real queda reservada a la Fase 7.
 * No se confía en PIDs persistidos (el pipeline Fase 6 no almacena ninguno).
 */
export async function reconcileDeployments(
  db: Database.Database,
  driver?: { reconcileRuntime: (args: { deploymentId: string; projectId: string; candidateId: string }) => Promise<unknown> },
): Promise<number> {
  const rows = db
    .prepare(
      `SELECT * FROM deployments WHERE status IN ('pending','building','migrating','verifying','promoting')
       ORDER BY created_at ASC`,
    )
    .all() as Record<string, any>[];
  let count = 0;
  for (const row of rows) {
    const dep = rowToDeploymentRecord(row);
    if (driver) {
      try {
        await driver.reconcileRuntime({
          deploymentId: dep.id,
          projectId: dep.projectId,
          candidateId: dep.candidateId ?? `cand-${dep.id.slice(0, 8)}`,
        });
      } catch (e) {
        recordEvent(db, dep.id, {
          phase: dep.status,
          event: 'reconcile_driver_error',
          status: dep.status,
          error: `driver reconcile failed: ${(e as Error).message}`.slice(0, 1000),
        });
      }
    }
    const now = nowIso();
    // Revisión Codex: el UPDATE y su evento van en una sola transacción;
    // si el evento falla, el deployment NO queda marcado (reintentable).
    db.transaction(() => {
      db.prepare(
        `UPDATE deployments SET status='failed', updated_at=?, finished_at=?, error=? WHERE id=? AND status=?`,
      ).run(now, now, sanitizeDeploymentError('interrupted by server restart'), dep.id, dep.status);
      insertEventRow(db, dep.id, {
        phase: 'failed',
        event: 'restart_recovery',
        status: 'failed',
        error: 'interrupted by server restart',
        output: `non-terminal status '${dep.status}' at startup; marked failed without trusting persisted PIDs`,
      });
    })();
    count += 1;
  }
  return count;
}
