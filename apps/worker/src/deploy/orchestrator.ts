/**
 * Fase 6 — Orquestador persistente del pipeline de despliegue full-stack
 * (CONTRACT.md §9.21).
 *
 * El orquestador decide el orden fijo de fases, persiste cada transición
 * ANTES de invocar la operación del driver, y gestiona fallos, cancelación,
 * limpieza y rollback. No conoce comandos Docker: solo habla con la
 * interfaz cerrada `DeploymentDriver`.
 *
 * Orden fijo:
 *   pending → building → migrating → verifying → promoting → live
 *   (más failed / rolled_back / cancelled como terminales).
 *
 * Semántica de fallos (exactamente la especificada):
 * - building: failed, sin rollback, limpieza del candidato.
 * - migrating (verificación): failed, live intacto, limpieza de verificación.
 * - verifying: failed, live intacto, runtime verify eliminado siempre.
 * - backup: failed, sin migraciones live, live intacto.
 * - migración live / stop live / start candidato / health live: rollback
 *   exactamente una vez → rolled_back si funciona, failed (con ambos
 *   diagnósticos) si el rollback falla. Sin bucles.
 * - Nunca hay dos versiones live simultáneas según el estado persistido:
 *   `project_runtime` tiene una sola fila por proyecto y solo se actualiza
 *   tras el health live correcto.
 *
 * Semántica de cancelación:
 * - `cancel_requested` persistente; se comprueba antes de cada fase,
 *   después de cada operación larga y antes de entrar en `promoting`.
 * - En pending/building/migrating/verifying: limpieza de recursos
 *   provisionales y transición a `cancelled`.
 * - Una vez iniciada la sección crítica de `promoting`, la cancelación NO
 *   aborta a mitad de una migración: se completa una promoción segura o se
 *   ejecuta el rollback. El flag queda registrado en la fila.
 * - Ningún camino deja un deployment eternamente no terminal (incluido un
 *   catch-all ante excepciones inesperadas).
 *
 * Este módulo no ejecuta shell, no abre red y no importa Docker.
 */

import type Database from 'better-sqlite3';
import {
  DeploymentError,
  createDeployment,
  getDeployment,
  getProjectRuntime,
  isCancelRequested,
  recordEvent,
  setDeploymentBackup,
  setDeploymentCandidate,
  setDeploymentPreviousLive,
  transitionDeployment,
  upsertProjectRuntime,
  type DeploymentRecord,
} from './stateMachine.js';
import { nowIso } from '../tools.js';
import type {
  DeploymentDriver,
  DriverOpArgs,
  DriverResult,
} from './driver.js';

export interface VerificationGateResult {
  ok: boolean;
  reason?: string;
}

export interface RunDeploymentOptions {
  projectId: string;
  target: string;
  /**
   * Deployment ya creado (ruta HTTP: creado + 202, pipeline en segundo
   * plano). Si se omite, el orquestador lo crea (ruta tool del agente).
   */
  deploymentId?: string;
  /**
   * Puerta de verificación 5A/5B. El tool del agente inyecta la puerta real
   * en memoria (`dynamicGateStatus`); la ruta HTTP inyecta la aproximación
   * persistida (`persistedVerificationGate`). Los tests inyectan stubs.
   */
  verificationGate?: () => VerificationGateResult;
}

export const SUPPORTED_DEPLOY_TARGETS = ['oracle'] as const;

function describeResult(r: DriverResult): string {
  return `${r.code ?? 'FAILED'}: ${r.error ?? 'unknown error'}`;
}

function containerNameFor(projectId: string): string {
  // Identificador interno derivado; Fase 7 lo sustituirá por el nombre real.
  return `appforge-app-${projectId.slice(0, 8)}`;
}

function candidateIdFor(deploymentId: string): string {
  return `cand-${deploymentId.slice(0, 8)}`;
}

