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
 *   Tras una verificación CORRECTA, detener el runtime es PRECONDICIÓN
 *   OBLIGATORIA para promocionar (revisión Codex final): cualquier
 *   resultado no-ok del stop (fallo, excepción, timeout o abort)
 *   impide el backup y tocar live → failed + limpieza restante +
 *   diagnóstico completo. Si la BD de verificación no puede descartarse
 *   tras una verificación correcta, tampoco se promociona → failed.
 * - backup: failed, sin migraciones live, live intacto. El backup debe ser
 *   ok + backupId con formato interno válido + confirmación semántica de
 *   backup validado; si falta o es inválido, failed sin tocar live y el
 *   candidato se descarta exactamente una vez (un fallo del descarte
 *   queda en deployments.error y en los eventos).
 * - migración live / stop live / start candidato / health live: rollback
 *   exactamente una vez → rolled_back si funciona, failed (con ambos
 *   diagnósticos) si el rollback falla. Sin bucles. El rollback usa un
 *   presupuesto de recuperación INDEPENDIENTE (rollbackTimeoutMs,
 *   defecto 5 min): no depende del deadline global del pipeline, que
 *   puede estar ya vencido.
 * - rolled_back SOLO es válido si existía previousLiveVersion, fue
 *   arrancada y pasó health. Sin versión anterior: se restaura el backup
 *   cuando corresponda, se limpia el candidato y se termina en failed
 *   (nunca health ficticio sobre una versión inexistente).
 * - Nunca hay dos versiones live simultáneas según el estado persistido:
 *   `project_runtime` tiene una sola fila por proyecto y solo se actualiza
 *   tras el health live correcto, en la MISMA transacción que la
 *   transición a live y su evento (`finalizeLiveDeployment`, atómico).
 *
 * Semántica de timeouts y cancelación (revisión Codex):
 * - Cada operación del driver corre con un AbortController propio:
 *   timeout por operación configurable + timeout total del pipeline.
 * - Fuera de la sección crítica de `promoting`, `cancel_requested`
 *   (sondeo persistente) también dispara el abort: una operación bloqueada
 *   puede interrumpirse de verdad.
 * - El abort es REAL: tras dispararlo, el orquestador ESPERA a que la
 *   operación termine (el driver debe resolver su promesa al abortar);
 *   nunca se deja trabajo en segundo plano (Promise.race solo).
 * - Timeout/cancelación terminan SIEMPRE en estado terminal y ejecutan
 *   limpieza: pre-promoting → `cancelled` (cancel) o `failed` (timeout);
 *   en `promoting` la cancelación NO aborta a mitad de una migración: se
 *   completa una promoción segura o se ejecuta el rollback (el flag queda
 *   registrado). Un timeout en `promoting` sí aborta y dispara rollback.
 * - Ningún camino deja un deployment eternamente no terminal (incluido un
 *   catch-all ante excepciones inesperadas) ni operaciones en vuelo.
 *
 * Limpieza (revisión Codex): `cleanup()` inspecciona cada DriverResult,
 * registra los fallos de limpieza como eventos y los conserva en el
 * diagnóstico final (nunca se tratan como éxito silencioso).
 *
 * Este módulo no ejecuta shell, no abre red y no importa Docker.
 */

import type Database from 'better-sqlite3';
import {
  DeploymentError,
  createDeployment,
  finalizeLiveDeployment,
  getDeployment,
  getProjectRuntime,
  isDeploymentCancelRequested,
  isValidBackupId,
  recordEvent,
  setDeploymentBackup,
  setDeploymentCandidate,
  setDeploymentPreviousLive,
  transitionDeployment,
  type DeploymentRecord,
} from './stateMachine.js';

