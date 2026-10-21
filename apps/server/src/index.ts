/**
 * AppForge AI Studio — backend API (CONTRACT.md §3).
 * Fastify + SQLite WAL. Run with: npx tsx apps/server/src/index.ts
 * (no build step for the backend; `npm run typecheck` for types).
 */

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import archiver from 'archiver';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
import { z } from 'zod';
import type Database from 'better-sqlite3';
import type {
  ApiError,
  BuildRecord,
  ChatMessage,
  DeploymentInfo,
  MigrationRecord,
  Project,
  ProjectRuntime,
  RevisionInfo,
  Run,
  RunStats,
  Settings,
} from 'appforge-shared';
import { openDb } from './db.js';
import { assessTechnologyCompatibility, inferProjectType } from './compatibility.js';
import { buildFileTree, createProject, deleteProject, frontendDir, getProject, nowIso, projectDir, resolveIn, rowToProject } from './projects.js';
import {
  acquireProjectOperationLock,
  checkpointOperation,
  completeOperation,
  listRunningOperations,
  listOperations,
  OperationAuditError,
  reconcileProjectOperationLocks,
  releaseProjectOperationLock,
  reserveOperation,
} from './operations.js';
import { APPFORGE_IMAGE_REF_RE, activateDockerDeployment, activeDeploymentCapacity, checkBrowser, checkBrowserAtUrl, createTools, requestCancel, runAgentOnce, runCmd, startWorker, getPreview, failPreview, reconcilePreviews, waitForTaskSet, type AgentSettings, type ToolContext } from 'appforge-worker';
// Fase 6 — orquestador persistente del pipeline de despliegue (CONTRACT.md §9.21)
import {
  DeploymentError,
  acquireDeploymentCapacity,
  createDeployment,
  getActiveDeployment,
  getDeployment as getDeploymentRecord,
  getProjectRuntime as getProjectRuntimeRecord,
  listDeployments as listDeploymentRecords,
  persistedDynamicGateStatus,
  reconcileDeployments,
  reconcileProjectRuntimes,
  requestDeploymentCancel,
  transitionDeployment,
  finalizeLiveDeployment,
  setDeploymentBackup,
  setDeploymentPreviousLive,
  runDeploymentPipeline,
  isValidBackupId,
  sanitizeDeploymentError,
  type DeploymentDriver,
  type DeploymentRecord,
} from 'appforge-worker';

export const VERSION = '0.1.0';

/** 7C: production refuses to start with an unauthenticated administrative API. */
export function assertProductionConfiguration(env: NodeJS.ProcessEnv, dataDir: string): void {
  if (env.APPFORGE_PRODUCTION !== '1') return;
  const token = env.APPFORGE_ADMIN_TOKEN ?? '';
  if (token.length < 32 || token.length > 512 || /[\r\n\0]/.test(token)) {
    throw new Error('APPFORGE_ADMIN_TOKEN must contain 32-512 safe characters in production');
  }
  if (!path.isAbsolute(dataDir)) {
    throw new Error('DATA_DIR must be absolute in production');
  }
  if (env.APPFORGE_LLM_STUB === '1') {
    throw new Error('APPFORGE_LLM_STUB is forbidden in production');
  }
  parseShutdownTimeout(env.APPFORGE_SHUTDOWN_TIMEOUT_MS);
}

export function parseShutdownTimeout(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 30_000;
  if (!/^\d+$/.test(raw)) throw new Error('APPFORGE_SHUTDOWN_TIMEOUT_MS must be an integer between 1000 and 300000');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 300_000) {
    throw new Error('APPFORGE_SHUTDOWN_TIMEOUT_MS must be an integer between 1000 and 300000');
  }
  return value;
}