/**
 * Aproximación persistida de la puerta 5A/5B para la ruta HTTP (los receipts
 * en memoria del agente no son visibles desde el servidor):
 * - el último build del proyecto debe ser `success`;
 * - la última fila por versión en `migrations` debe ser `success`.
 * La puerta autoritativa vive en el tool del agente (`dynamicGateStatus`).
 */
export function persistedVerificationGate(db: Database.Database, projectId: string): VerificationGateResult {
  const build = db
    .prepare('SELECT status FROM builds WHERE project_id=? ORDER BY started_at DESC LIMIT 1')
    .get(projectId) as { status: string } | undefined;
  if (!build || build.status !== 'success') {
    return { ok: false, reason: 'no successful build on record for this project (run the 5A verification tools first)' };
  }
  const rows = db
    .prepare('SELECT version, status FROM migrations WHERE project_id=? ORDER BY version ASC, started_at DESC')
    .all(projectId) as Array<{ version: number; status: string }>;
  const latest = new Map<number, string>();
  for (const r of rows) {
    if (!latest.has(r.version)) latest.set(r.version, r.status);
  }
  for (const [version, status] of latest) {
    if (status !== 'success') {
      return { ok: false, reason: `migration v${version} is not successful (status=${status})` };
    }
  }
  return { ok: true };
}

/**
 * Ejecuta el pipeline completo. Nunca lanza excepciones por fallos del
 * despliegue: los fallos se persisten como estados terminales. Solo lanza
 * `DeploymentError` por errores de precondición (proyecto, tipo, target,
 * puerta, concurrencia) antes de que exista trabajo en curso.
 */
