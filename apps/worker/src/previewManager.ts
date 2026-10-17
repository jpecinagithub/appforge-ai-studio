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
 *   old one first (whole process tree, wait for exit).
 * - The child never receives Studio secrets (buildChildEnv allowlist).
 * - The child listens on 127.0.0.1 only.
 * - On timeout/cancel/replace/shutdown the whole process tree is killed and
 *   the temp SQLite (+WAL/SHM) is removed: no orphaned processes or ports.
 * - After an AppForge restart no previous preview is considered ready.
 *   reconcilePreviews() marks them stopped WITHOUT killing any PID:
 *   a PID read from SQLite after a restart may have been reused by the OS
 *   for an unrelated process, so it must never be trusted.
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
 * Fully stop a preview: kill the whole process tree, wait for exit,
 * remove the temp SQLite (+WAL/SHM) and mark the registry row stopped.
 */
export async function stopPreview(
  db: ToolContext['db'],
  projectId: string,
  reason: string,
): Promise<void> {
  const child = children.get(projectId);
  const row = getPreview(db, projectId);
  const pid = child?.pid ?? row?.pid ?? null;

  if (child) {
    killTreeByPid(child.pid);
    children.delete(projectId);
  } else if (pid) {
    killTreeByPid(pid);
  }
  if (pid) await waitPidGone(pid);

  const tmpDir = row?.tmp_dir ?? null;
  cleanupTmpDir(tmpDir);
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
 * Mark a preview as failed because its backend is unreachable (called by the
 * Studio proxy when the upstream connection fails, and by the exit watcher
 * inside the owning worker). Clears pid/port, removes the temp SQLite
 * (+WAL/SHM). NEVER kills a process: only the owning worker lifetime may
 * kill, and here the backend is already known-dead.
 */
export function markPreviewFailed(db: ToolContext['db'], projectId: string, reason: string): void {
  const row = getPreview(db, projectId);
  if (!row) return;
  children.delete(projectId); // drop any stale handle; no kill from here
  cleanupTmpDir(row.tmp_dir);
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
    // If the backend dies at any point after going ready, the registry must
    // stop claiming a live preview: mark failed, clear pid/port, clean the
    // temp SQLite (+WAL/SHM) and drop the process handle. Intentional stops
    // (stopPreview) remove the handle from the map first, so this is a no-op
    // for them.
    const current = children.get(projectId);
    if (current === child) {
      const row = getPreview(ctx.db, projectId);
      if (row && row.status === 'ready') {
        markPreviewFailed(
          ctx.db,
          projectId,
          sanitizeSecrets(`preview backend exited unexpectedly (code=${code} signal=${signal}) stdout=${stdout} stderr=${stderr}`.slice(0, 2000)),
        );
      } else {
        children.delete(projectId);
      }
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
