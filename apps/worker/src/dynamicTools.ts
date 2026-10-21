/**
 * Fase 5A — deterministic local tools for dynamic projects (CONTRACT.md §9.17).
 *
 * Four operations, no shell, no LLM-provided paths/commands/SQL:
 *   run_frontend_build, run_backend_build, run_migrations, run_api_tests
 *
 * Common rules, enforced in code (never in the prompt):
 * - They run only on the active project; every path is derived from the
 *   ToolContext. The LLM provides no cwd, no paths, no commands.
 * - Static projects are rejected with a structured NOT_DYNAMIC_PROJECT error.
 * - Commands are spawned WITHOUT a shell from a closed, hard-coded list.
 * - Every run has a timeout and honours cancellation (ctx.isCancelled).
 * - stdout/stderr are captured with a size cap and secrets are sanitized.
 * - tool_call / tool_result events are emitted by the agent loop (agent.ts).
 * - Structured ToolResult: ok, code, durationMs, limited output, clear diagnostics.
 * - Source files are never deleted when a tool fails.
 * - Observability rows always reach a terminal state (try/finally); rows left
 *   running by a process restart are reconciled to failed by the server.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { ToolResult } from 'appforge-shared';
import type { ToolDef } from './llm.js';
import { sourceFingerprint } from './fingerprint.js';
import { nowIso, type ToolContext, type ToolHandler } from './tools.js';
import {
  deleteVerificationReceipts,
  listVerificationReceipts,
  recordVerificationReceipt,
} from './deploy/receipts.js';

// ---------------------------------------------------------------------------
// Minimal allowlisted child environment.
//
// Generated code must never see the Studio's secrets: the child gets only
// the variables npm/node need to run, plus an explicit per-call allowlist
// (currently just DB_PATH). Everything else (GROQ_API_KEY,
// OPENROUTER_API_KEY, APPFORGE_ADMIN_TOKEN, …) is dropped.
// ---------------------------------------------------------------------------

/** Environment variables npm/node need to function (cross-platform). */
const ALLOWED_ENV_KEYS = new Set([
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'OS',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'PROGRAMDATA',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LANGUAGE',
  'TERM',
  'CI',
  'NPM_CONFIG_CACHE',
  'NPM_CONFIG_PREFIX',
]);

/** Extra per-call variables the tools may inject (auditable, closed list). */
const ALLOWED_EXTRA_ENV_KEYS = new Set(['DB_PATH', 'PORT', 'HOST', 'NODE_ENV', 'PUBLIC_PATH', 'SESSION_COOKIE_NAME']);

export function buildChildEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // Studio itself runs with NODE_ENV=production, but build/install commands
  // need devDependencies (TypeScript, Vite and React declarations). Never
  // inherit the host value: generated runtime processes override this
  // explicitly with NODE_ENV=test/production where appropriate.
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'development' };
  for (const k of ALLOWED_ENV_KEYS) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) {
    if (!ALLOWED_EXTRA_ENV_KEYS.has(k)) throw new Error(`env key not allowlisted: ${k}`);
    env[k] = v;
  }
  return env;
}

// ---------------------------------------------------------------------------
// Process tree teardown.
//
// child.kill() only terminates the direct child: npm spawns grandchildren
// (sh → node) that would survive on every OS, and especially on Windows.
// Kill the whole tree, then wait for it to actually exit.
// ---------------------------------------------------------------------------