export async function runDeploymentPipeline(
  db: Database.Database,
  driver: DeploymentDriver,
  opts: RunDeploymentOptions,
): Promise<DeploymentRecord> {
  if (opts.target !== 'oracle') {
    throw new DeploymentError('INVALID_TARGET', `unsupported deploy target '${opts.target}' (only 'oracle' is supported)`, 400);
  }
  const gate = opts.verificationGate?.();
  if (gate && !gate.ok) {
    throw new DeploymentError('VERIFICATION_GATE', gate.reason ?? '5A/5B verification checks are not current', 409);
  }

  let dep: DeploymentRecord;
  if (opts.deploymentId) {
    const existing = getDeployment(db, opts.deploymentId);
    if (!existing) throw new DeploymentError('DEPLOYMENT_NOT_FOUND', `deployment '${opts.deploymentId}' not found`, 404);
    if (existing.projectId !== opts.projectId) {
      throw new DeploymentError('DEPLOYMENT_NOT_FOUND', `deployment '${opts.deploymentId}' not found`, 404);
    }
    dep = existing;
  } else {
    dep = createDeployment(db, { projectId: opts.projectId, target: opts.target });
  }
  const depId = dep.id;
  const projectId = dep.projectId;
  const candidateId = candidateIdFor(depId);
  const args: DriverOpArgs = { deploymentId: depId, projectId, candidateId };
  setDeploymentCandidate(db, depId, candidateId);

  /** Ejecuta una operación del driver registrando su evento (con duraciones reales). */
  const drive = async (phase: string, opName: string, fn: () => Promise<DriverResult>): Promise<DriverResult> => {
    const startedAt = nowIso();
    const t0 = Date.now();
    let result: DriverResult;
    try {
      result = await fn();
    } catch (e) {
      result = { ok: false, code: 'DRIVER_THROW', error: `driver threw: ${(e as Error).message}`.slice(0, 2000) };
    }
    const durationMs = Date.now() - t0;
    recordEvent(db, depId, {
      phase,
      event: opName,
      status: result.ok ? 'ok' : 'failed',
      startedAt,
      finishedAt: nowIso(),
      durationMs,
      output: result.output ?? null,
      error: result.ok ? null : describeResult(result),
    });
    return result;
  };

  /** Limpieza best-effort: nunca lanza. */
  const cleanup = async (phase: string, label: string, fns: Array<() => Promise<DriverResult>>): Promise<void> => {
    for (const fn of fns) {
      try {
        await fn();
      } catch (e) {
        recordEvent(db, depId, {
          phase,
          event: `cleanup:${label}`,
          status: 'failed',
          error: `cleanup failed: ${(e as Error).message}`.slice(0, 1000),
        });
      }
    }
  };

  const finishFailed = (phase: string, error: string): DeploymentRecord =>
    transitionDeployment(db, depId, 'failed', { diagnostic: `phase ${phase}: ${error}`.slice(0, 4000), error: error.slice(0, 4000) });

  const finishCancelled = (phase: string, note: string): DeploymentRecord =>
    transitionDeployment(db, depId, 'cancelled', { diagnostic: `cancelled during ${phase}: ${note}`.slice(0, 2000) });

  const cancelledNow = (): boolean => isCancelRequested(db, depId);

  try {
    // ---- 1. pending → building -------------------------------------------
    if (cancelledNow()) {
      return finishCancelled('pending', 'cancel requested before start; no driver operations ran');
    }
    transitionDeployment(db, depId, 'building', { diagnostic: `candidate=${candidateId}` });
    let r = await drive('building', 'buildCandidate', () => driver.buildCandidate(args));
    if (cancelledNow()) {
      await cleanup('building', 'removeCandidate', [() => driver.removeCandidate(args)]);
      return finishCancelled('building', 'cancel requested after build; candidate removed');
    }
    if (!r.ok) {
      await cleanup('building', 'removeCandidate', [() => driver.removeCandidate(args)]);
      return finishFailed('building', `candidate build failed (${describeResult(r)}); no rollback; live untouched`);
    }

    // ---- 2. building → migrating (BD de verificación; nunca live) ---------
    if (cancelledNow()) {
      await cleanup('migrating', 'removeCandidate', [() => driver.removeCandidate(args)]);
      return finishCancelled('migrating', 'cancel requested before verification database; candidate removed');
    }
    transitionDeployment(db, depId, 'migrating', { diagnostic: 'verification database (live untouched)' });
    r = await drive('migrating', 'prepareVerificationDatabase', () => driver.prepareVerificationDatabase(args));
    if (cancelledNow()) {
      await cleanup('migrating', 'discardVerification', [
        () => driver.discardVerificationDatabase(args),
        () => driver.removeCandidate(args),
      ]);
      return finishCancelled('migrating', 'cancel requested; verification resources discarded');
    }
    if (!r.ok) {
      await cleanup('migrating', 'discardVerification', [() => driver.discardVerificationDatabase(args)]);
      return finishFailed('migrating', `verification database failed (${describeResult(r)}); live untouched`);
    }
    r = await drive('migrating', 'runVerificationMigrations', () => driver.runVerificationMigrations(args));
    if (cancelledNow()) {
      await cleanup('migrating', 'discardVerification', [
        () => driver.discardVerificationDatabase(args),
        () => driver.removeCandidate(args),
      ]);
      return finishCancelled('migrating', 'cancel requested; verification resources discarded');
    }
    if (!r.ok) {
      await cleanup('migrating', 'discardVerification', [() => driver.discardVerificationDatabase(args)]);
      return finishFailed('migrating', `verification migrations failed (${describeResult(r)}); live untouched`);
    }

    // ---- 3. migrating → verifying (runtime verify siempre limpiado) ------
    if (cancelledNow()) {
      await cleanup('verifying', 'discardVerification', [
        () => driver.discardVerificationDatabase(args),
        () => driver.removeCandidate(args),
      ]);
      return finishCancelled('verifying', 'cancel requested before verification runtime');
    }
    transitionDeployment(db, depId, 'verifying', { diagnostic: 'ephemeral verification runtime' });
    r = await drive('verifying', 'startVerificationRuntime', () => driver.startVerificationRuntime(args));
    if (cancelledNow()) {
      await cleanup('verifying', 'stopVerify', [
        () => driver.stopVerificationRuntime(args),
        () => driver.discardVerificationDatabase(args),
        () => driver.removeCandidate(args),
      ]);
      return finishCancelled('verifying', 'cancel requested; verification runtime stopped');
    }
    if (!r.ok) {
      await cleanup('verifying', 'stopVerify', [() => driver.stopVerificationRuntime(args)]);
      return finishFailed('verifying', `verification runtime failed to start (${describeResult(r)}); live untouched`);
    }
    r = await drive('verifying', 'runHealthCheck', () => driver.runHealthCheck({ ...args, runtime: 'verify' }));
    if (cancelledNow()) {
      await cleanup('verifying', 'stopVerify', [
        () => driver.stopVerificationRuntime(args),
        () => driver.discardVerificationDatabase(args),
        () => driver.removeCandidate(args),
      ]);
      return finishCancelled('verifying', 'cancel requested; verification runtime stopped');
    }
    if (!r.ok) {
      await cleanup('verifying', 'stopVerify', [() => driver.stopVerificationRuntime(args)]);
      return finishFailed('verifying', `verification health check failed (${describeResult(r)}); live untouched`);
    }
    r = await drive('verifying', 'runAuthenticatedVerification', () => driver.runAuthenticatedVerification(args));
    // El runtime de verificación se elimina SIEMPRE, falle o no la verificación.
    const stopR = await drive('verifying', 'stopVerificationRuntime', () => driver.stopVerificationRuntime(args));
    if (!stopR.ok) {
      recordEvent(db, depId, {
        phase: 'verifying',
        event: 'verify_cleanup_warning',
        status: 'warning',
        error: `verification runtime stop reported failure (${describeResult(stopR)}); continuing`,
      });
    }
    if (cancelledNow()) {
      await cleanup('verifying', 'discardVerification', [
        () => driver.discardVerificationDatabase(args),
        () => driver.removeCandidate(args),
      ]);
      return finishCancelled('verifying', 'cancel requested after verification; resources cleaned');
    }
    if (!r.ok) {
      await cleanup('verifying', 'discardVerification', [() => driver.discardVerificationDatabase(args)]);
      return finishFailed('verifying', `authenticated verification failed (${describeResult(r)}); live untouched`);
    }
    await cleanup('verifying', 'discardVerification', [() => driver.discardVerificationDatabase(args)]);

    // ---- 4. verifying → promoting (SECCIÓN CRÍTICA) -----------------------
    // La cancelación se comprueba ANTES de entrar. Una vez dentro, no se
    // abandona el sistema a mitad de una migración: se completa una
    // promoción segura o se ejecuta el rollback (una sola vez).
    if (cancelledNow()) {
      await cleanup('promoting', 'preCritical', [
        () => driver.discardVerificationDatabase(args),
        () => driver.removeCandidate(args),
      ]);
      return finishCancelled('promoting', 'cancel requested before the critical section; nothing live was touched');
    }
    transitionDeployment(db, depId, 'promoting', {
      diagnostic: 'critical section: cancellation now completes safe promotion or single rollback',
    });
    const prevRuntime = getProjectRuntime(db, projectId);
    const previousLiveVersion = prevRuntime?.liveImage ?? null;
    setDeploymentPreviousLive(db, depId, previousLiveVersion);

    r = await drive('promoting', 'createLiveBackup', () =>
      driver.createLiveBackup({ ...args, previousLiveVersion }),
    );
    if (!r.ok) {
      return finishFailed(
        'promoting',
        `live backup failed (${describeResult(r)}); live migrations never ran; live untouched`,
      );
    }
    const backupId = r.data?.backupId ?? null;
    setDeploymentBackup(db, depId, backupId);

    /** Rollback exactamente una vez; sin bucles. */
    const rollbackOnce = async (originalError: string): Promise<DeploymentRecord> => {
      recordEvent(db, depId, {
        phase: 'promoting',
        event: 'rollback_started',
        status: 'running',
        output: `single rollback attempt after: ${originalError}`.slice(0, 2000),
      });
      const s1 = await drive('promoting', 'rollback:stopCurrentLiveRuntime', () => driver.stopCurrentLiveRuntime(args));
      const s2 = backupId
        ? await drive('promoting', 'rollback:restoreBackup', () => driver.restoreBackup({ ...args, backupId }))
        : { ok: true as const };
      const s3 = previousLiveVersion
        ? await drive('promoting', 'rollback:startPreviousVersion', () =>
            driver.startPreviousVersion({ ...args, previousLiveVersion }),
          )
        : { ok: true as const };
      const s4 = await drive('promoting', 'rollback:runHealthCheck', () =>
        driver.runHealthCheck({ ...args, runtime: 'live' }),
      );
      const failures = [
        s1.ok ? null : `stopCurrentLiveRuntime: ${describeResult(s1)}`,
        s2.ok ? null : `restoreBackup: ${describeResult(s2)}`,
        s3.ok ? null : `startPreviousVersion: ${describeResult(s3)}`,
        s4.ok ? null : `runHealthCheck(live): ${describeResult(s4)}`,
      ].filter((x): x is string => x !== null);
      if (failures.length === 0) {
        // project_runtime ya refleja la versión anterior (solo se escribe en
        // 'live'): no hay dos versiones live según el estado persistido.
        return transitionDeployment(db, depId, 'rolled_back', {
          diagnostic: `rolled back to ${previousLiveVersion ?? '(no previous version)'} after: ${originalError}`.slice(0, 4000),
        });
      }
      return finishFailed(
        'promoting',
        `deploy failed (${originalError}); rollback FAILED (${failures.join('; ')}); no further retries`,
      );
    };

    r = await drive('promoting', 'runLiveMigrations', () => driver.runLiveMigrations(args));
    if (!r.ok) return rollbackOnce(`live migrations failed (${describeResult(r)})`);
    r = await drive('promoting', 'stopCurrentLiveRuntime', () => driver.stopCurrentLiveRuntime(args));
    if (!r.ok) return rollbackOnce(`stop of previous live runtime failed (${describeResult(r)})`);
    r = await drive('promoting', 'startCandidateAsLive', () => driver.startCandidateAsLive(args));
    if (!r.ok) return rollbackOnce(`candidate failed to start as live (${describeResult(r)})`);
    r = await drive('promoting', 'runHealthCheck', () => driver.runHealthCheck({ ...args, runtime: 'live' }));
    if (!r.ok) return rollbackOnce(`live health check failed for candidate (${describeResult(r)})`);

    // ---- 5. promoting → live ---------------------------------------------
    // project_runtime SOLO se actualiza tras el health live correcto.
    upsertProjectRuntime(db, {
      projectId,
      containerName: containerNameFor(projectId),
      liveImage: candidateId,
      previousImage: previousLiveVersion,
      status: 'running',
    });
    await cleanup('live', 'removeCandidateArtifacts', [() => driver.removeCandidate(args)]);
    return transitionDeployment(db, depId, 'live', {
      diagnostic: `live=${candidateId} previous=${previousLiveVersion ?? '(none)'}`,
    });
  } catch (e) {
    // Catch-all: ningún camino deja un deployment eternamente no terminal.
    const message = e instanceof DeploymentError ? `${e.code}: ${e.message}` : `unexpected: ${(e as Error).message}`;
    try {
      const current = getDeployment(db, depId);
      if (current && ['pending', 'building', 'migrating', 'verifying', 'promoting'].includes(current.status)) {
        return finishFailed(current.status, message.slice(0, 4000));
      }
      return current ?? getDeployment(db, depId)!;
    } catch {
      throw e instanceof DeploymentError ? e : new DeploymentError('INTERNAL', message.slice(0, 2000));
    }
  }
}
