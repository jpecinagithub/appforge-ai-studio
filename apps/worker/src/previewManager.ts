/**
 * Fase 5B — ephemeral full-stack preview manager for dynamic projects.
 *
 * start_fullstack_preview launches the project's own backend directly
 * (`node backend/dist/server.js`, no Docker, no production) against a
 * temporary SQLite database on a free loopback port. The Studio publishes it
 * at /a/:projectId/ through its proxy; the preview registry below is the
 * single source of truth for that proxy.
 *
 * SECURITY: executing generated (LLM-written) code on the server is
 * inherently unsafe and is therefore DISABLED BY DEFAULT. The tool only
 * runs when APPFORGE_ENABLE_UNSAFE_LOCAL_PREVIEW=1 is set in the worker
 * environment. Without it the tool returns PREVIEW_DISABLED. Cleanup
 * (stopPreview / reconcilePreviews) is never gated: it must always run.
 *
 * Invariants:
 * - Only one active preview per project; starting a new one fully stops the
 *   old one first (whole process tree, wait for exit) — but only when this
 *   worker process owns the ChildProcess (verified via the in-memory handle
 *   map). A PID read from SQLite is never a kill target.
 * - The child never receives Studio secrets (buildChildEnv allowlist).
 * - The child listens on 127.0.0.1 only.
 * - On timeout/cancel/replace the whole owned process tree is killed and
 *   the temp SQLite (+WAL/SHM) is removed.
 * - After an AppForge restart no previous preview is considered ready.
 *   reconcilePreviews() marks them stopped WITHOUT killing any PID:
 *   a PID read from SQLite after a restart may have been reused by the OS
 *   for an unrelated process, so it must never be trusted.
 *
 * RESIDUAL RISK: an abrupt AppForge shutdown can leave a previously detached
 * backend process alive: reconcilePreviews can no longer kill it safely.
 * Do not claim "no orphaned processes after restart" until a supervisor
 * with a parent-lifetime bond or the Phase 7 isolation exists.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { ToolResult } from 'appforge-shared';
import {
  buildChildEnv,
  killTreeByPid,
  sanitizeSecrets,
  previewGateStatus,
  recordDynamicCheckForTest,
} from './dynamicTools.js';
import type { ToolContext } from './tools.js';

export type PreviewStatus = 'starting' | 'ready' | 'failed' | 'stopped';

export interface PreviewRow {
  project_id: string;
  port: number | null;
  pid: number | null;
  status: PreviewStatus;
  db_path: string | null;
  tmp_dir: string | null;
  error: string | null;
  updated_at: string;
}

const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_POLL_MS = 250;

/** Opt-in env var that enables executing generated code as a local preview. */
export const PREVIEW_ENABLE_ENV = 'APPFORGE_ENABLE_UNSAFE_LOCAL_PREVIEW';

export function previewExecutionEnabled(): boolean {
  return process.env[PREVIEW_ENABLE_ENV] === '1';
}