export { DeploymentError };
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
   * en memoria (`dynamicGateStatus`); la ruta HTTP inyecta la puerta
   * persistida autoritativa (`persistedDynamicGateStatus`, seis receipts
   * con fingerprint y orden canónico). Los tests inyectan stubs.
   */
  verificationGate?: () => VerificationGateResult;
  /**
   * Revisión Codex: timeouts configurables. Defectos según CONTRACT §9.18
   * (10 min por operación, 20 min total). Los tests usan valores pequeños.
   */
  opTimeoutMs?: number;
  pipelineTimeoutMs?: number;
  /**
   * Revisión Codex final (NO-GO, bloqueo 2): presupuesto de recuperación
   * INDEPENDIENTE para el rollback. El rollback no puede depender del
   * deadline global del pipeline (puede estar ya vencido cuando se
   * necesita). Defecto 5 min; acotado y configurable.
   */
  rollbackTimeoutMs?: number;
  /** Sondeo de `cancel_requested` mientras una operación está en vuelo. */
  cancelPollMs?: number;
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
  const opTimeoutMs = opts.opTimeoutMs ?? 600_000;
  const pipelineTimeoutMs = opts.pipelineTimeoutMs ?? 1_200_000;
  const rollbackTimeoutMs = opts.rollbackTimeoutMs ?? 300_000;
  const cancelPollMs = opts.cancelPollMs ?? 250;
  const pipelineDeadline = Date.now() + pipelineTimeoutMs;

  let dep: DeploymentRecord;
  if (opts.deploymentId) {
    const existing = getDeployment(db, opts.deploymentId);
    if (!existing) throw new DeploymentError('DEPLOYMENT_NOT_FOUND', `deployment '${opts.deploymentId}' not found`, 404);
    if (existing.projectId !== opts.projectId) {
      throw new DeploymentError('DEPLOYMENT_NOT_FOUND', `deployment '${opts.deploymentId}' not found`, 404);
    }
    dep = existing;
    // Re-chequeo defensivo (la ruta HTTP ya validó): un deployment
    // pre-creado nunca debe quedar colgado en no terminal.
    const gate = opts.verificationGate?.();
    if (gate && !gate.ok) {
      return transitionDeployment(db, dep.id, 'failed', {
        diagnostic: gate.reason ?? '5A/5B verification checks are not current',
        error: `VERIFICATION_GATE: ${gate.reason ?? '5A/5B verification checks are not current'}`,
      });
    }
  } else {
    const gate = opts.verificationGate?.();
    if (gate && !gate.ok) {
      throw new DeploymentError('VERIFICATION_GATE', gate.reason ?? '5A/5B verification checks are not current', 409);
    }
    dep = createDeployment(db, { projectId: opts.projectId, target: opts.target });
  }
  const depId = dep.id;
  const projectId = dep.projectId;
  const candidateId = candidateIdFor(depId);
  const args: DriverOpArgs = { deploymentId: depId, projectId, candidateId };
  setDeploymentCandidate(db, depId, candidateId);

  type AbortCause = 'op-timeout' | 'pipeline-timeout' | 'rollback-timeout' | 'cancel' | null;
  interface DriveOutcome {
    result: DriverResult;
    aborted: AbortCause;
    durationMs: number;
  }

  /**
   * Revisión Codex: ejecuta una operación del driver con abort REAL.
   * Crea un AbortController por operación; lo dispara ante timeout de
   * operación, timeout total del pipeline o (fuera de la sección crítica)
   * cancelación persistente. Tras el abort ESPERA a que la operación
   * termine: el driver debe resolver su promesa al abortar; nunca se deja
   * trabajo en segundo plano.
   */
  const drive = async (
    phase: string,
    opName: string,
    fn: (signal: AbortSignal) => Promise<DriverResult>,
    driveOpts?: { abortOnCancel?: boolean; deadlineMs?: number },
  ): Promise<DriveOutcome> => {
    const startedAt = nowIso();
    const t0 = Date.now();
    const controller = new AbortController();
    const abortOnCancel = driveOpts?.abortOnCancel ?? true;
    // Revisión Codex final (bloqueo 2): el deadline puede ser el global del
    // pipeline o el presupuesto de recuperación independiente del rollback.
    const deadlineMs = driveOpts?.deadlineMs ?? pipelineDeadline;
    const deadlineCause: Exclude<AbortCause, null> =
      driveOpts?.deadlineMs !== undefined ? 'rollback-timeout' : 'pipeline-timeout';
    let aborted: AbortCause = null;
    const fireAbort = (cause: Exclude<AbortCause, null>) => {
      if (aborted) return;
      aborted = cause;
      controller.abort();
    };
    const opTimer = setTimeout(() => fireAbort('op-timeout'), Math.max(1, opTimeoutMs));
    const pipelineTimer = setTimeout(
      () => fireAbort(deadlineCause),
      Math.max(1, deadlineMs - Date.now()),
    );
    const cancelPoll = setInterval(() => {
      try {
        if (abortOnCancel && isDeploymentCancelRequested(db, depId)) fireAbort('cancel');
      } catch {
        /* un hipo de la BD no debe tumbar el pipeline; el siguiente tick reintenta */
      }
    }, Math.max(5, cancelPollMs));
    let result: DriverResult;
    try {
      result = await fn(controller.signal);
      if (controller.signal.aborted && result.ok) {
        // Un driver que devuelve ok tras el abort incumple el contrato.
        result = { ok: false, code: 'OPERATION_ABORTED', error: `driver returned ok after abort (${opName})` };
      }
    } catch (e) {
      result = { ok: false, code: 'DRIVER_THROW', error: `driver threw: ${(e as Error).message}`.slice(0, 2000) };
    } finally {
      clearTimeout(opTimer);
      clearTimeout(pipelineTimer);
      clearInterval(cancelPoll);
    }
    const durationMs = Date.now() - t0;
    recordEvent(db, depId, {
      phase,
      event: opName,
      status: result.ok ? 'ok' : aborted === 'cancel' ? 'cancelled' : 'failed',
      startedAt,
      finishedAt: nowIso(),
      durationMs,
      output: result.output ?? null,
      error: result.ok ? null : `${describeResult(result)}${aborted ? ` [aborted: ${aborted}]` : ''}`,
    });
    return { result, aborted, durationMs };
  };

  /**
   * Revisión Codex: limpieza best-effort que INSPECCIONA cada resultado.
   * Los fallos de limpieza se registran como eventos y se devuelven para
   * conservarlos en el diagnóstico final (nunca éxito silencioso).
   */
  const cleanup = async (
    phase: string,
    label: string,
    fns: Array<(signal: AbortSignal) => Promise<DriverResult>>,
  ): Promise<string[]> => {
    const failures: string[] = [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, opTimeoutMs));
    try {
      for (const fn of fns) {
        try {
          const r = await fn(controller.signal);
          if (!r.ok) {
            const msg = `${label}: ${describeResult(r)}`;
            failures.push(msg);
            recordEvent(db, depId, { phase, event: `cleanup:${label}`, status: 'failed', error: msg });
          }
        } catch (e) {
          const msg = `${label}: cleanup threw: ${(e as Error).message}`;
          failures.push(msg);
          recordEvent(db, depId, {
            phase,
            event: `cleanup:${label}`,
            status: 'failed',
            error: msg.slice(0, 1000),
          });
        }
      }
    } finally {
      clearTimeout(timer);
    }
    return failures;
  };

  /** Matriz de limpieza de verificación (revisión Codex): según la fase. */
  const cleanupVerification = (phase: string, withRuntime: boolean): Promise<string[]> => {
    const fns: Array<(signal: AbortSignal) => Promise<DriverResult>> = [];
    if (withRuntime) fns.push((signal) => driver.stopVerificationRuntime({ ...args, signal }));
    fns.push((signal) => driver.discardVerificationDatabase({ ...args, signal }));
    fns.push((signal) => driver.discardCandidate({ ...args, signal }));
    return cleanup(phase, 'verification', fns);
  };

  const finishFailed = (phase: string, error: string): DeploymentRecord => {
    const full = `phase=${phase}: ${error}`;
    return transitionDeployment(db, depId, 'failed', { diagnostic: full.slice(0, 4000), error: full.slice(0, 4000) });
  };

  const finishCancelled = (phase: string, note: string): DeploymentRecord =>
    transitionDeployment(db, depId, 'cancelled', { diagnostic: `cancelled during ${phase}: ${note}`.slice(0, 2000) });

  const cancelledNow = (): boolean => isDeploymentCancelRequested(db, depId);

  const withCleanupFailures = (base: string, failures: string[]): string =>
    failures.length > 0 ? `${base}; cleanup failures: ${failures.join('; ')}` : base;

  /**
   * Revisión Codex: gestiona el resultado de drive() en fases
   * pre-promoting. Devuelve el DeploymentRecord terminal o null para
   * continuar. Cancel → cancelled; timeout → failed; fallo → failed.
   * Siempre con limpieza y sin dejar operaciones en vuelo.
   */
  const handlePrePromotingOutcome = async (
    phase: string,
    outcome: DriveOutcome,
    cleanupFns: Array<(signal: AbortSignal) => Promise<DriverResult>>,
    failMessage: (r: DriverResult) => string,
  ): Promise<DeploymentRecord | null> => {
    const { result, aborted } = outcome;
    if (aborted === 'cancel' || (!aborted && cancelledNow())) {
      const failures = await cleanup(phase, 'cancel', cleanupFns);
      return finishCancelled(
        phase,
        withCleanupFailures(
          aborted === 'cancel' ? 'blocked operation aborted; provisional resources cleaned' : 'cancel requested; provisional resources cleaned',
          failures,
        ),
      );
    }
    if (aborted) {
      const failures = await cleanup(phase, 'timeout', cleanupFns);
      return finishFailed(
        phase,
        withCleanupFailures(
          `${aborted === 'op-timeout' ? 'operation timed out' : 'pipeline timed out'} (${describeResult(result)}); live untouched`,
          failures,
        ),
      );
    }
    if (!result.ok) {
      const failures = await cleanup(phase, 'failure', cleanupFns);
      return finishFailed(phase, withCleanupFailures(failMessage(result), failures));
    }
    return null;
  };

  try {
    // ---- 1. pending → building -------------------------------------------
    if (cancelledNow()) {
      return finishCancelled('pending', 'cancel requested before start; no driver operations ran');
    }
    transitionDeployment(db, depId, 'building', { diagnostic: `candidate=${candidateId}` });
    const discardCandidateFn = (signal: AbortSignal) => driver.discardCandidate({ ...args, signal });
    let outcome = await drive('building', 'buildCandidate', (signal) => driver.buildCandidate({ ...args, signal }));
    let terminal = await handlePrePromotingOutcome('building', outcome, [discardCandidateFn], (r) =>
      `candidate build failed (${describeResult(r)}); no rollback; live untouched`,
    );
    if (terminal) return terminal;

    // ---- 2. building → migrating (BD de verificación; nunca live) ---------
    if (cancelledNow()) {
      const failures = await cleanup('migrating', 'cancel', [discardCandidateFn]);
      return finishCancelled('migrating', withCleanupFailures('cancel requested before verification database; candidate discarded', failures));
    }
    transitionDeployment(db, depId, 'migrating', { diagnostic: 'verification database (live untouched)' });
    const discardVerificationDbFn = (signal: AbortSignal) => driver.discardVerificationDatabase({ ...args, signal });
    outcome = await drive('migrating', 'prepareVerificationDatabase', (signal) =>
      driver.prepareVerificationDatabase({ ...args, signal }),
    );
    terminal = await handlePrePromotingOutcome(
      'migrating',
      outcome,
      [discardVerificationDbFn, discardCandidateFn],
      (r) => `verification database failed (${describeResult(r)}); live untouched`,
    );
    if (terminal) return terminal;
    outcome = await drive('migrating', 'runVerificationMigrations', (signal) =>
      driver.runVerificationMigrations({ ...args, signal }),
    );
    terminal = await handlePrePromotingOutcome(
      'migrating',
      outcome,
      [discardVerificationDbFn, discardCandidateFn],
      (r) => `verification migrations failed (${describeResult(r)}); live untouched`,
    );
    if (terminal) return terminal;

    // ---- 3. migrating → verifying (runtime verify siempre limpiado) ------
    if (cancelledNow()) {
      const failures = await cleanupVerification('verifying', false);
      return finishCancelled('verifying', withCleanupFailures('cancel requested before verification runtime', failures));
    }
    transitionDeployment(db, depId, 'verifying', { diagnostic: 'ephemeral verification runtime' });
    const stopVerifyFn = (signal: AbortSignal) => driver.stopVerificationRuntime({ ...args, signal });
    outcome = await drive('verifying', 'startVerificationRuntime', (signal) =>
      driver.startVerificationRuntime({ ...args, signal }),
    );
    terminal = await handlePrePromotingOutcome(
      'verifying',
      outcome,
      [stopVerifyFn, discardVerificationDbFn, discardCandidateFn],
      (r) => `verification runtime failed to start (${describeResult(r)}); live untouched`,
    );
    if (terminal) return terminal;
    outcome = await drive('verifying', 'runHealthCheck', (signal) =>
      driver.runHealthCheck({ ...args, runtime: 'verify', signal }),
    );
    terminal = await handlePrePromotingOutcome(
      'verifying',
      outcome,
      [stopVerifyFn, discardVerificationDbFn, discardCandidateFn],
      (r) => `verification health check failed (${describeResult(r)}); live untouched`,
    );
    if (terminal) return terminal;
    outcome = await drive('verifying', 'runAuthenticatedVerification', (signal) =>
      driver.runAuthenticatedVerification({ ...args, signal }),
    );
    // Si la propia verificación falla, expira o se cancela, el runtime puede
    // seguir en pie: la limpieza lo detiene (best-effort con diagnóstico).
    terminal = await handlePrePromotingOutcome(
      'verifying',
      outcome,
      [stopVerifyFn, discardVerificationDbFn, discardCandidateFn],
      (r) => `authenticated verification failed (${describeResult(r)}); live untouched`,
    );
    if (terminal) return terminal;
    // Revisión Codex final (bloqueo 1): detener el runtime de verificación
    // es PRECONDICIÓN OBLIGATORIA para promocionar. Cualquier resultado
    // no-ok (fallo, excepción, timeout o abort —incluido por cancelación—)
    // impide ejecutar el backup o tocar live: termina en failed, ejecuta
    // la limpieza restante y conserva todos los fallos en el diagnóstico,
    // porque no se puede garantizar que el runtime haya desaparecido.
    const stopOutcome = await drive('verifying', 'stopVerificationRuntime', (signal) =>
      driver.stopVerificationRuntime({ ...args, signal }),
    );
    if (!stopOutcome.result.ok) {
      const cause = stopOutcome.aborted
        ? `aborted (${stopOutcome.aborted}${stopOutcome.aborted === 'cancel' ? '; cancel was requested' : ''})`
        : describeResult(stopOutcome.result);
      const cleanFails = await cleanup('verifying', 'mandatoryStop', [discardVerificationDbFn, discardCandidateFn]);
      return finishFailed(
        'verifying',
        withCleanupFailures(
          `mandatory verification runtime stop failed (${cause}); cannot promote: backup and live untouched`,
          cleanFails,
        ),
      );
    }
    // Revisión Codex final (bloqueo 3): si la BD de verificación no puede
    // descartarse tras una verificación correcta, no se entra en promoting:
    // failed con el fallo de limpieza en el diagnóstico.
    const discardFails = await cleanup('verifying', 'discardVerification', [discardVerificationDbFn]);
    if (discardFails.length > 0) {
      const candidateFails = await cleanup('verifying', 'discardCandidate', [discardCandidateFn]);
      return finishFailed(
        'verifying',
        withCleanupFailures(
          `verification database discard failed; cannot promote: ${discardFails.join('; ')}`,
          candidateFails,
        ),
      );
    }

    // ---- 4. verifying → promoting (SECCIÓN CRÍTICA) -----------------------
    // La cancelación se comprueba ANTES de entrar. Una vez dentro, la
    // cancelación NO aborta operaciones en vuelo (abortOnCancel: false):
    // no se abandona el sistema a mitad de una migración; se completa una
    // promoción segura o se ejecuta el rollback (una sola vez). Los
    // timeouts SÍ siguen abortando: un timeout en promoting dispara
    // rollback, nunca deja el deployment colgado.
    if (cancelledNow()) {
      const failures = await cleanup('promoting', 'preCritical', [discardVerificationDbFn, discardCandidateFn]);
      return finishCancelled(
        'promoting',
        withCleanupFailures('cancel requested before the critical section; nothing live was touched', failures),
      );
    }
    transitionDeployment(db, depId, 'promoting', {
      diagnostic: 'critical section: cancellation now completes safe promotion or single rollback',
    });
    const prevRuntime = getProjectRuntime(db, projectId);
    const previousLiveVersion = prevRuntime?.liveImage ?? null;
    setDeploymentPreviousLive(db, depId, previousLiveVersion);

    const driveCritical = (
      opName: string,
      fn: (signal: AbortSignal) => Promise<DriverResult>,
    ): Promise<DriveOutcome> => drive('promoting', opName, fn, { abortOnCancel: false });

    // `backupId` se declara aquí (y no junto a su validación) porque
    // `rollbackOnce` lo referencia: declararlo después provocaría un
    // ReferenceError por TDZ si el backup se aborta antes de validarse.
    let backupId: string | null = null;

    /** Frase humana para la causa de abort en diagnósticos de promoting. */
    const abortNote = (aborted: AbortCause): string =>
      aborted === 'op-timeout'
        ? ' (operation timed out)'
        : aborted === 'pipeline-timeout'
          ? ' (pipeline timed out)'
          : aborted === 'rollback-timeout'
            ? ' (rollback recovery timed out)'
            : aborted === 'cancel'
              ? ' (cancelled)'
              : '';

    /** Rollback exactamente una vez; sin bucles. */
    const rollbackOnce = async (originalError: string): Promise<DeploymentRecord> => {
      // Revisión Codex final (bloqueo 2): presupuesto de recuperación
      // INDEPENDIENTE y compartido por todo el rollback. El deadline
      // global del pipeline puede estar ya vencido cuando se necesita el
      // rollback; sin presupuesto propio, las operaciones de recuperación
      // se abortarían de inmediato. Mantiene AbortSignal por operación y
      // espera la terminación real de cada una.
      const recoveryDeadline = Date.now() + Math.max(1, rollbackTimeoutMs);
      const driveRollback = (
        opName: string,
        fn: (signal: AbortSignal) => Promise<DriverResult>,
      ): Promise<DriveOutcome> =>
        drive('promoting', opName, fn, { abortOnCancel: false, deadlineMs: recoveryDeadline });
      recordEvent(db, depId, {
        phase: 'promoting',
        event: 'rollback_started',
        status: 'running',
        output: `single rollback attempt after: ${originalError}`.slice(0, 2000),
      });
      // Revisión Codex: rolled_back SOLO si existía previousLiveVersion.
      // Sin versión anterior: restaurar el backup cuando corresponda,
      // limpiar el candidato y terminar en failed (nunca un health
      // ficticio sobre una versión inexistente).
      if (!previousLiveVersion) {
        const parts = [`deploy failed (${originalError})`, 'no previous live version to roll back to'];
        if (backupId) {
          const rb = await driveRollback('rollback:restoreBackup', (signal) =>
            driver.restoreBackup({ ...args, backupId, signal }),
          );
          if (!rb.result.ok) parts.push(`backup restore also failed (${describeResult(rb.result)})`);
        }
        const cleanFails = await cleanup('promoting', 'discardCandidate', [discardCandidateFn]);
        return finishFailed('promoting', withCleanupFailures(parts.join('; '), cleanFails));
      }
      const s1 = await driveRollback('rollback:stopCurrentLiveRuntime', (signal) =>
        driver.stopCurrentLiveRuntime({ ...args, signal }),
      );
      const s2 = backupId
        ? await driveRollback('rollback:restoreBackup', (signal) =>
            driver.restoreBackup({ ...args, backupId, signal }),
          )
        : null;
      const s3 = await driveRollback('rollback:startPreviousVersion', (signal) =>
        driver.startPreviousVersion({ ...args, previousLiveVersion, signal }),
      );
      const s4 = await driveRollback('rollback:runHealthCheck', (signal) =>
        driver.runHealthCheck({ ...args, runtime: 'live', signal }),
      );
      const failures = [
        s1.result.ok ? null : `stopCurrentLiveRuntime: ${describeResult(s1.result)}`,
        s2 && !s2.result.ok ? `restoreBackup: ${describeResult(s2.result)}` : null,
        s3.result.ok ? null : `startPreviousVersion: ${describeResult(s3.result)}`,
        s4.result.ok ? null : `runHealthCheck(live): ${describeResult(s4.result)}`,
      ].filter((x): x is string => x !== null);
      if (failures.length === 0) {
        // project_runtime ya refleja la versión anterior (solo se escribe en
        // 'live'): no hay dos versiones live según el estado persistido.
        // El candidato fallido se descarta (nunca fue live).
        const cleanFails = await cleanup('promoting', 'discardCandidate', [discardCandidateFn]);
        return transitionDeployment(db, depId, 'rolled_back', {
          diagnostic: withCleanupFailures(
            `rolled back to ${previousLiveVersion} after: ${originalError}`,
            cleanFails,
          ).slice(0, 4000),
        });
      }
      return finishFailed(
        'promoting',
        `deploy failed (${originalError}); rollback FAILED (${failures.join('; ')}); no further retries`,
      );
    };

    let r = await driveCritical('createLiveBackup', (signal) =>
      driver.createLiveBackup({ ...args, previousLiveVersion, signal }),
    );
    if (r.aborted) return rollbackOnce(`live backup ${r.aborted} (${describeResult(r.result)})`);
    // Revisión Codex: backup OBLIGATORIO y validado antes de tocar live:
    // resultado ok + backupId presente + formato interno válido +
    // confirmación semántica de backup validado. Si falta o es inválido:
    // failed, runLiveMigrations nunca se ejecuta, live intacto.
    const backupIdCandidate = r.result.data?.backupId ?? null;
    const backupValidated = r.result.data?.backupValidated === 'true';
    if (!r.result.ok || !isValidBackupId(backupIdCandidate) || !backupValidated) {
      const detail = !r.result.ok
        ? describeResult(r.result)
        : !isValidBackupId(backupIdCandidate)
          ? `backupId missing or invalid ('${backupIdCandidate ?? '(none)'}')`
          : 'backup not semantically validated by driver';
      // Revisión Codex final (bloqueo 3): un backup inválido descarta el
      // candidato EXACTAMENTE UNA VEZ. Si el descarte falla, el fallo queda
      // en deployments.error y en los eventos (nunca se traga en silencio).
      const discardFails = await cleanup('promoting', 'discardCandidate', [discardCandidateFn]);
      return finishFailed(
        'promoting',
        withCleanupFailures(
          `live backup invalid (${detail}); live migrations never ran; live untouched`,
          discardFails,
        ),
      );
    }
    backupId = backupIdCandidate;
    setDeploymentBackup(db, depId, backupId);

    r = await driveCritical('runLiveMigrations', (signal) => driver.runLiveMigrations({ ...args, signal }));
    if (!r.result.ok) return rollbackOnce(`live migrations failed (${describeResult(r.result)})${abortNote(r.aborted)}`);
    r = await driveCritical('stopCurrentLiveRuntime', (signal) => driver.stopCurrentLiveRuntime({ ...args, signal }));
    if (!r.result.ok) return rollbackOnce(`stop of previous live runtime failed (${describeResult(r.result)})${abortNote(r.aborted)}`);
    r = await driveCritical('startCandidateAsLive', (signal) => driver.startCandidateAsLive({ ...args, signal }));
    if (!r.result.ok) return rollbackOnce(`candidate failed to start as live (${describeResult(r.result)})${abortNote(r.aborted)}`);
    r = await driveCritical('runHealthCheck', (signal) => driver.runHealthCheck({ ...args, runtime: 'live', signal }));
    if (!r.result.ok) return rollbackOnce(`live health check failed for candidate (${describeResult(r.result)})${abortNote(r.aborted)}`);

    // ---- 5. promoting → live ---------------------------------------------
    // Revisión Codex final (bloqueo 4): finalización ATÓMICA en una sola
    // transacción SQLite: project_runtime + transición a live + evento. Si
    // falla cualquiera de las escrituras, el nuevo runtime NO queda
    // publicado (revierte todo; el catch-all deja el deployment en failed
    // con el diagnóstico). project_runtime SOLO se actualiza tras el
    // health live correcto. El candidato ES ahora la versión live: nunca
    // se descarta aquí (podar artefactos viejos queda para Fase 7).
    return finalizeLiveDeployment(db, depId, {
      runtime: {
        projectId,
        containerName: containerNameFor(projectId),
        liveImage: candidateId,
        previousImage: previousLiveVersion,
        status: 'running',
      },
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