function sanitizeOperationDiagnostic(raw: string, dataDir: string): string {
  const sanitized = sanitizeDeploymentError(raw) ?? 'operation failed';
  const candidates = new Set([dataDir, path.normalize(dataDir), dataDir.replace(/\\/g, '/'), dataDir.replace(/\//g, '\\')]);
  let output = sanitized;
  for (const candidate of candidates) {
    if (candidate) output = output.split(candidate).join('[path]');
  }
  return output;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

interface StoredSettings {
  provider: 'groq' | 'openrouter';
  model: string;
  temperature: number;
  maxTokens: number;
  maxIterations: number;
  /** Fase 1: hard loop stop for the worker agent (optional: older stored settings may lack it). */
  maxHardIterations?: number;
  /** Fase 1: max failed repair verifications per run. */
  maxRepairAttempts?: number;
  llmTimeoutMs: number;
  cmdTimeoutMs: number;
  runTimeoutMs: number;
  language: 'es' | 'en';
  theme: 'dark' | 'light';
  autoRevision: boolean;
  autoBuild: boolean;
  secrets?: { groqKey?: string; openrouterKey?: string; vercelToken?: string };
}

function defaultSettings(): StoredSettings {
  return {
    provider: (process.env.LLM_PROVIDER === 'openrouter' ? 'openrouter' : 'groq') as 'groq' | 'openrouter',
    model: process.env.LLM_MODEL ?? '',
    temperature: Number(process.env.LLM_TEMPERATURE ?? 0.2),
    maxTokens: Number(process.env.LLM_MAX_TOKENS ?? 8000),
    maxIterations: 8,
    maxHardIterations: 60,
    maxRepairAttempts: 12,
    llmTimeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 120_000),
    cmdTimeoutMs: 180_000,
    runTimeoutMs: 900_000,
    language: 'es',
    theme: 'dark',
    autoRevision: true,
    autoBuild: true,
    secrets: {},
  };
}

export function ensureSettingsRow(db: Database.Database): StoredSettings {
  const row = db.prepare('SELECT data_json FROM settings WHERE id=1').get() as { data_json: string } | undefined;
  if (row) return { ...defaultSettings(), ...JSON.parse(row.data_json) };
  const s = defaultSettings();
  db.prepare('INSERT INTO settings(id, data_json) VALUES (1, ?)').run(JSON.stringify(s));
  return s;
}

export function toPublicSettings(s: StoredSettings): Settings {
  return {
    provider: s.provider,
    model: s.model,
    temperature: s.temperature,
    maxTokens: s.maxTokens,
    maxIterations: s.maxIterations,
    maxHardIterations: s.maxHardIterations,
    maxRepairAttempts: s.maxRepairAttempts,
    llmTimeoutMs: s.llmTimeoutMs,
    cmdTimeoutMs: s.cmdTimeoutMs,
    runTimeoutMs: s.runTimeoutMs,
    language: s.language,
    theme: s.theme,
    autoRevision: s.autoRevision,
    autoBuild: s.autoBuild,
    secrets: {
      groq: { configured: !!(s.secrets?.groqKey || process.env.GROQ_API_KEY) },
      openrouter: { configured: !!(s.secrets?.openrouterKey || process.env.OPENROUTER_API_KEY) },
      vercel: { configured: !!s.secrets?.vercelToken },
    },
  };
}

export function getAgentSettings(db: Database.Database): AgentSettings {
  const s = ensureSettingsRow(db);
  return {
    provider: s.provider,
    model: s.model,
    temperature: s.temperature,
    maxTokens: s.maxTokens,
    maxIterations: s.maxIterations,
    maxHardIterations: s.maxHardIterations,
    maxRepairAttempts: s.maxRepairAttempts,
    llmTimeoutMs: s.llmTimeoutMs,
    cmdTimeoutMs: s.cmdTimeoutMs,
    runTimeoutMs: s.runTimeoutMs,
    language: s.language,
    autoRevision: s.autoRevision,
  };
}

/** Test E: runs left queued/running across a restart become coherent errors. */
export function reconcileInterruptedRuns(db: Database.Database): number {
  const r = db
    .prepare("UPDATE runs SET status='error', finished_at=?, error=? WHERE status IN ('queued','running')")
    .run(nowIso(), 'interrupted by restart');
  return Number(r.changes);
}

/** Builds cannot survive a process restart; close stale UI state coherently. */
export function reconcileInterruptedBuilds(db: Database.Database): number {
  const finishedAt = nowIso();
  const r = db
    .prepare("UPDATE builds SET status='failed', finished_at=?, error=?, logs=COALESCE(logs,'') || ? WHERE status IN ('pending','running')")
    .run(finishedAt, 'interrupted by server restart', '\nBuild interrupted by server restart. Source files were preserved.');
  return Number(r.changes);
}

/** CONTRACT.md §9.14: migrations left pending/running across a restart become coherent errors. */
export function reconcileInterruptedMigrations(db: Database.Database): number {
  const finishedAt = nowIso();
  const r = db
    .prepare("UPDATE migrations SET status='failed', finished_at=?, error=? WHERE status IN ('pending','running')")
    .run(finishedAt, 'interrupted by server restart');
  return Number(r.changes);
}

/**
 * 7C.2: una operación administrativa interrumpida nunca se limita a cambiar
 * filas. Primero recupera el servicio; migraciones/rollback con backup
 * persistido restauran físicamente el estado anterior. Después conserva un
 * resultado 503 auditable: la petición original no se declara exitosa.
 */
export async function recoverInterruptedAdministrativeOperations(
  db: Database.Database,
  driver: DeploymentDriver | undefined,
  dataDir: string,
): Promise<number> {
  const running = listRunningOperations(db);
  for (const operation of running) {
    const args = {
      projectId: operation.projectId,
      deploymentId: operation.id,
      candidateId: `cand-${operation.id.slice(0, 8)}`,
      signal: AbortSignal.timeout(5 * 60_000),
    };
    let recovery: { ok: boolean; code?: string; error?: string } = {
      ok: false,
      code: 'DEPLOYMENT_DRIVER_NOT_CONFIGURED',
      error: 'deployment driver unavailable during restart recovery',
    };
    if (driver) {
      try {
        const checkpoint = operation.checkpoint as {
          phase?: unknown;
          backupId?: unknown;
          sourceDeploymentId?: unknown;
          currentImage?: unknown;
          rollbackDeploymentId?: unknown;
          targetImage?: unknown;
          deploymentId?: unknown;
        } | null;
        if (operation.operation === 'deploy' && checkpoint?.phase === 'accepted' && typeof checkpoint.deploymentId === 'string') {
          const accepted = getDeploymentRecord(db, checkpoint.deploymentId);
          if (accepted) {
            completeOperation(db, operation.id, 202, toDeploymentInfo(accepted));
            continue;
          }
        }
        if (
          operation.operation === 'deployment_cancel' &&
          checkpoint?.phase === 'cancel_requested' &&
          typeof checkpoint.deploymentId === 'string'
        ) {
          const cancelled = requestDeploymentCancel(db, checkpoint.deploymentId);
          if (cancelled) {
            completeOperation(db, operation.id, 200, toDeploymentInfo(cancelled));
            continue;
          }
        }
        const backupId = typeof checkpoint?.backupId === 'string' && isValidBackupId(checkpoint.backupId)
          ? checkpoint.backupId
          : null;
        const requiresRestore =
          operation.operation === 'migrations' &&
          checkpoint?.phase === 'backup_ready' &&
          backupId !== null;
        const rollbackCheckpoint =
          operation.operation === 'rollback' &&
          (checkpoint?.phase === 'safety_backup_ready' || checkpoint?.phase === 'commit_ready') &&
          backupId !== null &&
          typeof checkpoint.sourceDeploymentId === 'string' &&
          /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(checkpoint.sourceDeploymentId) &&
          typeof checkpoint.currentImage === 'string' &&
          APPFORGE_IMAGE_REF_RE.test(checkpoint.currentImage);
        if (rollbackCheckpoint) {
          if (
            checkpoint?.phase === 'commit_ready' &&
            typeof checkpoint.rollbackDeploymentId === 'string' &&
            typeof checkpoint.targetImage === 'string'
          ) {
            const committed = getDeploymentRecord(db, checkpoint.rollbackDeploymentId);
            const runtime = getProjectRuntimeRecord(db, operation.projectId);
            if (committed?.status === 'live' && runtime?.status === 'running' && runtime.liveImage === checkpoint.targetImage) {
              completeOperation(db, operation.id, 200, { deployment: toDeploymentInfo(committed) });
              continue;
            }
          }
          const rollbackArgs = {
            projectId: operation.projectId,
            deploymentId: checkpoint.sourceDeploymentId as string,
            candidateId: `cand-${(checkpoint.sourceDeploymentId as string).slice(0, 8)}`,
            signal: args.signal,
          };
          const stopped = await driver.stopCurrentLiveRuntime(rollbackArgs);
          const restored = await driver.restoreBackup({ ...rollbackArgs, backupId });
          const started = restored.ok
            ? await driver.startPreviousVersion({
                ...rollbackArgs,
                previousLiveVersion: checkpoint.currentImage as string,
              })
            : restored;
          const healthy = started.ok
            ? await driver.runHealthCheck({ ...rollbackArgs, runtime: 'live' })
            : started;
          recovery = stopped.ok && restored.ok && started.ok && healthy.ok
            ? { ok: true }
            : {
                ok: false,
                code: 'ROLLBACK_RESTART_RECOVERY_FAILED',
                error: `stop=${stopped.code}; restore=${restored.code}; start=${started.code}; health=${healthy.code}`,
              };
        } else {
          recovery = requiresRestore
            ? await driver.recoverCurrentLiveBackup({ ...args, backupId })
            : await driver.resumeCurrentLiveRuntime(args);
        }
      } catch (e) {
        recovery = { ok: false, code: 'RECOVERY_EXCEPTION', error: (e as Error)?.message ?? String(e) };
      }
    }
    const detail = recovery.ok
      ? 'live recovery succeeded; retry with a new idempotency key after inspection'
      : `live recovery failed (${recovery.code ?? 'UNKNOWN'}): ${recovery.error ?? 'unknown error'}`;
    completeOperation(db, operation.id, 503, err(
      'OPERATION_INTERRUPTED',
      sanitizeOperationDiagnostic(`Administrative operation was interrupted by a Studio restart; ${detail}`, dataDir),
    ));
  }
  return running.length;
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function rowToRun(r: Record<string, any>): Run {
  let stats: RunStats | null = null;
  try {
    stats = r.stats_json ? (JSON.parse(r.stats_json) as RunStats) : null;
  } catch {
    stats = null;
  }
  return {
    id: r.id,
    projectId: r.project_id,
    prompt: r.prompt,
    status: r.status,
    createdAt: r.created_at,
    startedAt: r.started_at ?? null,
    finishedAt: r.finished_at ?? null,
    stats,
    error: r.error ?? null,
  };
}

function rowToMessage(r: Record<string, any>): ChatMessage {
  return { id: r.id, projectId: r.project_id, role: r.role, content: r.content, createdAt: r.created_at, tokens: r.tokens ?? null };
}

function rowToBuild(r: Record<string, any>): BuildRecord {
  let artifacts: { distSize: number } | null = null;
  try {
    artifacts = r.artifacts_json ? (JSON.parse(r.artifacts_json) as { distSize: number }) : null;
  } catch {
    artifacts = null;
  }
  return {
    id: r.id,
    projectId: r.project_id,
    status: r.status,
    startedAt: r.started_at,
    finishedAt: r.finished_at ?? null,
    durationMs: r.duration_ms ?? null,
    logs: r.logs ?? '',
    artifacts,
    error: r.error ?? null,
  };
}

function rowToRevision(r: Record<string, any>): RevisionInfo {
  return { id: r.id, projectId: r.project_id, label: r.label, gitSha: r.git_sha, createdAt: r.created_at };
}

function rowToMigration(r: Record<string, any>): MigrationRecord {
  return {
    id: r.id,
    projectId: r.project_id,
    version: Number(r.version),
    name: r.name,
    status: r.status,
    startedAt: r.started_at,
    finishedAt: r.finished_at ?? null,
    durationMs: r.duration_ms ?? null,
    logs: r.logs ?? '',
    error: r.error ?? null,
  };
}

const MANAGED_MIGRATION_FILE_RE = /^(\d{3,})_[A-Za-z0-9][A-Za-z0-9._-]*\.sql$/;

function managedMigrationFiles(root: string): Array<{ version: number; name: string }> {
  const dir = path.join(root, 'migrations');
  const files = fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && MANAGED_MIGRATION_FILE_RE.test(entry.name))
    .map((entry) => {
      const match = MANAGED_MIGRATION_FILE_RE.exec(entry.name)!;
      return { version: Number(match[1]), name: entry.name };
    })
    .sort((a, b) => a.version - b.version || a.name.localeCompare(b.name));
  const seen = new Set<number>();
  for (const file of files) {
    if (!Number.isSafeInteger(file.version) || seen.has(file.version)) {
      throw new Error(`duplicate or invalid migration version: ${file.name}`);
    }
    seen.add(file.version);
  }
  return files;
}

function insertManagedMigrationRows(
  db: Database.Database,
  projectId: string,
  files: Array<{ version: number; name: string }>,
): string[] {
  const startedAt = nowIso();
  const insert = db.prepare(
    `INSERT INTO migrations(id,project_id,version,name,status,started_at,finished_at,duration_ms,logs,error)
     VALUES (?,?,?,?,'running',?,NULL,NULL,'',NULL)`,
  );
  const ids = files.map(() => randomUUID());
  db.transaction(() => files.forEach((file, index) => {
    insert.run(ids[index], projectId, file.version, file.name, startedAt);
  }))();
  return ids;
}

function finishManagedMigrationRows(
  db: Database.Database,
  ids: string[],
  input: { status: 'success' | 'failed'; startedMs: number; logs: string; error: string | null },
): MigrationRecord[] {
  const finishedAt = nowIso();
  const durationMs = Math.max(0, Date.now() - input.startedMs);
  const update = db.prepare(
    `UPDATE migrations SET status=?,finished_at=?,duration_ms=?,logs=?,error=?
     WHERE id=? AND status='running'`,
  );
  const read = db.prepare('SELECT * FROM migrations WHERE id=?');
  return db.transaction(() => {
    for (const id of ids) update.run(input.status, finishedAt, durationMs, input.logs, input.error, id);
    return ids.map((id) => rowToMigration(read.get(id) as Record<string, unknown>));
  })();
}

// ---------------------------------------------------------------------------
// Fase 6 — deploy pipeline (CONTRACT.md §9.21)
// ---------------------------------------------------------------------------

/** Las respuestas nunca exponen rutas internas, secretos ni comandos. */
function toDeploymentInfo(r: DeploymentRecord): DeploymentInfo {
  return {
    id: r.id,
    projectId: r.projectId,
    target: r.target,
    status: r.status,
    url: r.url,
    createdAt: r.createdAt,
    logs: r.logs,
    candidateId: r.candidateId,
    previousLiveVersion: r.previousLiveVersion,
    backupId: r.backupId,
    cancelRequested: r.cancelRequested,
    startedAt: r.startedAt,
    updatedAt: r.updatedAt,
    finishedAt: r.finishedAt,
    error: r.error,
  };
}

function toProjectRuntime(r: { projectId: string; containerName: string; liveImage: string; previousImage: string | null; status: string; updatedAt: string }): ProjectRuntime {
  return {
    projectId: r.projectId,
    containerName: r.containerName,
    liveImage: r.liveImage,
    previousImage: r.previousImage,
    status: r.status as ProjectRuntime['status'],
    updatedAt: r.updatedAt,
  };
}

const DeployCreate = z.object({ target: z.string().min(1).max(40) });

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const ProjectCreate = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional().default(''),
  type: z.enum(['static', 'dynamic']).optional(),
  prompt: z.string().max(20_000).optional(),
});
const ProjectPatch = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
  status: z.string().max(40).optional(),
  model: z.string().max(120).nullable().optional(),
  previewUrl: z.string().max(500).nullable().optional(),
  productionUrl: z.string().max(500).nullable().optional(),
  config: z.record(z.unknown()).optional(),
});
const MessageCreate = z.object({ role: z.enum(['user', 'assistant', 'system']), content: z.string().min(1).max(200_000) });
const RunCreate = z.object({
  prompt: z.string().min(1).max(20_000),
  language: z.enum(['es', 'en']).optional(),
});
const FileWrite = z.object({ path: z.string().min(1).max(500), content: z.string().max(5_000_000) });
const ContentQuery = z.object({ path: z.string().min(1).max(500) });
const RevisionCreate = z.object({ label: z.string().max(200).optional() });
const ProjectsQuery = z.object({
  search: z.string().max(200).optional(),
  type: z.enum(['static', 'dynamic']).optional(),
  status: z.string().max(40).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(24),
});
const SettingsPatch = z.object({
  provider: z.enum(['groq', 'openrouter']).optional(),
  model: z.string().max(200).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(128_000).optional(),
  maxIterations: z.number().int().min(1).max(32).optional(),
  maxHardIterations: z.number().int().min(8).max(500).optional(),
  maxRepairAttempts: z.number().int().min(1).max(50).optional(),
  llmTimeoutMs: z.number().int().min(1_000).max(600_000).optional(),
  cmdTimeoutMs: z.number().int().min(1_000).max(600_000).optional(),
  runTimeoutMs: z.number().int().min(60_000).max(3_600_000).optional(),
  language: z.enum(['es', 'en']).optional(),
  theme: z.enum(['dark', 'light']).optional(),
  autoRevision: z.boolean().optional(),
  autoBuild: z.boolean().optional(),
  secrets: z
    .object({
      groqKey: z.string().max(500).optional(),
      openrouterKey: z.string().max(500).optional(),
      vercelToken: z.string().max(500).optional(),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export interface ServerOptions {
  db: Database.Database;
  dataDir: string;
  templatesDir: string;
  adminToken?: string;
  corsOrigin?: string;
  /** apps/studio/dist — served at / when it exists (single-server mode) */
  studioDistDir?: string;
  /**
   * Fase 6: driver de despliegue configurado explícitamente. Sin él, el
   * endpoint de deploy responde 501 DEPLOYMENT_DRIVER_NOT_CONFIGURED y no
   * se simula ningún despliegue real. El fake solo se inyecta en tests.
   */
  deploymentDriver?: DeploymentDriver;
  /**
   * 7B: resolución interna del runtime live. Producción usa el nombre Docker
   * derivado y puerto fijo; los tests pueden inyectar loopback. Nunca procede
   * de parámetros HTTP ni de datos libres del usuario.
   */
  liveRuntimeOrigin?: (runtime: ProjectRuntime) => string | null;
  /** 7C: process-owned background operations included in graceful shutdown. */
  backgroundTasks?: BackgroundTaskTracker;
}

export interface BackgroundTaskTracker {
  track: <T>(task: Promise<T>) => Promise<T>;
  drain: (timeoutMs: number) => Promise<boolean>;
  size: () => number;
}

export function createBackgroundTaskTracker(): BackgroundTaskTracker {
  const tasks = new Set<Promise<unknown>>();
  return {
    track: <T>(task: Promise<T>): Promise<T> => {
      const tracked = task.finally(() => tasks.delete(tracked));
      tasks.add(tracked);
      return tracked;
    },
    drain: (timeoutMs) => waitForTaskSet(tasks, timeoutMs),
    size: () => tasks.size,
  };
}

const err = (code: string, message: string): ApiError => ({ error: { code, message } });

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

/** Serve a static file over a hijacked reply (headers must precede writeHead). */
function sendFile(abs: string, raw: import('node:http').ServerResponse): void {
  const stream = fs.createReadStream(abs);
  // Public build artifacts: the Workspace preview embeds projects in a
  // sandboxed iframe (opaque origin), so module scripts, stylesheets and
  // fonts are CORS fetches and need an explicit allowlist.
  raw.writeHead(200, {
    'Content-Type': MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream',
    'Access-Control-Allow-Origin': '*',
  });
  stream.on('error', () => {
    try { raw.end(); } catch { /* ignore */ }
  });
  stream.pipe(raw);
}

function diagnosticHtml(projectId: string, projectName: string): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sin preview — ${projectName}</title>
<style>body{background:#0b0f14;color:#e6edf3;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{max-width:520px;padding:32px;border:1px solid #1f2937;border-radius:12px;background:#111827;text-align:center}
h1{font-size:20px;margin:0 0 8px}p{color:#9ca3af;font-size:14px}
button{background:#06b6d4;border:0;color:#04222b;font-weight:700;padding:10px 18px;border-radius:8px;cursor:pointer;margin:6px}
a{color:#06b6d4;font-size:14px}#msg{font-size:13px;color:#9ca3af;margin-top:10px;min-height:18px}</style></head><body>
<div class="card"><h1>No hay preview disponible</h1>
<p>El proyecto <b>${projectName}</b> aún no tiene un build de producción (<code>frontend/dist</code>).</p>
<button onclick="rebuild()">Rebuild</button>
<a href="/api/projects/${projectId}/builds">Ver logs de builds</a>
<div id="msg"></div></div>
<script>async function rebuild(){const t=localStorage.getItem('appforge_token');const msg=document.getElementById('msg');
msg.textContent='Lanzando build…';
try{const r=await fetch('/api/projects/${projectId}/builds',{method:'POST',headers:t?{Authorization:'Bearer '+t}:{}});
msg.textContent='Build: '+r.status+(r.ok?' — recargando en 20 s…':'');
if(r.ok)setTimeout(()=>location.reload(),20000);}catch(e){msg.textContent='Error: '+e;}}</script>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

function dynamicPreviewDiagnosticHtml(projectId: string, projectName: string, status: string): string {
  const safeId = escapeHtml(projectId);
  const safeName = escapeHtml(projectName);
  const safeStatus = escapeHtml(status);
  const reason =
    status === 'unreachable'
      ? 'The preview process is not responding. It may have crashed; start a new one with the <code>start_fullstack_preview</code> agent tool.'
      : 'This dynamic project has no active full-stack preview. Launch one with the <code>start_fullstack_preview</code> agent tool (requires the four verification checks in order).';
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sin preview dinámico — ${safeName}</title>
<style>body{background:#0b0f14;color:#e6edf3;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{max-width:560px;padding:32px;border:1px solid #1f2937;border-radius:12px;background:#111827;text-align:center}
h1{font-size:20px;margin:0 0 8px}p{color:#9ca3af;font-size:14px}code{color:#06b6d4}</style></head><body>
<div class="card"><h1>Preview dinámico no disponible</h1>
<p>El proyecto <b>${safeName}</b> (${safeId}) no tiene un preview full-stack activo${status !== 'none' ? ` (estado: ${safeStatus})` : ''}.</p>
<p>${reason}</p></div></body></html>`;
}

export function buildServer(opts: ServerOptions): FastifyInstance {
  const { db, dataDir, templatesDir, adminToken } = opts;
  const app = Fastify({ logger: false });
  const thumbnailJobs = new Map<string, ReturnType<typeof checkBrowser>>();
  void app.register(cors, { origin: opts.corsOrigin ?? '*' });

  // --- rate limit: 120 req/min/IP on /api ---
  const hits = new Map<string, number[]>();
  app.addHook('onRequest', async (req, reply) => {
    const url = req.raw.url ?? '';
    const isApi = url === '/api' || url.startsWith('/api/');
    if (isApi) {
      const now = Date.now();
      const arr = (hits.get(req.ip) ?? []).filter((t) => now - t < 60_000);
      arr.push(now);
      hits.set(req.ip, arr);
      if (arr.length > 120) {
        reply.code(429).send(err('RATE_LIMITED', 'Too many requests (120/min)'));
        return;
      }
    }
    // Generated apps under /p are intentionally public deployments. Only the
    // administrative API requires the bearer token.
    if (adminToken && isApi) {
      const h = req.headers.authorization ?? '';
      const bearer = h.startsWith('Bearer ') ? h.slice(7) : null;
      const qToken = (req.query as Record<string, unknown> | undefined)?.token;
      const token = bearer ?? (typeof qToken === 'string' ? qToken : null);
      if (token !== adminToken) {
        reply.code(401).send(err('UNAUTHORIZED', 'Missing or invalid admin token'));
        return;
      }
    }
  });

  app.setErrorHandler((e, _req, reply) => {
    if (e instanceof z.ZodError) {
      reply.code(400).send(err('VALIDATION_ERROR', e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')));
      return;
    }
    const status = typeof (e as { statusCode?: unknown }).statusCode === 'number' ? ((e as { statusCode: number }).statusCode as number) : 500;
    if (status >= 500) console.error('[api]', e);
    reply.code(status >= 500 ? 500 : status).send(err(status >= 500 ? 'INTERNAL' : 'REQUEST_ERROR', status >= 500 ? 'Internal server error' : (e as Error).message));
  });

  const needProject = (id: string): Project => {
    const p = getProject(db, id);
    if (!p) {
      const e = new Error('project not found') as Error & { statusCode: number; code: string };
      e.statusCode = 404;
      e.code = 'PROJECT_NOT_FOUND';
      throw e;
    }
    return p;
  };

  // ------------------------------------------------------------------ system
  app.get('/healthz', async () => ({ ok: true, version: VERSION }));
  app.get('/api/health', async () => ({ ok: true, version: VERSION }));

  // ---------------------------------------------------------------- projects
  app.get('/api/projects', async (req) => {
    const q = ProjectsQuery.parse(req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.search) { where.push('(name LIKE ? OR description LIKE ?)'); params.push(`%${q.search}%`, `%${q.search}%`); }
    if (q.type) { where.push('type=?'); params.push(q.type); }
    if (q.status) { where.push('status=?'); params.push(q.status); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (db.prepare(`SELECT COUNT(*) AS c FROM projects ${w}`).get(...params) as { c: number }).c;
    const rows = db.prepare(`SELECT * FROM projects ${w} ORDER BY updated_at DESC LIMIT ? OFFSET ?`).all(...params, q.pageSize, (q.page - 1) * q.pageSize) as Record<string, any>[];
    return { items: rows.map(rowToProject), total };
  });

  app.post('/api/projects', async (req, reply) => {
    const body = ProjectCreate.parse(req.body);
    const p = createProject(db, dataDir, templatesDir, body);
    reply.code(201);
    return p;
  });

  app.get('/api/projects/:id', async (req) => {
    const { id } = req.params as { id: string };
    return needProject(id);
  });

  app.patch('/api/projects/:id', async (req) => {
    const { id } = req.params as { id: string };
    needProject(id);
    const body = ProjectPatch.parse(req.body);
    const sets: string[] = [];
    const params: unknown[] = [];
    const map: Record<string, string> = { name: 'name', description: 'description', status: 'status', model: 'model', previewUrl: 'preview_url', productionUrl: 'production_url' };
    for (const [k, col] of Object.entries(map)) {
      if ((body as Record<string, unknown>)[k] !== undefined) { sets.push(`${col}=?`); params.push((body as Record<string, unknown>)[k]); }
    }
    if (body.config !== undefined) { sets.push('config_json=?'); params.push(JSON.stringify(body.config)); }
    if (sets.length > 0) {
      sets.push('updated_at=?');
      params.push(nowIso(), id);
      db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id=?`).run(...params);
    }
    return getProject(db, id)!;
  });

  app.delete('/api/projects/:id', async (req) => {
    const { id } = req.params as { id: string };
    if (!deleteProject(db, dataDir, id)) {
      const e = new Error('project not found') as Error & { statusCode: number };
      e.statusCode = 404;
      throw e;
    }
    return { ok: true };
  });

  // ------------------------------------------------------------------- chat
  app.get('/api/projects/:id/messages', async (req) => {
    const { id } = req.params as { id: string };
    needProject(id);
    const rows = db.prepare('SELECT * FROM messages WHERE project_id=? ORDER BY created_at ASC').all(id) as Record<string, any>[];
    return { items: rows.map(rowToMessage) };
  });

  app.post('/api/projects/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string };
    needProject(id);
    const body = MessageCreate.parse(req.body);
    const m: ChatMessage = { id: randomUUID(), projectId: id, role: body.role, content: body.content, createdAt: nowIso(), tokens: null };
    db.prepare('INSERT INTO messages(id, project_id, role, content, created_at, tokens) VALUES (?,?,?,?,?,?)').run(m.id, m.projectId, m.role, m.content, m.createdAt, null);
    reply.code(201);
    return m;
  });

  // ------------------------------------------------------------------- runs
  app.post('/api/projects/:id/runs', async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = needProject(id);
    const body = RunCreate.parse(req.body);
    const active = db.prepare("SELECT id FROM runs WHERE project_id=? AND status IN ('queued','running') LIMIT 1").get(id);
    if (active) {
      reply.code(409);
      return err('RUN_ACTIVE', 'There is already an active run for this project');
    }
    const runId = randomUUID();
    const created = nowIso();
    const compatibility = assessTechnologyCompatibility(body.prompt, body.language ?? ensureSettingsRow(db).language);
    if (!compatibility.compatible) {
      const stats: RunStats = { iterations: 0, llmCalls: 0, llmMs: 0, buildMs: 0, tokensIn: 0, tokensOut: 0, toolCalls: 0, errors: 0 };
      db.transaction(() => {
        db.prepare('INSERT INTO runs(id, project_id, prompt, status, created_at, started_at, finished_at, stats_json, error) VALUES (?,?,?,?,?,?,?,?,?)').run(
          runId, id, body.prompt, 'done', created, created, created, JSON.stringify(stats), null,
        );
        db.prepare('INSERT INTO messages(id, project_id, role, content, created_at, tokens) VALUES (?,?,?,?,?,?)').run(randomUUID(), id, 'user', body.prompt, created, null);
        db.prepare('INSERT INTO messages(id, project_id, role, content, created_at, tokens) VALUES (?,?,?,?,?,?)').run(randomUUID(), id, 'assistant', compatibility.message, created, 0);
        db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(created, id);
      })();
      const row = db.prepare('SELECT * FROM runs WHERE id=?').get(runId) as Record<string, any>;
      reply.code(201);
      return rowToRun(row);
    }
    if (project.type === 'static' && inferProjectType(body.prompt) === 'dynamic') {
      reply.code(409);
      return err('PROJECT_TYPE_MISMATCH', body.language === 'en'
        ? 'This request needs a backend. Create a Dynamic project (or use Automatic project type) before starting generation.'
        : 'Esta solicitud necesita backend. Crea un proyecto Dinámico (o selecciona tipo Automático) antes de iniciar la generación.');
    }
    db.prepare('INSERT INTO runs(id, project_id, prompt, status, created_at, started_at, finished_at, stats_json, error) VALUES (?,?,?,?,?,?,?,?,?)').run(
      runId, id, body.prompt, 'queued', created, null, null, null, null,
    );
    db.prepare('INSERT INTO messages(id, project_id, role, content, created_at, tokens) VALUES (?,?,?,?,?,?)').run(randomUUID(), id, 'user', body.prompt, created, null);
    const row = db.prepare('SELECT * FROM runs WHERE id=?').get(runId) as Record<string, any>;
    reply.code(201);
    return rowToRun(row);
  });

  app.get('/api/projects/:id/runs', async (req) => {
    const { id } = req.params as { id: string };
    needProject(id);
    const rows = db.prepare('SELECT * FROM runs WHERE project_id=? ORDER BY created_at DESC').all(id) as Record<string, any>[];
    return { items: rows.map(rowToRun) };
  });

  app.get('/api/runs/:runId', async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const row = db.prepare('SELECT * FROM runs WHERE id=?').get(runId) as Record<string, any> | undefined;
    if (!row) { reply.code(404); return err('RUN_NOT_FOUND', 'run not found'); }
    return rowToRun(row);
  });

  app.post('/api/runs/:runId/cancel', async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const row = db.prepare('SELECT status FROM runs WHERE id=?').get(runId) as { status: string } | undefined;
    if (!row) { reply.code(404); return err('RUN_NOT_FOUND', 'run not found'); }
    if (row.status === 'queued' || row.status === 'running') {
      db.prepare("UPDATE runs SET status='cancelled', finished_at=? WHERE id=?").run(nowIso(), runId);
      requestCancel(runId);
    }
    return { ok: true };
  });

  // SSE: replay ordered by seq, then live poll; :ping every 15s; close on done|error.
  app.get('/api/runs/:runId/events', async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const run = db.prepare('SELECT id FROM runs WHERE id=?').get(runId);
    if (!run) { reply.code(404); return err('RUN_NOT_FOUND', 'run not found'); }
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': opts.corsOrigin ?? '*',
    });
    let lastSeq = 0;
    let closed = false;
    let poll: ReturnType<typeof setInterval> | undefined;
    let ping: ReturnType<typeof setInterval> | undefined;
    const send = (seq: number, kind: string, payload: string) => {
      if (!closed) reply.raw.write(`id: ${seq}\nevent: ${kind}\ndata: ${payload}\n\n`);
    };
    const close = () => {
      if (closed) return;
      closed = true;
      if (poll) clearInterval(poll);
      if (ping) clearInterval(ping);
      try { reply.raw.end(); } catch { /* already closed */ }
    };
    let terminal = false;
    const drain = () => {
      const rows = db.prepare('SELECT seq, kind, payload_json AS payload FROM run_events WHERE run_id=? AND seq>? ORDER BY seq').all(runId, lastSeq) as Array<{ seq: number; kind: string; payload: string }>;
      for (const r of rows) {
        send(r.seq, r.kind, r.payload);
        lastSeq = r.seq;
        if (r.kind === 'done' || r.kind === 'error') terminal = true;
      }
      if (terminal) close();
    };
    drain();
    if (terminal) return;
    poll = setInterval(() => { try { drain(); } catch { /* db closed */ } }, 500);
    ping = setInterval(() => { if (!closed) reply.raw.write(':ping\n\n'); }, 15_000);
    req.raw.on('close', close);
  });

  // ------------------------------------------------------------------- files
  app.get('/api/projects/:id/files', async (req) => {
    const { id } = req.params as { id: string };
    needProject(id);
    const fdir = frontendDir(dataDir, id);
    if (!fs.existsSync(fdir)) return { tree: [] };
    return { tree: buildFileTree(fdir) };
  });

  app.get('/api/projects/:id/files/content', async (req, reply) => {
    const { id } = req.params as { id: string };
    needProject(id);
    const q = ContentQuery.parse(req.query);
    let abs: string;
    try {
      abs = resolveIn(frontendDir(dataDir, id), q.path);
    } catch (e) {
      reply.code(400);
      return err('INVALID_PATH', (e as Error).message);
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) { reply.code(404); return err('FILE_NOT_FOUND', 'file not found'); }
    return { path: q.path, content: fs.readFileSync(abs, 'utf8') };
  });

  app.put('/api/projects/:id/files/content', async (req, reply) => {
    const { id } = req.params as { id: string };
    needProject(id);
    const body = FileWrite.parse(req.body);
    let abs: string;
    try {
      abs = resolveIn(frontendDir(dataDir, id), body.path);
    } catch (e) {
      reply.code(400);
      return err('INVALID_PATH', (e as Error).message);
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body.content, 'utf8');
    db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(nowIso(), id);
    return { ok: true };
  });

  // ------------------------------------------------------------------ builds
  app.post('/api/projects/:id/builds', async (req, reply) => {
    const { id } = req.params as { id: string };
    needProject(id);
    const active = db.prepare("SELECT id FROM builds WHERE project_id=? AND status IN ('pending','running') LIMIT 1").get(id);
    if (active) {
      reply.code(409);
      return err('BUILD_ACTIVE', 'There is already a build in progress for this project');
    }
    const buildId = randomUUID();
    db.prepare('INSERT INTO builds(id, project_id, status, started_at, finished_at, duration_ms, logs, artifacts_json, error) VALUES (?,?,?,?,?,?,?,?,?)').run(
      buildId, id, 'pending', nowIso(), null, null, '', null, null,
    );
    const buildTask = executeBuild(db, dataDir, buildId);
    void (opts.backgroundTasks ? opts.backgroundTasks.track(buildTask) : buildTask);
    const row = db.prepare('SELECT * FROM builds WHERE id=?').get(buildId) as Record<string, any>;
    reply.code(201);
    return rowToBuild(row);
  });

  app.get('/api/projects/:id/builds', async (req) => {
    const { id } = req.params as { id: string };
    needProject(id);
    const rows = db.prepare('SELECT * FROM builds WHERE project_id=? ORDER BY started_at DESC').all(id) as Record<string, any>[];
    return { items: rows.map(rowToBuild) };
  });

  app.get('/api/builds/:buildId', async (req, reply) => {
    const { buildId } = req.params as { buildId: string };
    const row = db.prepare('SELECT * FROM builds WHERE id=?').get(buildId) as Record<string, any> | undefined;
    if (!row) { reply.code(404); return err('BUILD_NOT_FOUND', 'build not found'); }
    return rowToBuild(row);
  });

  // ----------------------------------------------------------------- archive
  app.get('/api/projects/:id/archive', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = needProject(id);
    const dir = projectDir(dataDir, id);
    reply.hijack();
    const slug = p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
    reply.raw.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${slug}.zip"`,
    });
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (e: Error) => { try { reply.raw.destroy(e); } catch { /* ignore */ } });
    archive.pipe(reply.raw);
    archive.glob('**', {
      cwd: dir,
      dot: true,
      ignore: ['node_modules/**', 'dist/**', '.git/**', '*.db', '*.log', 'frontend/node_modules/**', 'frontend/dist/**', '**/*.db-*'],
    });
    await archive.finalize();
  });

  // --------------------------------------------------------------- revisions
  app.get('/api/projects/:id/revisions', async (req) => {
    const { id } = req.params as { id: string };
    needProject(id);
    const rows = db.prepare('SELECT * FROM revisions WHERE project_id=? ORDER BY created_at DESC').all(id) as Record<string, any>[];
    return { items: rows.map(rowToRevision) };
  });

  app.post('/api/projects/:id/revisions', async (req, reply) => {
    const { id } = req.params as { id: string };
    needProject(id);
    const body = RevisionCreate.parse(req.body);
    const dir = projectDir(dataDir, id);
    const label = body.label?.trim() || 'checkpoint';
    const add = await runCmd('git', ['add', '-A'], { cwd: dir, timeoutMs: 30_000 });
    if (add.code !== 0) { reply.code(500); return err('GIT_ERROR', `git add failed: ${(add.stdout + add.stderr).slice(0, 500)}`); }
    const status = await runCmd('git', ['status', '--porcelain'], { cwd: dir, timeoutMs: 30_000 });
    if (status.code !== 0) { reply.code(500); return err('GIT_ERROR', 'git status failed'); }
    if (status.stdout.trim().length > 0) {
      const commit = await runCmd('git', ['-c', 'user.name=AppForge', '-c', 'user.email=appforge@local', 'commit', '-m', label], { cwd: dir, timeoutMs: 30_000 });
      if (commit.code !== 0) { reply.code(500); return err('GIT_ERROR', `git commit failed: ${(commit.stdout + commit.stderr).slice(0, 500)}`); }
    }
    const rev = await runCmd('git', ['rev-parse', 'HEAD'], { cwd: dir, timeoutMs: 30_000 });
    if (rev.code !== 0) { reply.code(500); return err('GIT_ERROR', 'git rev-parse failed (no commits?)'); }
    const sha = rev.stdout.trim();
    const revId = randomUUID();
    db.prepare('INSERT INTO revisions(id, project_id, label, git_sha, created_at) VALUES (?,?,?,?,?)').run(revId, id, label, sha, nowIso());
    const row = db.prepare('SELECT * FROM revisions WHERE id=?').get(revId) as Record<string, any>;
    reply.code(201);
    return rowToRevision(row);
  });

  app.post('/api/projects/:id/revisions/:rid/restore', async (req, reply) => {
    const { id, rid } = req.params as { id: string; rid: string };
    needProject(id);
    const row = db.prepare('SELECT * FROM revisions WHERE id=? AND project_id=?').get(rid, id) as Record<string, any> | undefined;
    if (!row) { reply.code(404); return err('REVISION_NOT_FOUND', 'revision not found'); }
    const dir = projectDir(dataDir, id);
    const reset = await runCmd('git', ['reset', '--hard', row.git_sha], { cwd: dir, timeoutMs: 60_000 });
    if (reset.code !== 0) { reply.code(500); return err('GIT_ERROR', `git reset failed: ${(reset.stdout + reset.stderr).slice(0, 500)}`); }
    db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(nowIso(), id);
    return { ok: true };
  });

  // ----------------------------------------------------------------- deploy
  // Pipeline persistente (CONTRACT.md §9.21–9.23). Sin driver real listo:
  // 501 estable, sin simular despliegues. El fake solo se inyecta vía
  // ServerOptions en tests; nunca por defecto en producción.
  const deployDriver = opts.deploymentDriver;

  app.get('/api/deployment-driver', async () => {
    if (!deployDriver) return { configured: false, name: null, active: 0, limit: null, available: null };
    const active = activeDeploymentCapacity(deployDriver);
    const limit = deployDriver.maxConcurrentDeploys ?? null;
    return {
      configured: true,
      name: deployDriver.name,
      active,
      limit,
      available: limit === null ? null : Math.max(0, limit - active),
    };
  });

  app.post('/api/projects/:id/deploy', async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = needProject(id);
    if (project.type !== 'dynamic') {
      reply.code(400);
      return err('INVALID_TYPE', 'This deployment pipeline only supports dynamic projects');
    }
    const body = DeployCreate.parse(req.body);
    if (body.target !== 'oracle') {
      reply.code(400);
      return err('INVALID_TARGET', `Unsupported deploy target '${body.target}' (only 'oracle' is supported)`);
    }
    if (!deployDriver) {
      reply.code(501);
      return err('DEPLOYMENT_DRIVER_NOT_CONFIGURED', 'Deployment infrastructure is not configured');
    }
    let auditReservation: ReturnType<typeof reserveOperation> | null = null;
    if (adminToken) {
      const rawKey = req.headers['idempotency-key'];
      const idempotencyKey = Array.isArray(rawKey) ? '' : (rawKey ?? '');
      try {
        auditReservation = reserveOperation(db, {
          idempotencyKey,
          actor: 'admin',
          operation: 'deploy',
          projectId: id,
          payload: body,
        });
      } catch (e) {
        if (e instanceof OperationAuditError && e.code === 'INVALID_IDEMPOTENCY_KEY') {
          reply.code(400);
          return err(e.code, e.message);
        }
        throw e;
      }
      if (auditReservation.kind === 'conflict') {
        reply.code(409);
        return err('IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used for a different request');
      }
      if (auditReservation.kind === 'in_progress') {
        reply.code(409);
        return err('OPERATION_IN_PROGRESS', 'The idempotent deploy request is still being accepted');
      }
      if (auditReservation.kind === 'replay') {
        reply.header('Idempotency-Replayed', 'true').code(auditReservation.responseStatus);
        return auditReservation.response;
      }
    }
    const finishAudit = (status: number, response: unknown): unknown => {
      if (auditReservation?.kind === 'started') completeOperation(db, auditReservation.record.id, status, response);
      reply.code(status);
      return response;
    };
    // Puerta de verificación autoritativa (revisión Codex): los seis
    // receipts persistidos deben estar vigentes sobre las fuentes actuales
    // y en orden canónico. Síncrona para responder 409 antes de crear nada.
    const gate = persistedDynamicGateStatus(db, projectDir(dataDir, id), id);
    if (!gate.ok) {
      return finishAudit(409, err('VERIFICATION_GATE', gate.reason ?? '5A/5B verification checks are not current'));
    }
    // Preserve the public Fase 6 error code when the conflicting operation is
    // specifically another deployment; the cross-operation lock below covers
    // backup/migrations/rollback races.
    if (getActiveDeployment(db, id)) {
      return finishAudit(409, err('DEPLOYMENT_ACTIVE', 'There is already a deployment in progress for this project'));
    }
    const projectLockId = auditReservation?.kind === 'started' ? auditReservation.record.id : `deploy-${randomUUID()}`;
    if (!acquireProjectOperationLock(db, { projectId: id, operationId: projectLockId, operation: 'deploy' })) {
      return finishAudit(409, err('PROJECT_OPERATION_ACTIVE', 'Another mutating operation is already active for this project'));
    }
    const releaseCapacity = acquireDeploymentCapacity(deployDriver);
    if (!releaseCapacity) {
      releaseProjectOperationLock(db, projectLockId);
      return finishAudit(409, err('DEPLOYMENT_CAPACITY', 'Deployment capacity is currently exhausted'));
    }
    let dep: DeploymentRecord;
    try {
      dep = createDeployment(db, { projectId: id, target: body.target });
    } catch (e) {
      releaseCapacity();
      releaseProjectOperationLock(db, projectLockId);
      if (e instanceof DeploymentError) {
        return finishAudit(e.statusCode, err(e.code, e.message));
      }
      throw e;
    }
    const accepted = toDeploymentInfo(dep);
    if (auditReservation?.kind === 'started') {
      checkpointOperation(db, auditReservation.record.id, { phase: 'accepted', deploymentId: dep.id });
      completeOperation(db, auditReservation.record.id, 202, accepted);
    }
    // 202: el pipeline corre en segundo plano y persiste estados terminales
    // internamente (nunca rechaza por fallos del despliegue).
    const deploymentTask = runDeploymentPipeline(db, deployDriver, {
      projectId: id,
      target: body.target,
      deploymentId: dep.id,
      verificationGate: () => persistedDynamicGateStatus(db, projectDir(dataDir, id), id),
    })
      .catch((e) => console.error('[deploy] pipeline crashed:', (e as Error).message))
      .finally(() => {
        releaseCapacity();
        releaseProjectOperationLock(db, projectLockId);
      });
    void (opts.backgroundTasks ? opts.backgroundTasks.track(deploymentTask) : deploymentTask);
    reply.code(202);
    return accepted;
  });

  app.get('/api/projects/:id/deployments', async (req) => {
    const { id } = req.params as { id: string };
    needProject(id);
    return { items: listDeploymentRecords(db, id).map(toDeploymentInfo) };
  });

  app.get('/api/deployments/:deploymentId', async (req, reply) => {
    const { deploymentId } = req.params as { deploymentId: string };
    const dep = getDeploymentRecord(db, deploymentId);
    if (!dep) {
      reply.code(404);
      return err('DEPLOYMENT_NOT_FOUND', 'deployment not found');
    }
    return toDeploymentInfo(dep);
  });

  app.post('/api/deployments/:deploymentId/cancel', async (req, reply) => {
    const { deploymentId } = req.params as { deploymentId: string };
    const current = getDeploymentRecord(db, deploymentId);
    if (!current) {
      reply.code(404);
      return err('DEPLOYMENT_NOT_FOUND', 'deployment not found');
    }
    let auditReservation: ReturnType<typeof reserveOperation> | null = null;
    if (adminToken) {
      const rawKey = req.headers['idempotency-key'];
      const idempotencyKey = Array.isArray(rawKey) ? '' : (rawKey ?? '');
      try {
        auditReservation = reserveOperation(db, {
          idempotencyKey,
          actor: 'admin',
          operation: 'deployment_cancel',
          projectId: current.projectId,
          payload: { deploymentId },
        });
      } catch (e) {
        if (e instanceof OperationAuditError && e.code === 'INVALID_IDEMPOTENCY_KEY') {
          reply.code(400);
          return err(e.code, e.message);
        }
        throw e;
      }
      if (auditReservation.kind === 'conflict') {
        reply.code(409);
        return err('IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used for a different request');
      }
      if (auditReservation.kind === 'in_progress') {
        reply.code(409);
        return err('OPERATION_IN_PROGRESS', 'The idempotent cancellation request is still running');
      }
      if (auditReservation.kind === 'replay') {
        reply.header('Idempotency-Replayed', 'true').code(auditReservation.responseStatus);
        return auditReservation.response;
      }
      checkpointOperation(db, auditReservation.record.id, { phase: 'cancel_requested', deploymentId });
    }
    const dep = requestDeploymentCancel(db, deploymentId)!;
    const response = toDeploymentInfo(dep);
    if (auditReservation?.kind === 'started') completeOperation(db, auditReservation.record.id, 200, response);
    return response;
  });

  // ----------------------------------------------------- managed operations
  app.post('/api/projects/:id/migrations', async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = needProject(id);
    if (project.type !== 'dynamic') {
      reply.code(400);
      return err('INVALID_TYPE', 'Live migrations are only available for dynamic projects');
    }
    if (!adminToken) {
      reply.code(503);
      return err('ADMIN_AUTH_NOT_CONFIGURED', 'Administrative authentication is not configured');
    }
    if (!deployDriver) {
      reply.code(501);
      return err('DEPLOYMENT_DRIVER_NOT_CONFIGURED', 'Deployment infrastructure is not configured');
    }
    const rawKey = req.headers['idempotency-key'];
    const idempotencyKey = Array.isArray(rawKey) ? '' : (rawKey ?? '');
    let reservation;
    try {
      reservation = reserveOperation(db, {
        idempotencyKey,
        actor: 'admin',
        operation: 'migrations',
        projectId: id,
        payload: {},
      });
    } catch (e) {
      if (e instanceof OperationAuditError && e.code === 'INVALID_IDEMPOTENCY_KEY') {
        reply.code(400);
        return err(e.code, e.message);
      }
      throw e;
    }
    if (reservation.kind === 'conflict') {
      reply.code(409);
      return err('IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used for a different request');
    }
    if (reservation.kind === 'in_progress') {
      reply.code(409);
      return err('OPERATION_IN_PROGRESS', 'The idempotent operation is still running');
    }
    if (reservation.kind === 'replay') {
      reply.header('Idempotency-Replayed', 'true').code(reservation.responseStatus);
      return reservation.response;
    }

    const finish = (status: number, body: unknown): unknown => {
      completeOperation(db, reservation.record.id, status, body);
      reply.code(status);
      return body;
    };
    const runtime = getProjectRuntimeRecord(db, id);
    if (!runtime || runtime.status !== 'running' || !APPFORGE_IMAGE_REF_RE.test(runtime.liveImage)) {
      return finish(409, err('RUNTIME_NOT_READY', 'Project has no verified running live runtime to migrate'));
    }
    if (getActiveDeployment(db, id)) {
      return finish(409, err('DEPLOYMENT_ACTIVE', 'A deployment is already active for this project'));
    }
    let files: Array<{ version: number; name: string }>;
    try {
      files = managedMigrationFiles(projectDir(dataDir, id));
    } catch (e) {
      return finish(400, err('INVALID_MIGRATIONS', sanitizeOperationDiagnostic((e as Error).message, dataDir)));
    }
    if (files.length === 0) return finish(409, err('NO_MIGRATIONS', 'Project contains no managed migration files'));
    if (!acquireProjectOperationLock(db, {
      projectId: id,
      operationId: reservation.record.id,
      operation: 'migrations',
    })) {
      return finish(409, err('PROJECT_OPERATION_ACTIVE', 'Another mutating operation is already active for this project'));
    }
    const releaseCapacity = acquireDeploymentCapacity(deployDriver);
    if (!releaseCapacity) {
      releaseProjectOperationLock(db, reservation.record.id);
      return finish(409, err('DEPLOYMENT_CAPACITY', 'Deployment capacity is currently exhausted'));
    }

    const startedMs = Date.now();
    const operationArgs = {
      projectId: id,
      deploymentId: reservation.record.id,
      candidateId: `cand-${reservation.record.id.slice(0, 8)}`,
    };
    let backupId: string | null = null;
    let rowIds: string[] = [];
    const recover = async (): Promise<ReturnType<typeof err> | null> => {
      if (!backupId) return null;
      const recovered = await deployDriver.recoverCurrentLiveBackup({
        ...operationArgs,
        backupId,
        signal: AbortSignal.timeout(5 * 60_000),
      });
      if (recovered.ok) return null;
      return err(
        'MIGRATION_RECOVERY_FAILED',
        sanitizeOperationDiagnostic(
          `${recovered.code ?? 'RECOVERY_FAILED'}: ${recovered.error ?? 'live recovery failed'}`,
          dataDir,
        ),
      );
    };

    try {
      const backup = await deployDriver.createLiveBackup({
        ...operationArgs,
        previousLiveVersion: runtime.liveImage,
        signal: AbortSignal.timeout(10 * 60_000),
      });
      const backupData = backup.data ?? {};
      const backupSize = Number(backupData.sizeBytes);
      const backupCreatedAt = backupData.createdAt ?? '';
      const validBackup =
        backup.ok &&
        isValidBackupId(backupData.backupId) &&
        backupData.backupValidated === 'true' &&
        backupData.hadDatabase === 'true' &&
        Number.isSafeInteger(backupSize) &&
        backupSize > 0 &&
        Number.isFinite(Date.parse(backupCreatedAt)) &&
        new Date(backupCreatedAt).toISOString() === backupCreatedAt;
      if (!validBackup) {
        const diagnostic = sanitizeOperationDiagnostic(
          backup.error ?? backup.code ?? 'driver returned invalid backup evidence',
          dataDir,
        );
        const resumed = await deployDriver.resumeCurrentLiveRuntime({
          ...operationArgs,
          signal: AbortSignal.timeout(120_000),
        });
        if (!resumed.ok) {
          return finish(502, err(
            'MIGRATION_BACKUP_RECOVERY_FAILED',
            sanitizeOperationDiagnostic(
              `${diagnostic}; live recovery failed (${resumed.code}): ${resumed.error}`,
              dataDir,
            ),
          ));
        }
        return finish(502, err('MIGRATION_BACKUP_FAILED', diagnostic));
      }
      backupId = backupData.backupId!;
      checkpointOperation(db, reservation.record.id, { phase: 'backup_ready', backupId });
      rowIds = insertManagedMigrationRows(db, id, files);
      const migrated = await deployDriver.runCurrentLiveMigrations({
        ...operationArgs,
        signal: AbortSignal.timeout(10 * 60_000),
      });
      const logs = migrated.output ? sanitizeOperationDiagnostic(migrated.output, dataDir) : '';
      if (!migrated.ok) {
        const diagnostic = sanitizeOperationDiagnostic(
          `${migrated.code ?? 'MIGRATION_FAILED'}: ${migrated.error ?? 'migration failed'}`,
          dataDir,
        );
        const recoveryError = await recover();
        const finalError = recoveryError?.error.message ?? diagnostic;
        finishManagedMigrationRows(db, rowIds, {
          status: 'failed', startedMs, logs, error: finalError,
        });
        return finish(502, recoveryError ?? err('MIGRATION_FAILED', diagnostic));
      }

      const resumed = await deployDriver.resumeCurrentLiveRuntime({
        ...operationArgs,
        signal: AbortSignal.timeout(120_000),
      });
      if (!resumed.ok) {
        const diagnostic = sanitizeOperationDiagnostic(
          `${resumed.code ?? 'LIVE_RECOVERY_FAILED'}: ${resumed.error ?? 'live runtime unhealthy after migration'}`,
          dataDir,
        );
        const recoveryError = await recover();
        const finalError = recoveryError?.error.message ?? diagnostic;
        finishManagedMigrationRows(db, rowIds, {
          status: 'failed', startedMs, logs, error: finalError,
        });
        return finish(502, recoveryError ?? err('MIGRATION_LIVE_RECOVERY_FAILED', diagnostic));
      }

      const items = finishManagedMigrationRows(db, rowIds, {
        status: 'success', startedMs, logs, error: null,
      });
      return finish(200, { items });
    } catch (e) {
      const diagnostic = sanitizeOperationDiagnostic((e as Error)?.message ?? String(e), dataDir);
      const recoveryError = await recover();
      const finalError = recoveryError?.error.message ?? diagnostic;
      if (rowIds.length > 0) {
        finishManagedMigrationRows(db, rowIds, {
          status: 'failed', startedMs, logs: '', error: finalError,
        });
      }
      return finish(502, recoveryError ?? err('MIGRATION_FAILED', diagnostic));
    } finally {
      releaseCapacity();
      releaseProjectOperationLock(db, reservation.record.id);
    }
  });

  app.get('/api/projects/:id/migrations', async (req) => {
    const { id } = req.params as { id: string };
    const project = needProject(id);
    if (project.type !== 'dynamic') return { items: [] };
    const rows = db
      .prepare('SELECT * FROM migrations WHERE project_id=? ORDER BY version DESC, started_at DESC, id DESC')
      .all(id) as Array<Record<string, unknown>>;
    return { items: rows.map(rowToMigration) };
  });

  app.post('/api/projects/:id/rollback', async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = needProject(id);
    if (project.type !== 'dynamic') {
      reply.code(400);
      return err('INVALID_TYPE', 'Manual rollback is only available for dynamic projects');
    }
    if (!adminToken) {
      reply.code(503);
      return err('ADMIN_AUTH_NOT_CONFIGURED', 'Administrative authentication is not configured');
    }
    if (!deployDriver) {
      reply.code(501);
      return err('DEPLOYMENT_DRIVER_NOT_CONFIGURED', 'Deployment infrastructure is not configured');
    }
    const rawKey = req.headers['idempotency-key'];
    const idempotencyKey = Array.isArray(rawKey) ? '' : (rawKey ?? '');
    let reservation;
    try {
      reservation = reserveOperation(db, {
        idempotencyKey,
        actor: 'admin',
        operation: 'rollback',
        projectId: id,
        payload: {},
      });
    } catch (e) {
      if (e instanceof OperationAuditError && e.code === 'INVALID_IDEMPOTENCY_KEY') {
        reply.code(400);
        return err(e.code, e.message);
      }
      throw e;
    }
    if (reservation.kind === 'conflict') {
      reply.code(409);
      return err('IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used for a different request');
    }
    if (reservation.kind === 'in_progress') {
      reply.code(409);
      return err('OPERATION_IN_PROGRESS', 'The idempotent operation is still running');
    }
    if (reservation.kind === 'replay') {
      reply.header('Idempotency-Replayed', 'true').code(reservation.responseStatus);
      return reservation.response;
    }
    const finish = (status: number, body: unknown): unknown => {
      completeOperation(db, reservation.record.id, status, body);
      reply.code(status);
      return body;
    };
    const runtime = getProjectRuntimeRecord(db, id);
    if (!runtime || runtime.status !== 'running' || !APPFORGE_IMAGE_REF_RE.test(runtime.liveImage)) {
      return finish(409, err('RUNTIME_NOT_READY', 'Project has no verified running live runtime to roll back'));
    }
    const source = listDeploymentRecords(db, id).find((deployment) =>
      deployment.status === 'live' &&
      APPFORGE_IMAGE_REF_RE.test(deployment.previousLiveVersion ?? '') &&
      isValidBackupId(deployment.backupId),
    );
    if (!source || !source.previousLiveVersion || !source.backupId) {
      return finish(409, err('ROLLBACK_NOT_AVAILABLE', 'No coherent previous image and backup are available'));
    }
    if (getActiveDeployment(db, id)) {
      return finish(409, err('DEPLOYMENT_ACTIVE', 'A deployment is already active for this project'));
    }
    if (!acquireProjectOperationLock(db, {
      projectId: id,
      operationId: reservation.record.id,
      operation: 'rollback',
    })) {
      return finish(409, err('PROJECT_OPERATION_ACTIVE', 'Another mutating operation is already active for this project'));
    }
    const releaseCapacity = acquireDeploymentCapacity(deployDriver);
    if (!releaseCapacity) {
      releaseProjectOperationLock(db, reservation.record.id);
      return finish(409, err('DEPLOYMENT_CAPACITY', 'Deployment capacity is currently exhausted'));
    }

    let rollbackDeployment: DeploymentRecord | null = null;
    let safetyBackupId: string | null = null;
    const sourceArgs = {
      projectId: id,
      deploymentId: source.id,
      candidateId: source.candidateId ?? `cand-${source.id.slice(0, 8)}`,
    };
    const failDeployment = (diagnostic: string): void => {
      if (!rollbackDeployment) return;
      try {
        rollbackDeployment = transitionDeployment(db, rollbackDeployment.id, 'failed', {
          diagnostic,
          error: diagnostic,
        });
      } catch {
        // The original sanitized failure remains in operation_audit.
      }
    };
    const recoverCurrent = async (): Promise<string | null> => {
      if (!safetyBackupId) return null;
      const recoverySignal = AbortSignal.timeout(5 * 60_000);
      const stopped = await deployDriver.stopCurrentLiveRuntime({ ...sourceArgs, signal: recoverySignal });
      const restored = await deployDriver.restoreBackup({ ...sourceArgs, backupId: safetyBackupId, signal: recoverySignal });
      const started = restored.ok
        ? await deployDriver.startPreviousVersion({
            ...sourceArgs,
            previousLiveVersion: runtime.liveImage,
            signal: recoverySignal,
          })
        : restored;
      const healthy = started.ok
        ? await deployDriver.runHealthCheck({ ...sourceArgs, runtime: 'live', signal: recoverySignal })
        : started;
      if (stopped.ok && restored.ok && started.ok && healthy.ok) return null;
      return sanitizeOperationDiagnostic(
        `rollback compensation failed: stop=${stopped.code}; restore=${restored.code}; start=${started.code}; health=${healthy.code}`,
        dataDir,
      );
    };

    try {
      rollbackDeployment = createDeployment(db, { projectId: id, target: 'oracle' });
      // En el deployment de rollback, "previous" significa el live que esta
      // operación sustituye. Así un rollback posterior puede recuperar el
      // estado actual usando el safety backup, no el backup objetivo antiguo.
      setDeploymentPreviousLive(db, rollbackDeployment.id, runtime.liveImage);
      rollbackDeployment = transitionDeployment(db, rollbackDeployment.id, 'building', {
        diagnostic: 'manual rollback: creating safety backup of current live',
      });
      const safety = await deployDriver.createLiveBackup({
        projectId: id,
        deploymentId: rollbackDeployment.id,
        candidateId: `cand-${rollbackDeployment.id.slice(0, 8)}`,
        previousLiveVersion: runtime.liveImage,
        signal: AbortSignal.timeout(10 * 60_000),
      });
      const safetyData = safety.data ?? {};
      const safetySize = Number(safetyData.sizeBytes);
      const safetyCreatedAt = safetyData.createdAt ?? '';
      const safetyValid =
        safety.ok &&
        isValidBackupId(safetyData.backupId) &&
        safetyData.backupValidated === 'true' &&
        safetyData.hadDatabase === 'true' &&
        Number.isSafeInteger(safetySize) && safetySize > 0 &&
        Number.isFinite(Date.parse(safetyCreatedAt)) &&
        new Date(safetyCreatedAt).toISOString() === safetyCreatedAt;
      if (!safetyValid) {
        const resumed = await deployDriver.resumeCurrentLiveRuntime({ ...sourceArgs, signal: AbortSignal.timeout(120_000) });
        const diagnostic = sanitizeOperationDiagnostic(
          `${safety.code ?? 'ROLLBACK_SAFETY_BACKUP_FAILED'}: ${safety.error ?? 'invalid safety backup evidence'}${resumed.ok ? '' : `; live recovery failed: ${resumed.code}`}`,
          dataDir,
        );
        failDeployment(diagnostic);
        return finish(502, err('ROLLBACK_SAFETY_BACKUP_FAILED', diagnostic));
      }
      safetyBackupId = safetyData.backupId!;
      setDeploymentBackup(db, rollbackDeployment.id, safetyBackupId);
      checkpointOperation(db, reservation.record.id, {
        phase: 'safety_backup_ready',
        backupId: safetyBackupId,
        sourceDeploymentId: source.id,
        rollbackDeploymentId: rollbackDeployment.id,
        currentImage: runtime.liveImage,
        targetBackupId: source.backupId,
        targetImage: source.previousLiveVersion,
      });

      rollbackDeployment = transitionDeployment(db, rollbackDeployment.id, 'migrating', {
        diagnostic: 'manual rollback: restoring prior validated backup',
      });
      const restored = await deployDriver.restoreBackup({
        ...sourceArgs,
        backupId: source.backupId,
        signal: AbortSignal.timeout(5 * 60_000),
      });
      const started = restored.ok
        ? await deployDriver.startPreviousVersion({
            ...sourceArgs,
            previousLiveVersion: source.previousLiveVersion,
            signal: AbortSignal.timeout(120_000),
          })
        : restored;
      rollbackDeployment = transitionDeployment(db, rollbackDeployment.id, 'verifying', {
        diagnostic: 'manual rollback: verifying restored runtime',
      });
      const healthy = started.ok
        ? await deployDriver.runHealthCheck({ ...sourceArgs, runtime: 'live', signal: AbortSignal.timeout(120_000) })
        : started;
      const authenticated = healthy.ok
        ? await deployDriver.runAuthenticatedLiveVerification({ ...sourceArgs, signal: AbortSignal.timeout(120_000) })
        : healthy;
      if (!restored.ok || !started.ok || !healthy.ok || !authenticated.ok) {
        const original = sanitizeOperationDiagnostic(
          `manual rollback failed: restore=${restored.code}; start=${started.code}; health=${healthy.code}; auth=${authenticated.code}`,
          dataDir,
        );
        const recoveryError = await recoverCurrent();
        const diagnostic = recoveryError ? `${original}; ${recoveryError}` : original;
        failDeployment(diagnostic);
        return finish(502, err(recoveryError ? 'ROLLBACK_AND_RECOVERY_FAILED' : 'ROLLBACK_FAILED', diagnostic));
      }
      rollbackDeployment = transitionDeployment(db, rollbackDeployment.id, 'promoting', {
        diagnostic: 'manual rollback: restored runtime verified',
      });
      checkpointOperation(db, reservation.record.id, {
        phase: 'commit_ready',
        backupId: safetyBackupId,
        sourceDeploymentId: source.id,
        rollbackDeploymentId: rollbackDeployment.id,
        currentImage: runtime.liveImage,
        targetBackupId: source.backupId,
        targetImage: source.previousLiveVersion,
      });
      rollbackDeployment = finalizeLiveDeployment(db, rollbackDeployment.id, {
        runtime: {
          projectId: id,
          containerName: runtime.containerName,
          liveImage: source.previousLiveVersion,
          previousImage: runtime.liveImage,
          status: 'running',
        },
        diagnostic: 'manual rollback completed after health and authenticated verification',
      });
      return finish(200, { deployment: toDeploymentInfo(rollbackDeployment) });
    } catch (e) {
      const original = sanitizeOperationDiagnostic((e as Error)?.message ?? String(e), dataDir);
      const recoveryError = await recoverCurrent();
      const diagnostic = recoveryError ? `${original}; ${recoveryError}` : original;
      failDeployment(diagnostic);
      return finish(502, err(recoveryError ? 'ROLLBACK_AND_RECOVERY_FAILED' : 'ROLLBACK_FAILED', diagnostic));
    } finally {
      releaseCapacity();
      releaseProjectOperationLock(db, reservation.record.id);
    }
  });

  app.post('/api/projects/:id/database/backup', async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = needProject(id);
    if (project.type !== 'dynamic') {
      reply.code(400);
      return err('INVALID_TYPE', 'Database backup is only available for dynamic projects');
    }
    // Unlike legacy development endpoints, production operations never become
    // anonymously writable when the server was started without a token.
    if (!adminToken) {
      reply.code(503);
      return err('ADMIN_AUTH_NOT_CONFIGURED', 'Administrative authentication is not configured');
    }
    if (!deployDriver) {
      reply.code(501);
      return err('DEPLOYMENT_DRIVER_NOT_CONFIGURED', 'Deployment infrastructure is not configured');
    }
    const rawKey = req.headers['idempotency-key'];
    const idempotencyKey = Array.isArray(rawKey) ? '' : (rawKey ?? '');
    let reservation;
    try {
      reservation = reserveOperation(db, {
        idempotencyKey,
        actor: 'admin',
        operation: 'database_backup',
        projectId: id,
        payload: {},
      });
    } catch (e) {
      if (e instanceof OperationAuditError && e.code === 'INVALID_IDEMPOTENCY_KEY') {
        reply.code(400);
        return err(e.code, e.message);
      }
      throw e;
    }
    if (reservation.kind === 'conflict') {
      reply.code(409);
      return err('IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used for a different request');
    }
    if (reservation.kind === 'in_progress') {
      reply.code(409);
      return err('OPERATION_IN_PROGRESS', 'The idempotent operation is still running');
    }
    if (reservation.kind === 'replay') {
      reply.header('Idempotency-Replayed', 'true').code(reservation.responseStatus);
      return reservation.response;
    }

    const finish = (status: number, body: unknown): unknown => {
      completeOperation(db, reservation.record.id, status, body);
      reply.code(status);
      return body;
    };
    const runtime = getProjectRuntimeRecord(db, id);
    if (!runtime || runtime.status !== 'running' || !APPFORGE_IMAGE_REF_RE.test(runtime.liveImage)) {
      return finish(409, err('RUNTIME_NOT_READY', 'Project has no verified running live runtime to back up'));
    }
    if (getActiveDeployment(db, id)) {
      return finish(409, err('DEPLOYMENT_ACTIVE', 'A deployment is already active for this project'));
    }
    if (!acquireProjectOperationLock(db, {
      projectId: id,
      operationId: reservation.record.id,
      operation: 'database_backup',
    })) {
      return finish(409, err('PROJECT_OPERATION_ACTIVE', 'Another mutating operation is already active for this project'));
    }
    const releaseCapacity = acquireDeploymentCapacity(deployDriver);
    if (!releaseCapacity) {
      releaseProjectOperationLock(db, reservation.record.id);
      return finish(409, err('DEPLOYMENT_CAPACITY', 'Deployment capacity is currently exhausted'));
    }

    try {
      const deploymentId = randomUUID();
      const driverArgs = {
        projectId: id,
        deploymentId,
        candidateId: `cand-${deploymentId.slice(0, 8)}`,
      };
      const result = await deployDriver.createLiveBackup({
        ...driverArgs,
        previousLiveVersion: runtime.liveImage,
        signal: AbortSignal.timeout(10 * 60_000),
      });
      const data = result.data ?? {};
      const sizeBytes = Number(data.sizeBytes);
      const createdAt = data.createdAt ?? '';
      const valid =
        result.ok &&
        isValidBackupId(data.backupId) &&
        data.backupValidated === 'true' &&
        Number.isSafeInteger(sizeBytes) &&
        sizeBytes >= 0 &&
        Number.isFinite(Date.parse(createdAt)) &&
        new Date(createdAt).toISOString() === createdAt &&
        (data.hadDatabase === 'true' || data.hadDatabase === 'false');
      if (!valid) {
        const diagnostic = sanitizeOperationDiagnostic(
          result.error ?? result.code ?? 'driver returned invalid backup evidence',
          dataDir,
        );
        const resumed = await deployDriver.resumeCurrentLiveRuntime({
          ...driverArgs,
          signal: AbortSignal.timeout(120_000),
        });
        if (!resumed.ok) {
          return finish(502, err(
            'BACKUP_INVALID_RESULT_AND_RECOVERY_FAILED',
            sanitizeOperationDiagnostic(
              `${diagnostic}; live recovery failed (${resumed.code}): ${resumed.error}`,
              dataDir,
            ),
          ));
        }
        return finish(502, err('BACKUP_INVALID_RESULT', diagnostic));
      }
      checkpointOperation(db, reservation.record.id, { phase: 'backup_ready', backupId: data.backupId });
      // createLiveBackup deliberately leaves the live container quiesced for
      // deployment promotion. A standalone backup must explicitly resume and
      // health-check it with an independent recovery budget.
      const resumed = await deployDriver.resumeCurrentLiveRuntime({
        ...driverArgs,
        signal: AbortSignal.timeout(120_000),
      });
      if (!resumed.ok) {
        const diagnostic = sanitizeOperationDiagnostic(
          resumed.error ?? resumed.code ?? 'live runtime did not recover after backup',
          dataDir,
        );
        return finish(502, err('BACKUP_LIVE_RECOVERY_FAILED', `${diagnostic}; backupId=${data.backupId}`));
      }
      return finish(201, {
        backupId: data.backupId,
        createdAt,
        sizeBytes,
        hadDatabase: data.hadDatabase === 'true',
      });
    } catch (e) {
      const diagnostic = sanitizeOperationDiagnostic((e as Error)?.message ?? String(e), dataDir);
      return finish(502, err('BACKUP_FAILED', diagnostic));
    } finally {
      releaseCapacity();
      releaseProjectOperationLock(db, reservation.record.id);
    }
  });

  app.get('/api/projects/:id/operations', async (req) => {
    const { id } = req.params as { id: string };
    needProject(id);
    return {
      items: listOperations(db, id).map((operation) => ({
        id: operation.id,
        actor: operation.actor,
        operation: operation.operation,
        status: operation.status,
        responseStatus: operation.responseStatus,
        result: operation.response,
        createdAt: operation.createdAt,
        updatedAt: operation.updatedAt,
        finishedAt: operation.finishedAt,
      })),
    };
  });

  app.get('/api/projects/:id/runtime', async (req, reply) => {
    const { id } = req.params as { id: string };
    needProject(id);
    const rt = getProjectRuntimeRecord(db, id);
    if (!rt) {
      reply.code(404);
      return err('RUNTIME_NOT_FOUND', 'project has no runtime record (never deployed)');
    }
    return toProjectRuntime(rt);
  });

  // ----------------------------------------------------------------- preview
  app.get('/api/projects/:id/preview', async (req) => {
    const { id } = req.params as { id: string };
    const project = needProject(id);
    if (project.type === 'dynamic') {
      const preview = getPreview(db, id);
      if (preview?.status === 'ready') return { url: `/a/${id}/`, status: 'ready' };
      if (preview?.status === 'starting') return { url: `/a/${id}/`, status: 'building' };
      const runtime = getProjectRuntimeRecord(db, id);
      if (runtime?.status === 'running') return { url: `/a/${id}/`, status: 'ready' };
      const activeDeploy = db.prepare(
        "SELECT id FROM deployments WHERE project_id=? AND status IN ('pending','building','migrating','verifying','promoting') LIMIT 1",
      ).get(id);
      return { url: `/a/${id}/`, status: activeDeploy ? 'building' : 'none' };
    }
    const distIndex = path.join(frontendDir(dataDir, id), 'dist', 'index.html');
    let status: 'ready' | 'building' | 'none' = 'none';
    if (fs.existsSync(distIndex)) status = 'ready';
    else {
      const b = db.prepare("SELECT id FROM builds WHERE project_id=? AND status IN ('pending','running') LIMIT 1").get(id);
      if (b) status = 'building';
    }
    return { url: `/p/${id}/`, status };
  });

  // ---------------------------------------------------------------- settings
  app.get('/api/settings', async () => toPublicSettings(ensureSettingsRow(db)));

  app.patch('/api/settings', async (req) => {
    const body = SettingsPatch.parse(req.body);
    const stored = ensureSettingsRow(db);
    const next: StoredSettings = { ...stored };
    for (const k of ['provider', 'model', 'temperature', 'maxTokens', 'maxIterations', 'maxHardIterations', 'maxRepairAttempts', 'llmTimeoutMs', 'cmdTimeoutMs', 'runTimeoutMs', 'language', 'theme', 'autoRevision', 'autoBuild'] as const) {
      const v = (body as Record<string, unknown>)[k];
      if (v !== undefined) (next as unknown as Record<string, unknown>)[k] = v;
    }
    if (body.secrets) {
      next.secrets = { ...(next.secrets ?? {}) };
      for (const [k, v] of Object.entries(body.secrets)) {
        if (v === undefined) continue;
        (next.secrets as Record<string, unknown>)[k] = v === '' ? undefined : v;
      }
    }
    db.prepare('UPDATE settings SET data_json=? WHERE id=1').run(JSON.stringify(next));
    return toPublicSettings(next);
  });

  // Existing projects created before thumbnail support are captured lazily
  // on the first Library image request. Concurrent requests share one job.
  app.get('/p/:projectId/__appforge/thumbnail.webp', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const project = getProject(db, projectId);
    if (!project) { reply.code(404); return ''; }
    const distDir = path.join(frontendDir(dataDir, projectId), 'dist');
    const thumbnail = path.join(distDir, '__appforge', 'thumbnail.webp');
    if (!fs.existsSync(thumbnail)) {
      if (!fs.existsSync(path.join(distDir, 'index.html'))) { reply.code(404); return ''; }
      let job = thumbnailJobs.get(projectId);
      if (!job) {
        job = checkBrowser(distDir, projectId, [], 45_000, {}, thumbnail);
        thumbnailJobs.set(projectId, job);
        void job.finally(() => thumbnailJobs.delete(projectId));
      }
      const result = await job;
      if (!result.ok || !fs.existsSync(thumbnail)) { reply.code(404); return ''; }
    }
    reply.hijack();
    sendFile(thumbnail, reply.raw);
  });

  // ------------------------------------------------------- static preview /p
  app.get('/p/:projectId/*', async (req, reply) => {
    const { projectId } = req.params as { projectId: string; '*': string };
    const p = getProject(db, projectId);
    if (!p) {
      reply.code(404).type('text/html; charset=utf-8');
      return '<h1>Project not found</h1>';
    }
    const distDir = path.join(frontendDir(dataDir, projectId), 'dist');
    const indexHtml = path.join(distDir, 'index.html');
    if (!fs.existsSync(indexHtml)) {
      reply.code(404).type('text/html; charset=utf-8');
      return diagnosticHtml(projectId, p.name);
    }
    const rel = ((req.params as Record<string, string>)['*'] ?? '').split('?')[0];
    let abs = indexHtml;
    if (rel) {
      const candidate = path.normalize(path.join(distDir, rel));
      if (candidate !== distDir && !candidate.startsWith(distDir + path.sep)) {
        reply.code(400).type('text/html; charset=utf-8');
        return '<h1>Invalid path</h1>';
      }
      try {
        const st = fs.statSync(candidate);
        abs = st.isDirectory() ? indexHtml : candidate;
      } catch {
        abs = indexHtml; // SPA fallback
      }
    }
    reply.hijack();
    sendFile(abs, reply.raw);
  });

  // --------------------------------------- dynamic preview proxy /a (Fase 5B)
  // The proxy forwards the RAW request body. A dedicated passthrough parser
  // keeps the bytes untouched; the preParsing hook reroutes /a/* bodies to
  // it (with a 10 MiB cap) so Fastify's JSON parser never touches them.
  // Every other route is completely untouched.
  app.addContentTypeParser(
    'application/x-appforge-passthrough',
    { parseAs: 'buffer', bodyLimit: 10 * 1024 * 1024 },
    (_req, body, done) => done(null, body),
  );
  app.addHook('preParsing', (req, _reply, payload, done) => {
    if (!req.url?.startsWith('/a/')) return done(null, payload);
    const r = req as unknown as { proxyContentType?: string };
    r.proxyContentType = req.headers['content-type'] as string | undefined;
    req.headers['content-type'] = 'application/x-appforge-passthrough';
    done(null, payload);
  });

  // Proxies to the ephemeral full-stack preview registered for a dynamic
  // project. The target URL ALWAYS comes from the internal preview registry
  // (never from user input): this is not an open proxy.
  app.all('/a/:projectId/*', async (req, reply) => {
    const { projectId } = req.params as { projectId: string; '*': string };
    const p = getProject(db, projectId);
    if (!p || (p as { type?: string }).type !== 'dynamic') {
      reply.code(404).type('text/html; charset=utf-8');
      return '<h1>Project not found</h1>';
    }
    const preview = getPreview(db, projectId);
    let targetBase: string | null = null;
    let targetKind: 'preview' | 'live' = 'preview';
    if (preview?.status === 'ready' && preview.port) {
      targetBase = `http://127.0.0.1:${preview.port}`;
    } else {
      const runtimeRecord = getProjectRuntimeRecord(db, projectId);
      const expectedContainer = `appforge-app-${projectId.slice(0, 8)}`;
      const validRuntime =
        runtimeRecord?.status === 'running' &&
        runtimeRecord.containerName === expectedContainer &&
        APPFORGE_IMAGE_REF_RE.test(runtimeRecord.liveImage);
      if (validRuntime && runtimeRecord) {
        targetKind = 'live';
        const publicRuntime = toProjectRuntime(runtimeRecord);
        if (opts.liveRuntimeOrigin) {
          // El resolver inyectado existe solo para tests locales: incluso ahí
          // se restringe a loopback HTTP para que nunca se convierta en SSRF.
          const injected = opts.liveRuntimeOrigin(publicRuntime);
          if (injected) {
            try {
              const parsed = new URL(injected);
              if (
                parsed.protocol === 'http:' &&
                ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(parsed.hostname) &&
                !parsed.username && !parsed.password && parsed.pathname === '/' && !parsed.search && !parsed.hash
              ) targetBase = parsed.origin;
            } catch {
              targetBase = null;
            }
          }
        } else {
          targetBase = `http://${expectedContainer}:8080`;
        }
      }
    }
    if (!targetBase) {
      reply.code(503).type('text/html; charset=utf-8');
      return dynamicPreviewDiagnosticHtml(projectId, p.name, preview?.status ?? 'none');
    }
    // Strip the /a/:projectId prefix; the remainder goes to the preview.
    const rest = ((req.params as Record<string, string>)['*'] ?? '').split('?')[0];
    const rawUrl = req.raw.url ?? '/';
    const qIndex = rawUrl.indexOf('?');
    const query = qIndex >= 0 ? rawUrl.slice(qIndex) : '';
    const target = `${targetBase}/${rest}${query}`;

    // Forward headers minus hop-by-hop and minus the Studio Authorization.
    const HOP_BY_HOP = new Set([
      'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
      'te', 'trailer', 'transfer-encoding', 'upgrade',
    ]);
    const fwdHeaders = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      const lk = k.toLowerCase();
      // `content-type` has been replaced by our private passthrough parser in
      // preParsing. Never forward that internal value to the application;
      // restore only the original client value below. This is especially
      // important for bodyless POSTs (for example logout), where forwarding
      // application/x-appforge-passthrough makes Fastify answer 415.
      if (lk === 'host' || lk === 'authorization' || lk === 'content-type' || HOP_BY_HOP.has(lk)) continue;
      if (Array.isArray(v)) { for (const vv of v) fwdHeaders.append(k, vv); }
      else if (v !== undefined) fwdHeaders.set(k, v);
    }
    // Restore the content-type stashed by the preParsing hook.
    const stashedCt = (req as unknown as { proxyContentType?: string }).proxyContentType;
    if (stashedCt) fwdHeaders.set('content-type', stashedCt);

    // Raw body via the passthrough parser (10 MiB cap enforced there -> 413).
    let body: Buffer | undefined;
    const method = req.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      const b = req.body as Buffer | undefined;
      body = Buffer.isBuffer(b) ? b : undefined;
    }

    let upstream: Response;
    try {
      upstream = await fetch(target, {
        method,
        headers: fwdHeaders,
        body: body ?? undefined,
        signal: AbortSignal.timeout(30_000),
        duplex: body ? 'half' : undefined,
      });
    } catch (e) {
      // Fail-close BEFORE answering 503: when this process owns the backend,
      // its tree is killed and reaped first (no orphan, no deletion under a
      // live backend); otherwise only the registry row is closed and verified
      // temp paths cleaned — a persisted PID is never killed. The proxy never
      // trusts a `ready` SQLite row alone.
      if (targetKind === 'preview') {
        await failPreview(db, projectId, `preview backend unreachable: ${(e as Error).message}`.slice(0, 500));
      }
      reply.code(503).type('text/html; charset=utf-8');
      return dynamicPreviewDiagnosticHtml(projectId, p.name, 'unreachable');
    }

    const outHeaders: Record<string, string | string[]> = {};
    upstream.headers.forEach((v, k) => {
      const lk = k.toLowerCase();
      if (HOP_BY_HOP.has(lk)) return;
      // We re-buffer the body below, so the upstream framing headers must not
      // be forwarded: Fastify sets its own content-length, and fetch may have
      // decompressed a gzipped body (forwarding content-encoding would corrupt
      // the response).
      if (lk === 'content-length' || lk === 'content-encoding' || lk === 'set-cookie') return;
      outHeaders[k] = v;
    });
    // getSetCookie preserves multiple Set-Cookie headers (forEach would merge
    // them into one comma-joined value).
    const setCookies = (upstream.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    if (setCookies.length > 0) outHeaders['set-cookie'] = setCookies;
    // The Workspace preview embeds the app in a sandboxed iframe (opaque
    // origin): every subresource and API fetch is a CORS request. The /a/
    // proxy is unauthenticated by design. Browsers reject the '*' wildcard
    // when the app fetches with credentials:'include', so answer sandboxed
    // (Origin: null) callers with an explicit null origin + credentials.
    // Never echo arbitrary origins: that would turn user sessions into a
    // cross-site credential leak.
    if (req.headers.origin === 'null') {
      outHeaders['access-control-allow-origin'] = 'null';
      outHeaders['access-control-allow-credentials'] = 'true';
      outHeaders['vary'] = 'Origin';
    } else {
      outHeaders['access-control-allow-origin'] = '*';
    }

    // Never load an unbounded upstream body: fast-reject on a declared
    // Content-Length, then stream with a hard cap (also guards against
    // gzip bombs, since fetch decompresses before we count bytes).
    const MAX_UPSTREAM_BYTES = 10 * 1024 * 1024;
    const declared = upstream.headers.get('content-length');
    if (declared !== null) {
      const n = Number(declared);
      if (!Number.isFinite(n) || n < 0 || n > MAX_UPSTREAM_BYTES) {
        reply.code(502).type('text/html; charset=utf-8');
        return dynamicPreviewDiagnosticHtml(projectId, p.name, 'unreachable');
      }
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    const reader = upstream.body?.getReader();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_UPSTREAM_BYTES) {
          tooLarge = true;
          await reader.cancel().catch(() => null);
          break;
        }
        chunks.push(Buffer.from(value));
      }
    }
    if (tooLarge) {
      reply.code(502).type('text/html; charset=utf-8');
      return dynamicPreviewDiagnosticHtml(projectId, p.name, 'unreachable');
    }
    const buf = Buffer.concat(chunks);
    reply.code(upstream.status);
    for (const [k, v] of Object.entries(outHeaders)) reply.header(k, v);
    return reply.send(buf);
  });

  // --------------------------------------- studio SPA (single-server mode, if built)
  const studioDist = opts.studioDistDir ?? path.resolve(SRC_DIR, '..', '..', 'studio', 'dist');
  if (fs.existsSync(path.join(studioDist, 'index.html'))) {
    app.get('/*', async (req, reply) => {
      const url = req.raw.url ?? '/';
      if (url === '/api' || url.startsWith('/api/')) { reply.code(404); return err('NOT_FOUND', 'not found'); }
      const rel = url.split('?')[0].replace(/^\/+/, '');
      const candidate = path.normalize(path.join(studioDist, rel || 'index.html'));
      let abs = path.join(studioDist, 'index.html');
      if ((candidate === studioDist || candidate.startsWith(studioDist + path.sep)) && rel) {
        try {
          const st = fs.statSync(candidate);
          abs = st.isDirectory() ? abs : candidate;
        } catch {
          abs = path.join(studioDist, 'index.html');
        }
      }
      reply.hijack();
      sendFile(abs, reply.raw);
    });
  }

  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send(err('NOT_FOUND', 'not found'));
  });

  return app;
}