export function ensurePreviewsTable(db: ToolContext['db']): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS previews(
      project_id TEXT PRIMARY KEY,
      port INTEGER,
      pid INTEGER,
      status TEXT NOT NULL,
      db_path TEXT,
      tmp_dir TEXT,
      error TEXT,
      updated_at TEXT NOT NULL
    )`);
}

export function getPreview(db: ToolContext['db'], projectId: string): PreviewRow | undefined {
  ensurePreviewsTable(db);
  return db.prepare('SELECT * FROM previews WHERE project_id=?').get(projectId) as PreviewRow | undefined;
}

function setPreview(db: ToolContext['db'], row: Omit<PreviewRow, 'updated_at'> & { updated_at?: string }): void {
  ensurePreviewsTable(db);
  db.prepare(`
    INSERT INTO previews(project_id, port, pid, status, db_path, tmp_dir, error, updated_at)
    VALUES (@project_id, @port, @pid, @status, @db_path, @tmp_dir, @error, @updated_at)
    ON CONFLICT(project_id) DO UPDATE SET
      port=excluded.port, pid=excluded.pid, status=excluded.status,
      db_path=excluded.db_path, tmp_dir=excluded.tmp_dir,
      error=excluded.error, updated_at=excluded.updated_at
  `).run({ ...row, updated_at: new Date().toISOString() });
}

/** In-memory child handles (valid only for this worker process lifetime). */
const children = new Map<string, ChildProcess>();

function fail(code: string, error: string, durationMs: number): ToolResult {
  return { ok: false, code, error, durationMs };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitPidGone(pid: number, timeoutMs = 10_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (!pidAlive(pid)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
}

const PREVIEW_TMP_PREFIX = 'af-preview-';

/**
 * Guard for recursive temp-dir deletion. A path is only deleted when it is
 * strictly inside os.tmpdir(), is not os.tmpdir() itself, and carries the
 * reserved af-preview- basename prefix. Anything else is refused.
 * Throws on refusal so callers can decide how to handle it.
 */
export function validatePreviewTmpDir(tmpDir: string): string {
  const base = path.resolve(tmpdir());
  const resolved = path.resolve(tmpDir);
  if (resolved === base) {
    throw new Error('refusing to delete os.tmpdir() itself');
  }
  if (!resolved.startsWith(base + path.sep)) {
    throw new Error('refusing to delete a path outside os.tmpdir()');
  }
  if (!path.basename(resolved).startsWith(PREVIEW_TMP_PREFIX)) {
    throw new Error(`refusing to delete a path without the ${PREVIEW_TMP_PREFIX} prefix`);
  }
  return resolved;
}

function cleanupTmpDir(tmpDir: string | null): void {
  if (!tmpDir) return;
  let safe: string;
  try {
    safe = validatePreviewTmpDir(tmpDir);
  } catch {
    // Refused: never recursively delete an unverified path.
    return;
  }
  try {
    fs.rmSync(safe, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

async function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port > 0 ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

/** Cookie name scoped to the project (safe token characters only). */
export function previewCookieName(projectId: string): string {
  return `af_preview_${projectId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16)}`;
}

/**
 * Fully stop a preview.
 *
 * Only kills when THIS worker process owns the ChildProcess: ownership is
 * verified through the in-memory `children` map (the handle we spawned).
 * A PID read from the SQLite row is NEVER a kill or wait target — after a
 * restart the OS may have reused it for an unrelated process. With no owned
 * child, the operation is limited to safely cleaning the verified temp dir
 * and closing the registry row.
 */
export async function stopPreview(
  db: ToolContext['db'],
  projectId: string,
  reason: string,
): Promise<void> {
  const child = children.get(projectId);
  if (child) {
    // Take ownership first: the exit watcher becomes a no-op for this child,
    // so stop/replace/proxy-failure cannot double-kill it.
    children.delete(projectId);
    killTreeByPid(child.pid);
    if (child.pid) await waitPidGone(child.pid);
  }
  const row = getPreview(db, projectId);
  cleanupTmpDir(row?.tmp_dir ?? null);
  setPreview(db, {
    project_id: projectId,
    port: null,
    pid: null,
    status: 'stopped',
    db_path: null,
    tmp_dir: null,
    error: reason || null,
  });
}

/**
 * Fail-close a preview whose backend is believed unreachable: the Studio
 * proxy calls this on upstream fetch failure, and the exit watcher calls it
 * when the owned backend dies after going ready.
 *
 * This is async and MUST be awaited before reporting the preview as failed:
 *
 * - When this process owns the ChildProcess, its whole tree is killed and
 *   termination is awaited BEFORE the temp SQLite (+WAL/SHM) is cleaned and
 *   the row is marked failed: no orphaned process, no deletion under a live
 *   backend, and the kill handle is never lost.
 * - When there is no owned ChildProcess, the persisted PID is untrusted and
 *   is never killed or waited on: the operation is limited to closing the
 *   registry row and cleaning verified temp paths.
 *
 * Race safety: ownership is taken synchronously through the `children` map,
 * so the exit watcher, stopPreview, replace and proxy failure cannot
 * double-kill the same child. The row is re-read after the wait: if it was
 * replaced meanwhile (different pid), it is left alone.
 */
export async function failPreview(
  db: ToolContext['db'],
  projectId: string,
  reason: string,
): Promise<void> {
  const child = children.get(projectId);
  const row = getPreview(db, projectId);
  const tmpDir = row?.tmp_dir ?? null;
  const rowPid = row?.pid ?? null;
  if (child) {
    // Take ownership first: the exit watcher becomes a no-op for this child.
    children.delete(projectId);
    killTreeByPid(child.pid);
    if (child.pid) await waitPidGone(child.pid);
  }
  if (!row) return;
  const current = getPreview(db, projectId);
  // Replaced while we waited (different pid): leave the new preview alone.
  if (current && current.pid !== rowPid) return;
  cleanupTmpDir(tmpDir);
  setPreview(db, {
    project_id: projectId,
    port: null,
    pid: null,
    status: 'failed',
    db_path: null,
    tmp_dir: null,
    error: reason,
  });
}
/**
 * Startup recovery: no previous preview is ever considered ready.
 * NEVER kills a PID read from SQLite after a restart: the OS may have
 * reused that PID for an unrelated process, so its identity cannot be
 * verified. Only processes spawned (and therefore owned) by this worker
 * lifetime may ever be killed. Temp dirs are cleaned, rows marked stopped.
 * Returns the number reconciled.
 */
export function reconcilePreviews(db: ToolContext['db']): number {
  ensurePreviewsTable(db);
  const rows = db.prepare("SELECT * FROM previews WHERE status IN ('starting','ready')").all() as PreviewRow[];
  for (const row of rows) {
    cleanupTmpDir(row.tmp_dir);
    setPreview(db, {
      project_id: row.project_id,
      port: null,
      pid: null,
      status: 'stopped',
      db_path: null,
      tmp_dir: null,
      error: 'appforge restarted: ephemeral preview discarded',
    });
  }
  children.clear();
  return rows.length;
}

/** Precondition for start_fullstack_preview: the four 5A checks, valid and in order. */
function previewPreconditions(ctx: ToolContext): ToolResult | null {
  const gate = previewGateStatus(ctx);
  if (!gate.ok) {
    return fail(
      'DYNAMIC_CHECKS_INCOMPLETE',
      `start_fullstack_preview requires run_frontend_build, run_backend_build, run_migrations and run_api_tests to be valid and in order. Missing or stale: ${gate.missing.join(', ') || 'order'}.`,
      0,
    );
  }
  return null;
}

export async function startFullstackPreview(ctx: ToolContext): Promise<ToolResult> {
  const t0 = Date.now();
  const { projectId } = ctx;

  // Kill switch: executing generated code on the server is opt-in only.
  if (!previewExecutionEnabled()) {
    return fail(
      'PREVIEW_DISABLED',
      `start_fullstack_preview is disabled by default: it executes generated code on this server. ` +
        `Set ${PREVIEW_ENABLE_ENV}=1 in the worker environment to enable local previews explicitly.`,
      Date.now() - t0,
    );
  }

  const pre = previewPreconditions(ctx);
  if (pre) return { ...pre, durationMs: Date.now() - t0 };

  // Only one active preview per project: stop the old one completely first.
  const existing = getPreview(ctx.db, projectId);
  if (existing && (existing.status === 'starting' || existing.status === 'ready')) {
    await stopPreview(ctx.db, projectId, 'replaced by a new preview');
  }

  const backendDir = path.join(ctx.projectDir, 'backend');
  const entry = path.join(backendDir, 'dist', 'server.js');
  if (!fs.existsSync(entry)) {
    setPreview(ctx.db, {
      project_id: projectId, port: null, pid: null, status: 'failed',
      db_path: null, tmp_dir: null, error: 'backend/dist/server.js not found: run run_backend_build first',
    });
    return fail('PREVIEW_ENTRY_MISSING', 'backend/dist/server.js not found: run run_backend_build first', Date.now() - t0);
  }

  const tmpDir = fs.mkdtempSync(path.join(tmpdir(), `${PREVIEW_TMP_PREFIX}${process.pid}-`));
  const dbPath = path.join(tmpDir, 'preview.db');
  setPreview(ctx.db, {
    project_id: projectId, port: null, pid: null, status: 'starting',
    db_path: dbPath, tmp_dir: tmpDir, error: null,
  });

  let port: number;
  try {
    port = await freeLoopbackPort();
  } catch (e) {
    cleanupTmpDir(tmpDir);
    const msg = `no free loopback port: ${(e as Error).message}`;
    setPreview(ctx.db, { project_id: projectId, port: null, pid: null, status: 'failed', db_path: null, tmp_dir: null, error: msg });
    return fail('PREVIEW_NO_PORT', msg, Date.now() - t0);
  }

  const env = buildChildEnv({
    PORT: String(port),
    HOST: '127.0.0.1',
    NODE_ENV: 'test',
    DB_PATH: dbPath,
    PUBLIC_PATH: `/a/${projectId}/`,
    SESSION_COOKIE_NAME: previewCookieName(projectId),
  });

  const child = spawn('node', ['dist/server.js'], {
    cwd: backendDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  children.set(projectId, child);
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf8').slice(0, 4000 - stdout.length); });
  child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf8').slice(0, 4000 - stderr.length); });
  let exitCode: number | null = null;
  child.on('exit', (code, signal) => {
    exitCode = code;
    // Hand the failure to failPreview: it takes ownership synchronously, so
    // stopPreview, replace and proxy-failure cannot double-handle this child.
    // Intentional stops delete the handle from the map first: no-op for them.
    if (children.get(projectId) !== child) return;
    const row = getPreview(ctx.db, projectId);
    if (row && row.status === 'ready') {
      failPreview(
        ctx.db,
        projectId,
        sanitizeSecrets(`preview backend exited unexpectedly (code=${code} signal=${signal}) stdout=${stdout} stderr=${stderr}`.slice(0, 2000)),
      ).catch(() => { /* best effort: the row keeps its last state */ });
    } else {
      children.delete(projectId);
    }
  });
  child.on('error', () => { if (exitCode === null) exitCode = -1; });

  // Wait for /healthz, but abort early if the process exits or we're cancelled.
  const healthOutcome = await (async (): Promise<'healthy' | 'exited' | 'cancelled' | 'timeout'> => {
    const t0 = Date.now();
    while (Date.now() - t0 < HEALTH_TIMEOUT_MS) {
      if (ctx.isCancelled?.()) return 'cancelled';
      if (exitCode !== null) return 'exited';
      try {
        const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
          signal: AbortSignal.timeout(2000),
        });
        await res.arrayBuffer().catch(() => null);
        if (res.ok) return 'healthy';
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
    }
    return 'timeout';
  })();

  if (ctx.isCancelled?.() || healthOutcome === 'cancelled') {
    await stopPreview(ctx.db, projectId, 'cancelled');
    return fail('PREVIEW_CANCELLED', 'preview start cancelled', Date.now() - t0);
  }

  if (healthOutcome !== 'healthy') {
    const detail = sanitizeSecrets(`health check failed (${healthOutcome}, exit=${exitCode}) stdout=${stdout} stderr=${stderr}`.slice(0, 2000));
    await stopPreview(ctx.db, projectId, 'health check failed');
    setPreview(ctx.db, {
      project_id: projectId, port: null, pid: null, status: 'failed',
      db_path: null, tmp_dir: null, error: detail,
    });
    return fail('PREVIEW_HEALTH_FAILED', detail, Date.now() - t0);
  }

  setPreview(ctx.db, {
    project_id: projectId, port, pid: child.pid ?? null, status: 'ready',
    db_path: dbPath, tmp_dir: tmpDir, error: null,
  });

  // The preview is a verification check: record it on the current sources.
  recordDynamicCheckForTest(ctx, 'fullstackPreview');

  return {
    ok: true,
    data: { url: `/a/${projectId}/`, status: 'ready', port },
    durationMs: Date.now() - t0,
  };
}
