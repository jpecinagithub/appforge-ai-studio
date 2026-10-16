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

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolResult } from 'appforge-shared';
import type { ToolDef } from './llm.js';
import { sourceFingerprint } from './fingerprint.js';
import { nowIso, type ToolContext, type ToolHandler } from './tools.js';

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
    env?: NodeJS.ProcessEnv;
    isCancelled?: () => boolean;
  },
): Promise<ProcResult> {
  const t0 = Date.now();
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
        env: opts.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
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
    const done = (code: number, timedOut: boolean, cancelled: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(cancelPoll);
      if (stdoutCut) stdout += `\n…[stdout truncated at ${MAX_STREAM_BYTES} bytes]`;
      if (stderrCut) stderr += `\n…[stderr truncated at ${MAX_STREAM_BYTES} bytes]`;
      resolve({ code, stdout, stderr, durationMs: Date.now() - t0, timedOut, cancelled });
    };
    const kill = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    };
    const timer = setTimeout(() => {
      kill();
      done(1, true, false);
    }, Math.max(1000, opts.timeoutMs));
    const cancelPoll = setInterval(() => {
      let cancel = false;
      try {
        cancel = opts.isCancelled?.() === true;
      } catch {
        cancel = false;
      }
      if (cancel) {
        kill();
        done(1, false, true);
      }
    }, CANCEL_POLL_MS);
    child.on('error', (e) => {
      stderr += `spawn error: ${(e as Error)?.message ?? String(e)}`;
      done(1, false, false);
    });
    child.on('close', (code) => done(code ?? 1, false, false));
  });
}

// ---------------------------------------------------------------------------
// Secret sanitization for logs
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/((?:password|passwd|pwd|client[_-]secret|api[_-]key)["']?\s*[:=]\s*['"]?)[^\s"',}\]]+/gi, '$1[redacted]'],
  [/(authorization\s*[:=]\s*['"]?)(bearer\s+)?[A-Za-z0-9\-._~+/=]{8,}/gi, '$1[redacted]'],
  [/(af_session=)[^;\s"']+/gi, '$1[redacted]'],
  [/(set-cookie\s*:[^\r\n]*?af_session=)[^;\s]+/gi, '$1[redacted]'],
  [/(cookie\s*:\s*)[^\r\n]+/gi, '$1[redacted]'],
  [/((?:session[_-]?token|auth[_-]?token)["']?\s*[:=]\s*['"]?)[A-Za-z0-9\-._~+/=]{8,}/gi, '$1[redacted]'],
];

/** Remove passwords, cookies, tokens and secrets from captured logs. */
export function sanitizeSecrets(s: string): string {
  let out = s;
  for (const [re, replacement] of SECRET_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, replacement);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function fail(code: string, error: string, durationMs = 0, output?: string): ToolResult {
  const r: ToolResult = { ok: false, code, error, durationMs };
  if (output !== undefined) r.output = output;
  return r;
}

function isDynamicProject(ctx: ToolContext): boolean {
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

function setCheck(ctx: ToolContext, key: 'frontendBuild' | 'backendBuild' | 'migrations' | 'apiTests', fingerprint: string): void {
  ctx.dynamicChecks = { ...ctx.dynamicChecks, [key]: fingerprint };
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
    const fingerprint = sourceFingerprint(cwd);
    setCheck(ctx, opts.checkKey, fingerprint);
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

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-migrate-'));
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
        env: { ...process.env, DB_PATH: dbPath },
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
    setCheck(ctx, 'migrations', sourceFingerprint(migrationsDir));
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
    setCheck(ctx, 'apiTests', sourceFingerprint(projectRoot));
    return { ok: true, data: counts ?? { tests: 0, pass: 0, fail: 0 }, durationMs, output };
  } catch (e) {
    const durationMs = Date.now() - t0;
    const message = (e as Error)?.message ?? String(e);
    const clean = sanitizeSecrets(trunc(`unexpected error: ${message}`));
    return fail('API_TESTS_EXCEPTION', message, durationMs, clean);
  }
}

// ---------------------------------------------------------------------------
// Verification receipts: invalidate checks when sources change afterwards.
// ---------------------------------------------------------------------------

export type DynamicCheckKey = 'frontendBuild' | 'backendBuild' | 'migrations' | 'apiTests';

function checkScopes(projectDir: string): Record<DynamicCheckKey, string> {
  return {
    frontendBuild: path.join(projectDir, 'frontend'),
    backendBuild: path.join(projectDir, 'backend'),
    migrations: path.join(projectDir, 'migrations'),
    apiTests: projectDir,
  };
}

function currentFingerprint(dir: string): string | null {
  try {
    return sourceFingerprint(dir);
  } catch {
    return null;
  }
}

/**
 * Drop every stored receipt whose sources changed since the check ran.
 * Called by the agent loop after any file modification on a dynamic project.
 */
export function invalidateDynamicChecks(ctx: ToolContext): void {
  if (!ctx.dynamicChecks) return;
  const scopes = checkScopes(ctx.projectDir);
  for (const [key, dir] of Object.entries(scopes) as Array<[DynamicCheckKey, string]>) {
    const stored = ctx.dynamicChecks[key];
    if (stored === undefined) continue;
    if (currentFingerprint(dir) !== stored) delete ctx.dynamicChecks[key];
  }
}

/** Which of the four checks are currently valid on the current sources. */
export function dynamicChecksStatus(ctx: ToolContext): { complete: boolean; missing: DynamicCheckKey[] } {
  const scopes = checkScopes(ctx.projectDir);
  const missing: DynamicCheckKey[] = [];
  for (const [key, dir] of Object.entries(scopes) as Array<[DynamicCheckKey, string]>) {
    const stored = ctx.dynamicChecks?.[key];
    if (stored === undefined || currentFingerprint(dir) !== stored) missing.push(key);
  }
  return { complete: missing.length === 0, missing };
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
];

export function createDynamicTools(): Record<string, ToolHandler> {
  return {
    run_frontend_build: runFrontendBuild,
    run_backend_build: runBackendBuild,
    run_migrations: runMigrations,
    run_api_tests: runApiTests,
  };
}