/** Kill a whole process tree by pid (POSIX process group / Windows taskkill /T). */
export function killTreeByPid(pid: number | undefined | null): void {
  if (pid === undefined || pid === null) return;
  try {
    if (process.platform === 'win32') {
      // /T terminates the tree rooted at pid.
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      // Negative pid = the whole process group (spawned detached below).
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

function killTree(child: ChildProcess): void {
  killTreeByPid(child.pid);
}

// ---------------------------------------------------------------------------
// Process runner: spawn without a shell, timeout, cancellation, capped output
// ---------------------------------------------------------------------------

export interface ProcResult {
  code: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
}

const MAX_STREAM_BYTES = 512 * 1024; // per-stream capture cap
const TRUNC_CHARS = 20_000; // tool output cap (matches tools.ts)
const CANCEL_POLL_MS = 250;

function trunc(s: string): string {
  return s.length > TRUNC_CHARS ? s.slice(0, TRUNC_CHARS) + `\n…[truncated ${s.length - TRUNC_CHARS} chars]` : s;
}

/**
 * Spawn a command WITHOUT a shell. `cmd`/`args` always come from closed
 * lists hard-coded below — never from tool arguments.
 */
export async function runLive(
  cmd: string,
  args: readonly string[],
  opts: {
    cwd: string;
    timeoutMs: number;
    /** Extra variables for the child (closed allowlist: DB_PATH). */
    extraEnv?: Record<string, string>;
    isCancelled?: () => boolean;
  },
): Promise<ProcResult> {
  const t0 = Date.now();
  // Revisión Codex (Fase 6): chequeo SÍNCRONO antes de spawnear. Sin él,
  // una cancelación ya solicitada compite con el poll de 250 ms: si el
  // proceso termina antes del primer tick, la cancelación se pierde (flake
  // `cancellation produces BUILD_CANCELLED`). Ahora es determinista.
  try {
    if (opts.isCancelled?.() === true) {
      return Promise.resolve({
        code: 1,
        stdout: '',
        stderr: '',
        durationMs: 0,
        timedOut: false,
        cancelled: true,
      });
    }
  } catch {
    /* un hook de cancelación roto no debe tumbar la herramienta */
  }
  // Windows cannot execute npm.cmd/npx.cmd with shell:false. Invoke their
  // JavaScript entry point with the current Node binary instead (same as
  // runCmd in tools.ts).
  let executable = cmd;
  let executableArgs = [...args];
  if (process.platform === 'win32' && /^(npm|npx)$/i.test(cmd)) {
    const bin = cmd.toLowerCase();
    const fromEnv = bin === 'npm' ? process.env.npm_execpath : process.env.npx_execpath;
    const cli = fromEnv ?? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', `${bin}-cli.js`);
    executable = process.execPath;
    executableArgs = [cli, ...args];
  }
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(executable, executableArgs, {
        cwd: opts.cwd,
        env: buildChildEnv(opts.extraEnv),
        stdio: ['ignore', 'pipe', 'pipe'],
        // Detached on POSIX so the timeout/cancel path can SIGKILL the whole
        // process group (npm → sh → node). On Windows killTree uses taskkill.
        detached: process.platform !== 'win32',
      });
    } catch (e) {
      resolve({
        code: 1,
        stdout: '',
        stderr: `spawn failed: ${(e as Error)?.message ?? String(e)}`,
        durationMs: Date.now() - t0,
        timedOut: false,
        cancelled: false,
      });
      return;
    }
    let stdout = '';
    let stderr = '';
    let stdoutCut = false;
    let stderrCut = false;
    const feed = (which: 'out' | 'err', chunk: Buffer | string) => {
      const s = chunk.toString();
      if (which === 'out') {
        if (stdout.length < MAX_STREAM_BYTES) stdout += s.slice(0, MAX_STREAM_BYTES - stdout.length);
        else stdoutCut = true;
      } else {
        if (stderr.length < MAX_STREAM_BYTES) stderr += s.slice(0, MAX_STREAM_BYTES - stderr.length);
        else stderrCut = true;
      }
    };
    child.stdout?.on('data', (d) => feed('out', d));
    child.stderr?.on('data', (d) => feed('err', d));
    let settled = false;
    // Set by terminate() before killing, so the 'close' handler below reports
    // the right reason even though it was registered first.
    let endTimedOut = false;
    let endCancelled = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const done = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(cancelPoll);
      if (grace) clearTimeout(grace);
      if (stdoutCut) stdout += `\n…[stdout truncated at ${MAX_STREAM_BYTES} bytes]`;
      if (stderrCut) stderr += `\n…[stderr truncated at ${MAX_STREAM_BYTES} bytes]`;
      resolve({ code, stdout, stderr, durationMs: Date.now() - t0, timedOut: endTimedOut, cancelled: endCancelled });
    };
    /**
     * Terminate the whole process tree, then wait until it is actually gone
     * (or a grace period elapses) before reporting. This guarantees no
     * orphaned grandchildren and no locked SQLite files after
     * timeout/cancellation.
     */
    const terminate = (timedOut: boolean, cancelled: boolean) => {
      if (settled) return;
      endTimedOut = timedOut;
      endCancelled = cancelled;
      killTree(child);
      grace = setTimeout(() => done(1), 5000);
    };
    const timer = setTimeout(() => {
      terminate(true, false);
    }, Math.max(1000, opts.timeoutMs));
    const cancelPoll = setInterval(() => {
      let cancel = false;
      try {
        cancel = opts.isCancelled?.() === true;
      } catch {
        cancel = false;
      }
      if (cancel) {
        terminate(false, true);
      }
    }, CANCEL_POLL_MS);
    child.on('error', (e) => {
      stderr += `spawn error: ${(e as Error)?.message ?? String(e)}`;
      done(1);
    });
    child.on('close', (code) => done(code ?? 1));
  });
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Secret sanitization for logs (single home: ./secrets.js; re-exported here
// so existing `import { sanitizeSecrets } from './dynamicTools.js'` keep
// working, e.g. the Fase 6 deploy pipeline).
// ---------------------------------------------------------------------------

import { sanitizeSecrets } from './secrets.js';
export { sanitizeSecrets };

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function fail(code: string, error: string, durationMs = 0, output?: string): ToolResult {
  const r: ToolResult = { ok: false, code, error: sanitizeSecrets(error), durationMs };
  if (output !== undefined) r.output = output;
  return r;
}

export function isDynamicProject(ctx: ToolContext): boolean {
  try {
    const row = ctx.db
      .prepare('SELECT type FROM projects WHERE id=?')
      .get(ctx.projectId) as { type?: string } | undefined;
    return row?.type === 'dynamic';
  } catch {
    return false;
  }
}

function requireDynamic(ctx: ToolContext, t0: number): ToolResult | null {
  if (isDynamicProject(ctx)) return null;
  return fail(
    'NOT_DYNAMIC_PROJECT',
    'This tool only runs on dynamic projects (project type must be "dynamic").',
    Date.now() - t0,
  );
}

function requireFile(absPath: string, relLabel: string, code: string, t0: number): ToolResult | null {
  if (fs.existsSync(absPath)) return null;
  return fail(code, `required file is missing: ${relLabel}`, Date.now() - t0);
}

function dirSize(dir: string): number {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSize(p);
    else if (e.isFile()) total += fs.statSync(p).size;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Observability: builds rows (shared with the static pipeline) and the
// CONTRACT.md §9.14 migrations table.
// ---------------------------------------------------------------------------

function insertBuildRow(ctx: ToolContext, kind: string): string {
  const id = randomUUID();
  ctx.db
    .prepare(
      'INSERT INTO builds(id, project_id, status, started_at, finished_at, duration_ms, logs, artifacts_json, error) VALUES (?,?,?,?,?,?,?,?,?)',
    )
    .run(id, ctx.projectId, 'running', nowIso(), null, null, '', JSON.stringify({ kind }), null);
  return id;
}

function finishBuildRow(
  ctx: ToolContext,
  id: string,
  status: 'success' | 'failed',
  logs: string,
  artifacts: unknown,
  error: string | null,
  durationMs: number,
): void {
  ctx.db
    .prepare('UPDATE builds SET status=?, finished_at=?, duration_ms=?, logs=?, artifacts_json=?, error=? WHERE id=?')
    .run(status, nowIso(), durationMs, logs, artifacts ? JSON.stringify(artifacts) : null, error, id);
}

/** CONTRACT.md §9.14 — created here too so the worker never assumes the server ran first. */
export function ensureMigrationsTable(db: { exec: (sql: string) => void }): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS migrations(
  id TEXT PRIMARY KEY, project_id TEXT, version INTEGER, name TEXT,
  status TEXT, started_at TEXT, finished_at TEXT,
  duration_ms INTEGER, logs TEXT, error TEXT);
CREATE INDEX IF NOT EXISTS idx_migrations_project ON migrations(project_id, started_at);`);
}

interface MigrationRow {
  id: string;
  file: string;
}

function insertMigrationRows(ctx: ToolContext, files: string[], startedAt: string): MigrationRow[] {
  const stmt = ctx.db.prepare(
    'INSERT INTO migrations(id, project_id, version, name, status, started_at, finished_at, duration_ms, logs, error) VALUES (?,?,?,?,?,?,?,?,?,?)',
  );
  return files.map((file) => {
    const id = randomUUID();
    const m = file.match(/^(\d+)_/);
    const version = m ? parseInt(m[1]!, 10) : null;
    stmt.run(id, ctx.projectId, version, file, 'running', startedAt, null, null, '', null);
    return { id, file };
  });
}

function finalizeMigrationRow(
  ctx: ToolContext,
  id: string,
  status: 'success' | 'failed',
  logs: string,
  error: string | null,
  durationMs: number,
): void {
  ctx.db
    .prepare('UPDATE migrations SET status=?, finished_at=?, duration_ms=?, logs=?, error=? WHERE id=?')
    .run(status, nowIso(), durationMs, logs, error, id);
}

function deleteMigrationRow(ctx: ToolContext, id: string): void {
  ctx.db.prepare('DELETE FROM migrations WHERE id=?').run(id);
}

// ---------------------------------------------------------------------------
// run_frontend_build / run_backend_build
// ---------------------------------------------------------------------------

async function runStackBuild(
  ctx: ToolContext,
  opts: {
    /** 'frontend' | 'backend' — selects the subdirectory and expected output */
    stack: 'frontend' | 'backend';
    expectedOutput: string; // relative to the stack dir, e.g. dist/index.html
    outputCode: string; // e.g. FRONTEND_BUILD_NO_OUTPUT
    installCode: string; // e.g. FRONTEND_INSTALL_FAILED
    buildCode: string; // e.g. FRONTEND_BUILD_FAILED
    checkKey: 'frontendBuild' | 'backendBuild';
  },
): Promise<ToolResult> {
  const t0 = Date.now();
  const notDynamic = requireDynamic(ctx, t0);
  if (notDynamic) return notDynamic;
  const cwd = path.join(ctx.projectDir, opts.stack);
  const missing = requireFile(path.join(cwd, 'package.json'), `${opts.stack}/package.json`, 'MISSING_PACKAGE_JSON', t0)
    ?? requireFile(path.join(cwd, 'package-lock.json'), `${opts.stack}/package-lock.json`, 'MISSING_LOCKFILE', t0);
  if (missing) return missing;

  let buildId: string | null = null;
  try {
    buildId = insertBuildRow(ctx, opts.stack);
    const finish = (status: 'success' | 'failed', logs: string, artifacts: unknown, error: string | null, durationMs: number) => {
      try {
        finishBuildRow(ctx, buildId as string, status, logs, artifacts, error, durationMs);
      } catch {
        /* observability must never break the tool result */
      }
    };
    const fingerprintBefore = sourceFingerprint(cwd);
    // Closed command list: exactly `npm ci` then `npm run build`. No shell,
    // no arguments from the model.
    const steps: Array<{ cmd: string; args: string[]; label: string }> = [
      { cmd: 'npm', args: ['ci', '--no-audit', '--no-fund'], label: '$ npm ci' },
      { cmd: 'npm', args: ['run', 'build'], label: '$ npm run build' },
    ];
    let output = '';
    for (const step of steps) {
      const r = await runLive(step.cmd, step.args, {
        cwd,
        timeoutMs: ctx.buildTimeoutMs,
        isCancelled: ctx.isCancelled,
      });
      output += `${step.label}\n${r.stdout}\n${r.stderr}\n`;
      if (r.cancelled) {
        const clean = sanitizeSecrets(trunc(output));
        finish('failed', clean, { kind: opts.stack }, 'cancelled', r.durationMs);
        return fail('BUILD_CANCELLED', `${opts.stack} build cancelled`, r.durationMs, clean);
      }
      if (r.timedOut) {
        const clean = sanitizeSecrets(trunc(output));
        finish('failed', clean, { kind: opts.stack }, 'build timed out', r.durationMs);
        return fail('BUILD_TIMEOUT', `${opts.stack} build timed out after ${ctx.buildTimeoutMs}ms`, r.durationMs, clean);
      }
      if (r.code !== 0) {
        const clean = sanitizeSecrets(trunc(output));
        const code = step.label === '$ npm ci' ? opts.installCode : opts.buildCode;
        const what = step.label === '$ npm ci' ? 'dependency installation' : 'build';
        finish('failed', clean, { kind: opts.stack }, `${what} exited with code ${r.code}`, r.durationMs);
        return fail(code, `${opts.stack} ${what} exited with code ${r.code}`, r.durationMs, clean);
      }
    }
    const distFile = path.join(cwd, opts.expectedOutput);
    if (!fs.existsSync(distFile)) {
      const clean = sanitizeSecrets(trunc(output));
      finish('failed', clean, { kind: opts.stack }, `build succeeded but ${opts.expectedOutput} is missing`, Date.now() - t0);
      return fail(opts.outputCode, `build succeeded but ${opts.expectedOutput} is missing`, Date.now() - t0, clean);
    }
    if (sourceFingerprint(cwd) !== fingerprintBefore) {
      const clean = sanitizeSecrets(trunc(output));
      finish('failed', clean, { kind: opts.stack }, 'source files changed during build; rebuild required', Date.now() - t0);
      return fail('BUILD_SOURCE_CHANGED', 'source files changed during build; rebuild required', Date.now() - t0, clean);
    }
    const size = dirSize(path.join(cwd, path.dirname(opts.expectedOutput)));
    recordDynamicCheck(ctx, opts.checkKey);
    const durationMs = Date.now() - t0;
    const clean = sanitizeSecrets(trunc(output));
    finish('success', clean, { kind: opts.stack, distSize: size }, null, durationMs);
    // Never starts a dev server: only `npm ci` + `npm run build` run above.
    return { ok: true, data: { output: opts.expectedOutput, distSize: size, buildId }, durationMs, output: clean };
  } catch (e) {
    const durationMs = Date.now() - t0;
    const message = (e as Error)?.message ?? String(e);
    const clean = sanitizeSecrets(trunc(`unexpected error: ${message}`));
    try {
      // buildId may be null if the insert itself threw; UPDATE then affects 0 rows.
      if (buildId) finishBuildRow(ctx, buildId, 'failed', clean, { kind: opts.stack }, message, durationMs);
    } catch {
      /* observability must never break the tool result */
    }
    return fail('BUILD_EXCEPTION', message, durationMs, clean);
  }
}

async function runFrontendBuild(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  void args; // no arguments accepted: paths and commands are derived internally
  return runStackBuild(ctx, {
    stack: 'frontend',
    expectedOutput: path.join('dist', 'index.html'),
    outputCode: 'FRONTEND_BUILD_NO_OUTPUT',
    installCode: 'FRONTEND_INSTALL_FAILED',
    buildCode: 'FRONTEND_BUILD_FAILED',
    checkKey: 'frontendBuild',
  });
}

async function runBackendBuild(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  void args;
  return runStackBuild(ctx, {
    stack: 'backend',
    expectedOutput: path.join('dist', 'server.js'),
    outputCode: 'BACKEND_BUILD_NO_OUTPUT',
    installCode: 'BACKEND_INSTALL_FAILED',
    buildCode: 'BACKEND_BUILD_FAILED',
    checkKey: 'backendBuild',
  });
}

// ---------------------------------------------------------------------------
// run_migrations — fixed `npm run migrate` against a TEMPORARY verification
// SQLite database. Never touches a live database or Docker volume.
// ---------------------------------------------------------------------------

const MIGRATION_FILE_RE = /^\d+_.+\.sql$/;

function parseMigrationLog(output: string): {
  newlyApplied: string[];
  alreadyApplied: string[];
  failedFile: string | null;
  checksumFile: string | null;
} {
  const newlyApplied: string[] = [];
  const alreadyApplied: string[] = [];
  for (const m of output.matchAll(/^(?:already applied|applied):\s*(\S+\.sql)/gm)) {
    if (m[0]!.startsWith('already')) alreadyApplied.push(m[1]!);
    else newlyApplied.push(m[1]!);
  }
  const checksumFile = output.match(/MIGRATION_CHECKSUM_MISMATCH:\s*(\S+\.sql)/)?.[1] ?? null;
  let failedFile: string | null = checksumFile;
  if (!failedFile) {
    const applying: string[] = [];
    for (const m of output.matchAll(/applying migration\s+(\S+\.sql)/g)) applying.push(m[1]!);
    const doneSet = new Set([...newlyApplied, ...alreadyApplied]);
    const notApplied = applying.filter((f) => !doneSet.has(f));
    failedFile = notApplied.length > 0 ? notApplied[notApplied.length - 1]! : null;
  }
  return { newlyApplied, alreadyApplied, failedFile, checksumFile };
}

async function runMigrations(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const t0 = Date.now();
  void args;
  const notDynamic = requireDynamic(ctx, t0);
  if (notDynamic) return notDynamic;
  const projectRoot = ctx.projectDir;
  const migrationsDir = path.join(projectRoot, 'migrations');
  const missingPkg = requireFile(path.join(projectRoot, 'package.json'), 'package.json', 'MISSING_PACKAGE_JSON', t0);
  if (missingPkg) return missingPkg;
  let files: string[];
  try {
    files = fs.readdirSync(migrationsDir).filter((f) => MIGRATION_FILE_RE.test(f)).sort();
  } catch {
    return fail('MISSING_MIGRATIONS_DIR', 'migrations/ directory is missing', Date.now() - t0);
  }
  if (files.length === 0) return fail('NO_MIGRATIONS', 'no migration files found in migrations/', Date.now() - t0);

  // Pid-unique prefix: test files run in parallel workers sharing tmpdir().
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `af-migrate-${process.pid}-`));
  const dbPath = path.join(tmpDir, 'verify.db');
  const cleanupTemp = () => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  };

  try {
    ensureMigrationsTable(ctx.db);

    /**
     * One pass = one `npm run migrate` execution with its own observability
     * rows. Every exit path leaves its rows terminal (success/failed, or
     * deleted when the file was never attempted).
     */
    const runPass = async (
      label: string,
    ): Promise<{
      ok: boolean;
      result: ToolResult;
      newlyApplied: string[];
      alreadyApplied: string[];
    }> => {
      const passT0 = Date.now();
      let passRows: MigrationRow[];
      try {
        passRows = insertMigrationRows(ctx, files, nowIso());
      } catch (e) {
        const msg = `could not record migration run: ${(e as Error)?.message ?? String(e)}`;
        return { ok: false, result: fail('MIGRATIONS_EXCEPTION', msg, Date.now() - t0), newlyApplied: [], alreadyApplied: [] };
      }
      // Closed command: exactly `npm run migrate`. No shell, no model input.
      const r = await runLive('npm', ['run', 'migrate'], {
        cwd: projectRoot,
        timeoutMs: ctx.buildTimeoutMs,
        isCancelled: ctx.isCancelled,
        extraEnv: { DB_PATH: dbPath },
      });
      const durationMs = Date.now() - passT0;
      const totalMs = Date.now() - t0;
      const header = `$ npm run migrate (${label})`;
      const failed = (code: string, error: string, clean: string) => {
        for (const row of passRows) {
          try {
            finalizeMigrationRow(ctx, row.id, 'failed', clean, error, durationMs);
          } catch {
            /* observability must never break the tool result */
          }
        }
        return { ok: false as const, result: fail(code, error, totalMs, clean), newlyApplied: [] as string[], alreadyApplied: [] as string[] };
      };
      if (r.cancelled) {
        return failed('MIGRATIONS_CANCELLED', `migrations cancelled during ${label}`, sanitizeSecrets(trunc(`${header}\n${r.stdout}\n${r.stderr}`)));
      }
      if (r.timedOut) {
        return failed(
          'MIGRATIONS_TIMEOUT',
          `migrations timed out after ${ctx.buildTimeoutMs}ms during ${label}`,
          sanitizeSecrets(trunc(`${header}\n${r.stdout}\n${r.stderr}`)),
        );
      }
      const output = sanitizeSecrets(trunc(`${header}\n${r.stdout}\n${r.stderr}`));
      const parsed = parseMigrationLog(output);
      const doneSet = new Set([...parsed.newlyApplied, ...parsed.alreadyApplied]);
      const settleRows = (succeeded: boolean) => {
        for (const row of passRows) {
          try {
            if (doneSet.has(row.file)) {
              finalizeMigrationRow(ctx, row.id, 'success', output, null, durationMs);
            } else if (parsed.checksumFile !== null && row.file === parsed.checksumFile) {
              finalizeMigrationRow(ctx, row.id, 'failed', output, `MIGRATION_CHECKSUM_MISMATCH: ${row.file} changed after being applied`, durationMs);
            } else if (parsed.checksumFile === null && row.file === parsed.failedFile) {
              finalizeMigrationRow(ctx, row.id, 'failed', output, `migration failed: ${row.file}`, durationMs);
            } else if (!succeeded) {
              deleteMigrationRow(ctx, row.id); // never attempted: no fake terminal state
            } else {
              finalizeMigrationRow(ctx, row.id, 'success', output, null, durationMs);
            }
          } catch {
            /* observability must never break the tool result */
          }
        }
      };
      if (r.code !== 0) {
        if (parsed.checksumFile !== null) {
          settleRows(false);
          return {
            ok: false,
            result: fail(
              'MIGRATION_CHECKSUM_MISMATCH',
              `${parsed.checksumFile} changed after being applied — refusing to continue`,
              totalMs,
              output,
            ),
            newlyApplied: parsed.newlyApplied,
            alreadyApplied: parsed.alreadyApplied,
          };
        }
        settleRows(false);
        const detail = parsed.failedFile ? ` (failed at ${parsed.failedFile})` : '';
        return {
          ok: false,
          result: fail('MIGRATIONS_FAILED', `npm run migrate exited with code ${r.code}${detail} during ${label}`, totalMs, output),
          newlyApplied: parsed.newlyApplied,
          alreadyApplied: parsed.alreadyApplied,
        };
      }
      settleRows(true);
      return { ok: true, result: { ok: true, durationMs: totalMs, output }, newlyApplied: parsed.newlyApplied, alreadyApplied: parsed.alreadyApplied };
    };

    // Pass 1: apply on the empty verification database.
    const pass1 = await runPass('apply');
    if (!pass1.ok) {
      cleanupTemp();
      return pass1.result;
    }
    // Pass 2: idempotency — re-running against the same database must
    // succeed while applying nothing new.
    const pass2 = await runPass('idempotency check');
    if (!pass2.ok) {
      cleanupTemp();
      return pass2.result;
    }
    if (pass2.newlyApplied.length > 0) {
      cleanupTemp();
      return fail(
        'MIGRATIONS_NOT_IDEMPOTENT',
        `second migrate run applied new migrations (${pass2.newlyApplied.join(', ')}) — migrations must be idempotent`,
        Date.now() - t0,
        pass2.result.output,
      );
    }
    recordDynamicCheck(ctx, 'migrations');
    cleanupTemp();
    const durationMs = Date.now() - t0;
    return {
      ok: true,
      data: { files, applied: pass1.newlyApplied, idempotent: true },
      durationMs,
      output: sanitizeSecrets(trunc(`${pass1.result.output ?? ''}\n${pass2.result.output ?? ''}`)),
    };
  } catch (e) {
    const durationMs = Date.now() - t0;
    const message = (e as Error)?.message ?? String(e);
    const clean = sanitizeSecrets(trunc(`unexpected error: ${message}`));
    cleanupTemp();
    return fail('MIGRATIONS_EXCEPTION', message, durationMs, clean);
  }
}

// ---------------------------------------------------------------------------
// run_api_tests — fixed `npm test` with a temporary SQLite database.
// ---------------------------------------------------------------------------

function parseTestCounts(output: string): { tests: number; pass: number; fail: number } | null {
  const pick = (label: string): number | null => {
    const anchored = output.match(new RegExp(`^ℹ\\s+${label}\\s+(\\d+)`, 'm'))?.[1];
    if (anchored !== undefined) return Number(anchored);
    const loose = output.match(new RegExp(`${label}\\s+(\\d+)`))?.[1];
    return loose !== undefined ? Number(loose) : null;
  };
  const tests = pick('tests');
  if (tests === null) return null;
  return { tests, pass: pick('pass') ?? 0, fail: pick('fail') ?? 0 };
}

async function runApiTests(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const t0 = Date.now();
  void args;
  const notDynamic = requireDynamic(ctx, t0);
  if (notDynamic) return notDynamic;
  const projectRoot = ctx.projectDir;
  const missingPkg = requireFile(path.join(projectRoot, 'package.json'), 'package.json', 'MISSING_PACKAGE_JSON', t0);
  if (missingPkg) return missingPkg;
  const missingTests = requireFile(path.join(projectRoot, 'tests'), 'tests/', 'MISSING_TESTS_DIR', t0);
  if (missingTests) return missingTests;

  try {
    // Closed command: exactly `npm test`. The template's own test suite
    // boots the backend against a throwaway SQLite database per run, so no
    // data is ever reused between executions and no live DB is touched.
    const r = await runLive('npm', ['test'], {
      cwd: projectRoot,
      timeoutMs: ctx.buildTimeoutMs,
      isCancelled: ctx.isCancelled,
    });
    const durationMs = Date.now() - t0;
    const output = sanitizeSecrets(trunc(`$ npm test\n${r.stdout}\n${r.stderr}`));
    const counts = parseTestCounts(output);
    const countSuffix = counts ? ` (${counts.pass}/${counts.tests} passed)` : '';
    if (r.cancelled) return fail('API_TESTS_CANCELLED', 'API tests cancelled', durationMs, output);
    if (r.timedOut) {
      return fail('API_TESTS_TIMEOUT', `API tests timed out after ${ctx.buildTimeoutMs}ms`, durationMs, output);
    }
    if (r.code !== 0) {
      const res: ToolResult = {
        ok: false,
        code: 'API_TESTS_FAILED',
        error: `npm test exited with code ${r.code}${countSuffix}`,
        durationMs,
        output,
      };
      if (counts) res.data = counts;
      return res;
    }
    recordDynamicCheck(ctx, 'apiTests');
    return { ok: true, data: counts ?? { tests: 0, pass: 0, fail: 0 }, durationMs, output };
  } catch (e) {
    const durationMs = Date.now() - t0;
    const message = (e as Error)?.message ?? String(e);
    const clean = sanitizeSecrets(trunc(`unexpected error: ${message}`));
    return fail('API_TESTS_EXCEPTION', message, durationMs, clean);
  }
}

// ---------------------------------------------------------------------------
// Verification receipts (invalidated on source change)
//
// The dynamic tools leave receipts in ctx.dynamicChecks: one fingerprint per
// check. A later source edit invalidates the earliest affected check AND
// every check that canonically follows it — the valid checks always form a
// PREFIX of DYNAMIC_CHECK_ORDER. Recording a check clears its canonical
// followers, so out-of-order execution can never accumulate: the agent is
// forced through the pipeline in order.
// dynamicGateStatus() is the code-level completion gate (the agent loop
// consults it, never just the prompt).
// ---------------------------------------------------------------------------

export type DynamicCheckKey =
  | 'frontendBuild'
  | 'backendBuild'
  | 'migrations'
  | 'apiTests'
  | 'fullstackPreview'
  | 'authenticatedFlow';

/** Canonical pipeline order. The completion gate requires exactly this. */
export const DYNAMIC_CHECK_ORDER: readonly DynamicCheckKey[] = [
  'frontendBuild',
  'backendBuild',
  'migrations',
  'apiTests',
  'fullstackPreview',
  'authenticatedFlow',
];

/** The four 5A checks: the precondition for start_fullstack_preview. */
export const DYNAMIC_CHECK_ORDER_5A: readonly DynamicCheckKey[] = [
  'frontendBuild',
  'backendBuild',
  'migrations',
  'apiTests',
];

/**
 * Source scopes each receipt covers. The migrations receipt covers
 * migrations/ + backend/ + the root package.json (whose scripts drive
 * `npm run migrate`), so a change to any of them forces re-verification.
 * fullstackPreview and authenticatedFlow verify the whole app, so their
 * receipts are bound to the project root: any source change invalidates them.
 */
function checkScopes(projectDir: string): Record<DynamicCheckKey, string[]> {
  return {
    frontendBuild: [path.join(projectDir, 'frontend')],
    backendBuild: [path.join(projectDir, 'backend')],
    migrations: [
      path.join(projectDir, 'migrations'),
      path.join(projectDir, 'backend'),
      path.join(projectDir, 'package.json'),
    ],
    apiTests: [projectDir],
    fullstackPreview: [projectDir],
    authenticatedFlow: [projectDir],
  };
}

/** Combined fingerprint over files and/or directories (missing = distinct marker). */
function scopeFingerprint(paths: string[]): string | null {
  try {
    const hash = createHash('sha256');
    for (const p of paths) {
      let st: fs.Stats | null = null;
      try {
        st = fs.statSync(p);
      } catch {
        st = null;
      }
      if (st === null) hash.update(`missing:${p}`);
      else if (st.isDirectory()) hash.update(sourceFingerprint(p));
      else if (st.isFile()) hash.update(fs.readFileSync(p));
      else hash.update(`other:${p}`);
    }
    return hash.digest('hex');
  } catch {
    return null;
  }
}

/**
 * Record a successful check: store its fingerprint and drop the check itself
 * plus its canonical followers from the order (they must be re-run after it).
 */
/** @internal exported for tests (dynamicAreas.test.ts). */
export function recordDynamicCheckForTest(ctx: ToolContext, key: DynamicCheckKey): void {
  recordDynamicCheck(ctx, key);
}

function recordDynamicCheck(ctx: ToolContext, key: DynamicCheckKey): void {
  const idx = DYNAMIC_CHECK_ORDER.indexOf(key);
  const followers = new Set(DYNAMIC_CHECK_ORDER.slice(idx + 1));
  ctx.dynamicChecksOrder = (ctx.dynamicChecksOrder ?? []).filter((k) => k !== key && !followers.has(k));
  ctx.dynamicChecksOrder.push(key);
  const checks = { ...(ctx.dynamicChecks ?? {}) };
  delete checks[key];
  for (const f of followers) delete checks[f];
  const fp = scopeFingerprint(checkScopes(ctx.projectDir)[key]);
  if (fp !== null) checks[key] = fp;
  ctx.dynamicChecks = checks;
  // Revisión Codex (Fase 6): receipt persistido autoritativo con la MISMA
  // semántica (borra el check y sus seguidores canónicos, inserta con
  // seq = índice canónico). La ruta HTTP lo exige para desplegar.
  try {
    deleteVerificationReceipts(ctx.db, ctx.projectId, [key, ...followers]);
    if (fp !== null) recordVerificationReceipt(ctx.db, ctx.projectId, key, fp, idx);
  } catch {
    /* la observabilidad persistida nunca rompe la herramienta */
  }
  // Fase 2 (Trabajo 6): avisar al orquestador de que se registró una
  // comprobación. La foto NO se crea aquí (esta función es síncrona y el
  // espacio de trabajo aún está dentro de la herramienta): el orquestador
  // la crea al terminar la herramienta que la registró, con las fuentes
  // quietas y exactamente en el estado que superó la comprobación.
  try {
    ctx.onDynamicCheckRecorded?.(key);
  } catch {
    /* un aviso roto nunca rompe la herramienta */
  }
}

/**
 * Drop the earliest check whose sources changed (canonical order), plus all
 * its followers. Call after any file mutation.
 */
export function invalidateDynamicChecks(ctx: ToolContext): void {
  // Revisión Codex (Fase 6): la invalidación persistida NO depende del
  // estado en memoria (un proceso nuevo arranca con ctx.dynamicChecks
  // vacío pero puede haber receipts de un proceso anterior).
  try {
    const persisted = listVerificationReceipts(ctx.db, ctx.projectId);
    let firstBadSeq = -1;
    for (const r of persisted) {
      if (checkScopeFingerprint(ctx.projectDir, r.checkKey) !== r.fingerprint) {
        firstBadSeq = r.seq;
        break;
      }
    }
    if (firstBadSeq >= 0) {
      deleteVerificationReceipts(ctx.db, ctx.projectId, DYNAMIC_CHECK_ORDER.slice(firstBadSeq));
    }
  } catch {
    /* la observabilidad persistida nunca rompe la herramienta */
  }
  if (!ctx.dynamicChecks) return;
  const scopes = checkScopes(ctx.projectDir);
  let firstBad = -1;
  for (let i = 0; i < DYNAMIC_CHECK_ORDER.length; i++) {
    const key = DYNAMIC_CHECK_ORDER[i]!;
    const stored = ctx.dynamicChecks[key];
    if (stored === undefined) continue;
    if (scopeFingerprint(scopes[key]) !== stored) {
      firstBad = i;
      break;
    }
  }
  if (firstBad === -1) return;
  const doomed = new Set(DYNAMIC_CHECK_ORDER.slice(firstBad));
  for (const k of doomed) delete ctx.dynamicChecks[k];
  ctx.dynamicChecksOrder = (ctx.dynamicChecksOrder ?? []).filter((k) => !doomed.has(k));
}

/**
 * Fingerprint del scope de un check (revisión Codex: expuesto para la
 * puerta persistida y sus tests).
 */
export function checkScopeFingerprint(projectDir: string, key: DynamicCheckKey): string | null {
  return scopeFingerprint(checkScopes(projectDir)[key]);
}

/**
 * Puerta de verificación AUTORITATIVA para la ruta HTTP (revisión Codex,
 * Fase 6): exige los SEIS receipts persistidos vigentes sobre las fuentes
 * actuales y en orden canónico. Sustituye la aproximación anterior (último
 * build success + migraciones success), que no verificaba orden,
 * fingerprints ni los seis checks.
 */
export function persistedDynamicGateStatus(
  db: Database.Database,
  projectDir: string,
  projectId: string,
): { ok: boolean; reason?: string } {
  const receipts = listVerificationReceipts(db, projectId);
  if (receipts.length !== DYNAMIC_CHECK_ORDER.length) {
    const have = new Set(receipts.map((r) => r.checkKey));
    const missing = DYNAMIC_CHECK_ORDER.filter((k) => !have.has(k));
    return {
      ok: false,
      reason: `missing verification receipts: ${missing.join(', ')} (run the 5A/5B verification tools in order first)`,
    };
  }
  for (let i = 0; i < DYNAMIC_CHECK_ORDER.length; i++) {
    const key = DYNAMIC_CHECK_ORDER[i]!;
    const r = receipts[i]!;
    if (r.checkKey !== key || r.seq !== i) {
      return {
        ok: false,
        reason: `verification receipts out of canonical order at position ${i} (expected '${key}' seq=${i})`,
      };
    }
    const current = checkScopeFingerprint(projectDir, key);
    if (current === null || current !== r.fingerprint) {
      return {
        ok: false,
        reason: `verification receipt '${key}' is stale: project sources changed after the check (re-run the verification tools)`,
      };
    }
  }
  return { ok: true };
}

/**
 * Code-level completion gate for dynamic projects. The agent loop blocks
 * finish unless every check is valid on the CURRENT sources AND the checks
 * were completed in canonical order. Never rely on the prompt for this.
 */
export function dynamicGateStatus(ctx: ToolContext): {
  complete: boolean;
  missing: DynamicCheckKey[];
  orderValid: boolean;
} {
  const scopes = checkScopes(ctx.projectDir);
  const missing: DynamicCheckKey[] = [];
  for (const key of DYNAMIC_CHECK_ORDER) {
    const stored = ctx.dynamicChecks?.[key];
    if (stored === undefined || scopeFingerprint(scopes[key]) !== stored) missing.push(key);
  }
  const order = ctx.dynamicChecksOrder ?? [];
  const orderValid =
    order.length === DYNAMIC_CHECK_ORDER.length &&
    DYNAMIC_CHECK_ORDER.every((k, i) => order[i] === k);
  return { complete: missing.length === 0 && orderValid, missing, orderValid };
}

/**
 * Fase 2: length of the valid prefix — how many checks, from the start of
 * the canonical order, are currently valid on the CURRENT sources. The
 * valid checks always form a prefix (the receipts invariant), so this is
 * simply the count of consecutive non-missing checks from position 0.
 * Used by the orchestrator to detect progress (Trabajo 6) and to rank
 * states (Trabajo 7), and by get_dynamic_status (Trabajo 8).
 */
export function validDynamicPrefixLength(ctx: ToolContext): number {
  const { missing } = dynamicGateStatus(ctx);
  const missingSet = new Set(missing);
  let n = 0;
  while (n < DYNAMIC_CHECK_ORDER.length && !missingSet.has(DYNAMIC_CHECK_ORDER[n])) n++;
  return n;
}

/**
 * Fase 2 (Trabajo 8) — `get_dynamic_status`: READ-ONLY view of the dynamic
 * gate for the agent itself. It runs no check, edits nothing and records
 * no receipt; it only reports what dynamicGateStatus already knows plus
 * the best state of the current run (tracked by the orchestrator and read
 * through ctx.getBestDynamicState). Per check it distinguishes:
 *  - valid:   receipt exists and its fingerprint matches current sources;
 *  - stale:   receipt exists but sources changed after it (caducada);
 *  - missing: the check never recorded a receipt on these sources.
 */
async function getDynamicStatus(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const t0 = Date.now();
  const notDynamic = requireDynamic(ctx, t0);
  if (notDynamic) return notDynamic;
  if (Object.keys(args).length > 0) {
    return fail('INVALID_ARGS', 'get_dynamic_status takes no arguments', Date.now() - t0);
  }
  const gate = dynamicGateStatus(ctx);
  const scopes = checkScopes(ctx.projectDir);
  const valid: DynamicCheckKey[] = [];
  const stale: DynamicCheckKey[] = [];
  const missing: DynamicCheckKey[] = [];
  for (const key of DYNAMIC_CHECK_ORDER) {
    const stored = ctx.dynamicChecks?.[key];
    if (stored === undefined) missing.push(key);
    else if (scopeFingerprint(scopes[key]) !== stored) stale.push(key);
    else valid.push(key);
  }
  let prefixLength = 0;
  while (prefixLength < DYNAMIC_CHECK_ORDER.length && valid[prefixLength] === DYNAMIC_CHECK_ORDER[prefixLength]) {
    prefixLength++;
  }
  const best = ctx.getBestDynamicState?.() ?? null;
  return {
    ok: true,
    data: {
      valid,
      stale,
      missing,
      prefixLength,
      prefix: DYNAMIC_CHECK_ORDER.slice(0, prefixLength),
      complete: gate.complete,
      orderValid: gate.orderValid,
      nextCheck: prefixLength < DYNAMIC_CHECK_ORDER.length ? DYNAMIC_CHECK_ORDER[prefixLength] : null,
      best,
    },
    durationMs: Date.now() - t0,
  };
}

/**
 * Fase 5B — is the fullstackPreview receipt still valid on the current
 * sources (and correctly ordered after the 5A prefix)? Used by
 * test_authenticated_flow to refuse a stale preview.
 */
export function previewReceiptValid(ctx: ToolContext): boolean {
  const stored = ctx.dynamicChecks?.fullstackPreview;
  if (!stored) return false;
  if (scopeFingerprint(checkScopes(ctx.projectDir).fullstackPreview) !== stored) return false;
  const order = ctx.dynamicChecksOrder ?? [];
  const idx = order.indexOf('fullstackPreview');
  return idx >= DYNAMIC_CHECK_ORDER_5A.length &&
    DYNAMIC_CHECK_ORDER_5A.every((k, i) => order[i] === k);
}

/**
 * Fase 5B — precondition gate for start_fullstack_preview: the four 5A
 * checks must be valid on the current sources and form the canonical
 * 5A prefix. (The full dynamicGateStatus additionally requires
 * fullstackPreview + authenticatedFlow.)
 */
export function previewGateStatus(ctx: ToolContext): {
  ok: boolean;
  missing: DynamicCheckKey[];
} {
  const scopes = checkScopes(ctx.projectDir);
  const missing: DynamicCheckKey[] = [];
  for (const key of DYNAMIC_CHECK_ORDER_5A) {
    const stored = ctx.dynamicChecks?.[key];
    if (stored === undefined || scopeFingerprint(scopes[key]) !== stored) missing.push(key);
  }
  const order = ctx.dynamicChecksOrder ?? [];
  const orderValid =
    order.length >= DYNAMIC_CHECK_ORDER_5A.length &&
    DYNAMIC_CHECK_ORDER_5A.every((k, i) => order[i] === k);
  return { ok: missing.length === 0 && orderValid, missing };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const DYNAMIC_TOOL_DEFS: ToolDef[] = [
  {
    name: 'run_frontend_build',
    description:
      'Dynamic projects only: install dependencies (npm ci) and run the production build (npm run build) in <project>/frontend. Verifies dist/index.html exists. Takes no arguments; paths and commands are fixed.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'run_backend_build',
    description:
      'Dynamic projects only: install dependencies (npm ci) and compile the backend (npm run build) in <project>/backend. Verifies dist/server.js exists. Takes no arguments; paths and commands are fixed.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'run_migrations',
    description:
      'Dynamic projects only: run the fixed `npm run migrate` twice against the SAME temporary verification SQLite database (apply pass + idempotency check; never a live database). Records per-file results in the migrations table. Takes no arguments.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'run_api_tests',
    description:
      'Dynamic projects only: run the fixed `npm test` (authentication, session, CRUD, isolation) with a temporary SQLite database. Returns pass/fail counts. Takes no arguments.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'start_fullstack_preview',
    description:
      'Dynamic projects only: launch an ephemeral full-stack preview of the CURRENT sources (no Docker, no production). Requires run_frontend_build, run_backend_build, run_migrations and run_api_tests to be valid and in order. Starts node backend/dist/server.js on a free loopback port with a temporary SQLite database, waits for /healthz, and publishes it at /a/:projectId/ through the Studio proxy. Replaces any previous preview (fully stopped first). Takes no arguments.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'test_authenticated_flow',
    description:
      'Dynamic projects only: verify the authenticated user journey against the published preview at /a/:projectId/ (never a different server). Runs deterministic API checks (register, HttpOnly+SameSite cookie, session, CRUD, cross-user isolation, logout, 401) then real Chromium against the preview UI using stable data-testid selectors. Requires a ready fullstack preview. Takes no arguments: no URLs, selectors, credentials or commands are accepted.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_dynamic_status',
    description:
      'Dynamic projects only (Fase 2): READ-ONLY status of the six-check verification gate on the CURRENT sources: which checks are valid, stale (sources changed after they passed) or missing, the current valid prefix length, the next check to run, and the best state reached this run with its automatic photo. Runs no check and changes nothing. Takes no arguments.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'deploy_project',
    description:
      'Dynamic projects only (Fase 6): run the persistent full-stack deployment pipeline (pending → building → migrating → verifying → promoting → live, with single-attempt rollback and persistent cancellation) through the configured deployment driver. Requires the 5A/5B verification gate to be current on the present sources. Deterministic: takes no arguments — no commands, paths, image names, container names or Docker arguments are accepted; all identifiers are derived internally. Refuses with DEPLOYMENT_DRIVER_NOT_CONFIGURED when no real driver is configured (never simulates a real deployment). Cannot set deployment states manually.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
];

export function createDynamicTools(): Record<string, ToolHandler> {
  return {
    run_frontend_build: runFrontendBuild,
    run_backend_build: runBackendBuild,
    run_migrations: runMigrations,
    run_api_tests: runApiTests,
    start_fullstack_preview: startFullstackPreviewTool,
    test_authenticated_flow: testAuthenticatedFlowTool,
    get_dynamic_status: getDynamicStatus,
    deploy_project: deployProjectTool,
  };
}

/** Thin wrappers: the preview/auth-flow tools live in their own modules. */
async function startFullstackPreviewTool(ctx: ToolContext, _args: Record<string, unknown>): Promise<ToolResult> {
  const { startFullstackPreview } = await import('./previewManager.js');
  return startFullstackPreview(ctx);
}

async function testAuthenticatedFlowTool(ctx: ToolContext, _args: Record<string, unknown>): Promise<ToolResult> {
  const { testAuthenticatedFlow } = await import('./authFlow.js');
  return testAuthenticatedFlow(ctx);
}

/**
 * Fase 6 — `deploy_project`: deterministic, zero free parameters. Delegates
 * exclusively to the persistent orchestrator (`runDeploymentPipeline`); the
 * agent can never set deployment states manually (no tool or HTTP route
 * exposes transitions). Refuses when no real driver is configured.
 * Does not touch the 5B preview kill switch or its guarantees.
 */
async function deployProjectTool(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const t0 = Date.now();
  const durationMs = () => Date.now() - t0;
  if (!isDynamicProject(ctx)) {
    return fail('INVALID_TYPE', 'deploy_project is only available for dynamic projects', durationMs());
  }
  if (Object.keys(args).length > 0) {
    return fail('INVALID_ARGS', 'deploy_project takes no arguments', durationMs());
  }
  const driver = ctx.deploymentDriver;
  if (!driver) {
    return fail(
      'DEPLOYMENT_DRIVER_NOT_CONFIGURED',
      'Deployment infrastructure is not configured: refusing to simulate a real deployment. Configure a real DeploymentDriver to enable deployments.',
      durationMs(),
    );
  }
  const { runDeploymentPipeline, DeploymentError } = await import('./deploy/orchestrator.js');
  const { acquireDeploymentCapacity } = await import('./deploy/driver.js');
  const releaseCapacity = acquireDeploymentCapacity(driver);
  if (!releaseCapacity) {
    return fail('DEPLOYMENT_CAPACITY', 'Deployment capacity is currently exhausted', durationMs());
  }
  try {
    const final = await runDeploymentPipeline(ctx.db, driver, {
      projectId: ctx.projectId,
      target: 'oracle',
      verificationGate: () => {
        const gate = dynamicGateStatus(ctx);
        return gate.complete
          ? { ok: true }
          : {
              ok: false,
              reason: `5A/5B verification checks are not current (missing: ${gate.missing.join(', ') || 'none'}; orderValid=${gate.orderValid}). Run the missing tools in canonical order first.`,
            };
      },
    });
    const ok = final.status === 'live';
    return {
      ok,
      code: ok ? 'DEPLOY_LIVE' : `DEPLOY_${final.status.toUpperCase()}`,
      error: ok ? undefined : (final.error ?? `deployment ended in '${final.status}'`),
      data: { deploymentId: final.id, status: final.status },
      durationMs: durationMs(),
      output: `deployment ${final.id} -> ${final.status}`,
    };
  } catch (e) {
    if (e instanceof DeploymentError) {
      return fail(e.code, e.message, durationMs());
    }
    return fail('DEPLOY_ERROR', `deployment failed: ${(e as Error).message}`.slice(0, 2000), durationMs());
  } finally {
    releaseCapacity();
  }
}