// ---------------------------------------------------------------------------
// Builds (background execution)
// ---------------------------------------------------------------------------

async function executeBuild(db: Database.Database, dataDir: string, buildId: string): Promise<void> {
  const row = db.prepare('SELECT * FROM builds WHERE id=?').get(buildId) as Record<string, any> | undefined;
  if (!row) return;
  const t0 = Date.now();
  try {
    const ctx: ToolContext = { db, projectId: row.project_id, projectDir: projectDir(dataDir, row.project_id), frontendDir: frontendDir(dataDir, row.project_id), cmdTimeoutMs: 180_000, buildTimeoutMs: 600_000, buildId };
    const result = await createTools().start_preview(ctx, {});
    if (!result.ok) {
      db.prepare("UPDATE builds SET status='failed', finished_at=?, duration_ms=?, logs=COALESCE(logs,'') || ?, error=? WHERE id=?").run(nowIso(), Date.now() - t0, `\n${result.output ?? result.error}`, result.error ?? 'verification failed', buildId);
    }
  } catch (e) {
    db.prepare("UPDATE builds SET status='failed', finished_at=?, error=? WHERE id=?").run(nowIso(), `build crashed: ${(e as Error).message}`.slice(0, 2000), buildId);
  }
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const dataDir = process.env.DATA_DIR ?? path.resolve(process.cwd(), 'data');
  assertProductionConfiguration(process.env, dataDir);
  const templatesDir = process.env.TEMPLATES_DIR ?? path.resolve(process.cwd(), 'templates');
  const db = openDb(dataDir);
  ensureSettingsRow(db);
  const interrupted = reconcileInterruptedRuns(db);
  if (interrupted > 0) console.log(`[server] marked ${interrupted} interrupted run(s) as error`);
  const interruptedBuilds = reconcileInterruptedBuilds(db);
  if (interruptedBuilds > 0) console.log(`[server] marked ${interruptedBuilds} interrupted build(s) as failed`);
  const interruptedMigrations = reconcileInterruptedMigrations(db);
  if (interruptedMigrations > 0) console.log(`[server] marked ${interruptedMigrations} interrupted migration(s) as failed`);
  // Fase 5B: ephemeral previews never survive a restart.
  const stalePreviews = reconcilePreviews(db);
  if (stalePreviews > 0) console.log(`[server] discarded ${stalePreviews} stale preview(s)`);
  // Fase 7B: una única instancia, fail closed, compartida por reconciliación,
  // HTTP y worker. Si está disabled/unavailable el Studio sigue operativo y
  // los endpoints conservan el 501; nunca se sustituye por un fake.
  const dockerActivation = await activateDockerDeployment({
    env: process.env,
    dataDir,
    templatesDir,
    db,
  });
  const deploymentDriver = dockerActivation.driver ?? undefined;
  console.log(`[server] docker deployment: ${dockerActivation.status}${dockerActivation.diagnostics.length ? ` (${dockerActivation.diagnostics.join('; ')})` : ''}`);
  // Los estados no terminales no sobreviven a un reinicio. Con Docker listo,
  // el driver inspecciona primero los recursos que realmente posee.
  const interruptedDeployments = await reconcileDeployments(db, deploymentDriver);
  if (interruptedDeployments > 0) console.log(`[server] marked ${interruptedDeployments} interrupted deployment(s) as failed`);
  const interruptedOperations = await recoverInterruptedAdministrativeOperations(db, deploymentDriver, dataDir);
  if (interruptedOperations > 0) {
    console.log(`[server] recovered and closed ${interruptedOperations} interrupted administrative operation(s)`);
  }
  const staleOperationLocks = reconcileProjectOperationLocks(db);
  if (staleOperationLocks > 0) console.log(`[server] released ${staleOperationLocks} stale project operation lock(s)`);
  if (deploymentDriver) {
    const runtimes = await reconcileProjectRuntimes(db, deploymentDriver);
    if (runtimes.checked > 0) {
      console.log(`[server] reconciled ${runtimes.checked} runtime(s); unavailable=${runtimes.unavailable}`);
    }
  }

  const backgroundTasks = createBackgroundTaskTracker();
  const worker = startWorker(db, { dataDir, pollMs: 2000, getSettings: () => getAgentSettings(db), deploymentDriver });
  const app = buildServer({
    db,
    dataDir,
    templatesDir,
    adminToken: process.env.APPFORGE_ADMIN_TOKEN,
    corsOrigin: process.env.CORS_ORIGIN ?? '*',
    deploymentDriver,
    backgroundTasks,
  });

  const shutdownTimeoutMs = parseShutdownTimeout(process.env.APPFORGE_SHUTDOWN_TIMEOUT_MS);
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] shutdown requested; drain budget=${shutdownTimeoutMs}ms`);
    worker.stop();
    const closeTask = app.close().then(() => true).catch((e: unknown) => {
      console.error('[server] HTTP close failed:', (e as Error)?.message ?? e);
      return false;
    });
    const [httpClosed, workerDrained, backgroundDrained] = await Promise.all([
      Promise.race([
        closeTask,
        new Promise<false>((resolve) => {
          const timer = setTimeout(() => resolve(false), shutdownTimeoutMs);
          timer.unref?.();
        }),
      ]),
      worker.drain(shutdownTimeoutMs),
      backgroundTasks.drain(shutdownTimeoutMs),
    ]);
    if (!httpClosed || !workerDrained || !backgroundDrained) {
      console.warn('[server] drain budget exhausted; persistent reconciliation will close unfinished operations on restart');
    }
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  const port = Number(process.env.PORT ?? 3001);
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`[server] listening on :${port} (data=${dataDir})`);
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isMain) {
  main().catch((e) => {
    console.error('[server] fatal:', e);
    process.exit(1);
  });
}
