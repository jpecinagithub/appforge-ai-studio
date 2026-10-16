/**
 * Fase 5A tests: the four deterministic dynamic tools.
 *
 * Fixture-based (no network, no real template install): each fixture mimics
 * the observable behaviour of templates/dynamic-react-node
 * (fixed scripts, log lines, exit codes, real SQLite semantics via
 * node:sqlite in the fake migrate script).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, test, afterEach } from 'vitest';
import {
  createDynamicTools,
  sanitizeSecrets,
  buildChildEnv,
  invalidateDynamicChecks,
  dynamicGateStatus,
  previewGateStatus,
  DYNAMIC_CHECK_ORDER,
  DYNAMIC_CHECK_ORDER_5A,
  ensureMigrationsTable,
} from './dynamicTools.js';
import type { ToolContext } from './tools.js';

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitPidGone(pid: number, timeoutMs = 10000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (!pidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return !pidAlive(pid);
}

// ---------------------------------------------------------------------------
// Fixtures
/** Set the fixture mode for a subdirectory root (frontend/backend/migrations). */
function setFixtureMode(root: string, mode: string): void {
  writeFileSync(path.join(root, 'fake-mode.txt'), mode);
}

// ---------------------------------------------------------------------------

const BUILD_SCRIPT = `
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.env.FAKE_BUILD_OUT ?? 'index.html';
import { existsSync as __exists, readFileSync as __read } from 'node:fs';
const mode = __exists(join(root, 'fake-mode.txt')) ? __read(join(root, 'fake-mode.txt'), 'utf8').trim() : (process.env.FAKE_BUILD_MODE ?? 'ok');
if (mode === 'fail') {
  console.error("error TS2322: Type 'string' is not assignable to type 'number'.");
  process.exit(1);
}
if (mode === 'slow') {
  // Write our pid first so tests can prove the whole process tree is dead
  // after timeout/cancellation (no orphaned grandchildren, no locked files).
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'dist', 'slow.pid'), String(process.pid));
  await new Promise((r) => setTimeout(r, 30000));
}
if (mode === 'env-dump') {
  // Proves the child environment is allowlisted: secrets must be absent.
  for (const k of ['GROQ_API_KEY', 'OPENROUTER_API_KEY', 'APPFORGE_ADMIN_TOKEN', 'AF_TEST_SECRET']) {
    console.log('ENVCHECK ' + k + '=' + (k in process.env ? 'VISIBLE' : 'hidden'));
  }
  console.log('ENVCHECK PATH=' + ('PATH' in process.env ? 'present' : 'missing'));
  console.log('ENVCHECK DB_PATH=' + (process.env.DB_PATH || 'unset'));
}
if (mode === 'secrets') {
  console.log('connecting to db with password=hunter2-secret-value');
  console.log('received header: cookie: af_session=abc123token456; Path=/');
}
mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist', out), '<html></html>');
console.log('build ok');
`;

const FAKE_MIGRATE = `
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'migrations');
const dbPath = process.env.DB_PATH;
if (!dbPath) { console.error('DB_PATH is required'); process.exit(1); }
const db = new DatabaseSync(dbPath);
db.exec('CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)');
import { existsSync as __mexists, readFileSync as __mread } from 'node:fs';
const __mmode = __mexists(join(root, 'fake-mode.txt')) ? __mread(join(root, 'fake-mode.txt'), 'utf8').trim() : (process.env.FAKE_MIGRATE_MODE ?? 'ok');
if (__mmode === 'checksum-mismatch') {
  console.error('MIGRATION_CHECKSUM_MISMATCH: 001_init.sql changed after being applied');
  process.exit(1);
}
const files = readdirSync(dir).filter((f) => /^\\d+_.+\\.sql$/.test(f)).sort();
let fresh = 0;
for (const file of files) {
  const version = parseInt(file.split('_')[0], 10);
  const sql = readFileSync(join(dir, file), 'utf8');
  const checksum = createHash('sha256').update(sql).digest('hex');
  const row = db.prepare('SELECT checksum FROM migrations WHERE version = ?').get(version);
  if (row) {
    if (row.checksum !== checksum) {
      console.error('MIGRATION_CHECKSUM_MISMATCH: ' + file + ' changed after being applied');
      process.exit(1);
    }
    console.log('already applied: ' + file);
    continue;
  }
  console.log('applying migration ' + file);
  db.exec('BEGIN;');
  try {
    db.exec(sql);
    db.prepare('INSERT INTO migrations(version, name, checksum, applied_at) VALUES(?, ?, ?, ?)').run(version, file, checksum, new Date().toISOString());
    db.exec('COMMIT;');
  } catch (err) {
    try { db.exec('ROLLBACK;'); } catch {}
    console.error('migration ' + file + ' failed: ' + err.message);
    process.exit(1);
  }
  console.log('applied: ' + file);
  fresh++;
}
console.log('done: ' + fresh + ' new migration(s)');
db.close();
`;

const FAKE_TESTS = `
import { existsSync as __texists, readFileSync as __tread } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mode = __texists(join(root, 'fake-mode.txt')) ? __tread(join(root, 'fake-mode.txt'), 'utf8').trim() : (process.env.FAKE_TESTS_MODE ?? 'ok');
if (mode === 'fail') {
  console.log('\\u2139 tests 4');
  console.log('\\u2139 pass 3');
  console.log('\\u2139 fail 1');
  console.log('\\u2716 auth > login rejects wrong password');
  process.exit(1);
}
console.log('\\u2139 tests 4');
console.log('\\u2139 pass 4');
console.log('\\u2139 fail 0');
`;

function lockfile(name: string): string {
  return JSON.stringify({
    name,
    version: '0.1.0',
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name, version: '0.1.0' } },
  });
}

/** Minimal dynamic project fixture. Options tweak one failure mode at a time. */
function makeProject(opts: { withPackageJson?: boolean; withLockfile?: boolean; withTests?: boolean } = {}): string {
  const { withPackageJson = true, withLockfile = true, withTests = true } = opts;
  const dir = mkdtempSync(path.join(tmpdir(), 'af-dyn-test-'));
  const frontend = path.join(dir, 'frontend');
  const backend = path.join(dir, 'backend');
  mkdirSync(path.join(frontend, 'scripts'), { recursive: true });
  mkdirSync(path.join(backend, 'scripts'), { recursive: true });
  mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  mkdirSync(path.join(dir, 'migrations'), { recursive: true });
  if (withTests) mkdirSync(path.join(dir, 'tests'), { recursive: true });

  if (withPackageJson) {
    writeFileSync(
      path.join(frontend, 'package.json'),
      JSON.stringify({ name: 'fx-frontend', version: '0.1.0', private: true, scripts: { build: 'node scripts/build.mjs' } }),
    );
    writeFileSync(
      path.join(backend, 'package.json'),
      JSON.stringify({ name: 'fx-backend', version: '0.1.0', private: true, scripts: { build: 'node scripts/build.mjs' } }),
    );
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'fx-dynamic',
        version: '0.1.0',
        private: true,
        scripts: { migrate: 'node scripts/fake-migrate.mjs', test: 'node scripts/fake-tests.mjs' },
      }),
    );
  }
  if (withLockfile) {
    writeFileSync(path.join(frontend, 'package-lock.json'), lockfile('fx-frontend'));
    writeFileSync(path.join(backend, 'package-lock.json'), lockfile('fx-backend'));
  }
  writeFileSync(path.join(frontend, 'scripts', 'build.mjs'), BUILD_SCRIPT);
  writeFileSync(
    path.join(backend, 'scripts', 'build.mjs'),
    'process.env.FAKE_BUILD_OUT = \'server.js\';\n' + BUILD_SCRIPT,
  );
  writeFileSync(path.join(dir, 'scripts', 'fake-migrate.mjs'), FAKE_MIGRATE);
  writeFileSync(path.join(dir, 'scripts', 'fake-tests.mjs'), FAKE_TESTS);
  writeFileSync(path.join(dir, 'migrations', '001_init.sql'), 'CREATE TABLE notes(id TEXT PRIMARY KEY, body TEXT);');
  return dir;
}

function makeStudioDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE projects(id TEXT PRIMARY KEY, type TEXT);
    CREATE TABLE builds(id TEXT PRIMARY KEY, project_id TEXT, status TEXT,
      started_at TEXT, finished_at TEXT, duration_ms INTEGER,
      logs TEXT, artifacts_json TEXT, error TEXT);`);
  ensureMigrationsTable(db);
  return db;
}

function makeCtx(
  db: Database.Database,
  projectDir: string,
  opts: { type?: string; projectId?: string; buildTimeoutMs?: number; isCancelled?: () => boolean } = {},
): ToolContext {
  const projectId = opts.projectId ?? 'p1';
  db.prepare('INSERT OR REPLACE INTO projects(id, type) VALUES (?,?)').run(projectId, opts.type ?? 'dynamic');
  return {
    db,
    projectId,
    projectDir,
    frontendDir: path.join(projectDir, 'frontend'),
    cmdTimeoutMs: 30000,
    buildTimeoutMs: opts.buildTimeoutMs ?? 120000,
    isCancelled: opts.isCancelled,
  };
}

function migrationRows(db: Database.Database): Array<Record<string, unknown>> {
  return db.prepare('SELECT name, status, error FROM migrations ORDER BY name').all() as Array<Record<string, unknown>>;
}

function runningBuilds(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM builds WHERE status IN ('pending','running')").get() as { n: number }).n;
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  delete process.env.FAKE_BUILD_MODE;
  delete process.env.FAKE_TESTS_MODE;
  delete process.env.FAKE_MIGRATE_MODE;
  delete process.env.GROQ_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.APPFORGE_ADMIN_TOKEN;
  delete process.env.AF_TEST_SECRET;
});

function track(dir: string): string {
  tmpDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dynamic tools — fase 5A', () => {
  test('run_frontend_build succeeds on a dynamic project', async () => {
    const dir = track(makeProject());
    const db = makeStudioDb();
    const ctx = makeCtx(db, dir);
    const tools = createDynamicTools();
    const r = await tools.run_frontend_build(ctx, {});
    expect(r.ok).toBe(true);
    expect(r.code).toBeUndefined();
    expect(existsSync(path.join(dir, 'frontend', 'dist', 'index.html'))).toBe(true);
    expect((r.data as { distSize: number }).distSize).toBeGreaterThan(0);
    const row = db.prepare('SELECT status FROM builds').get() as { status: string };
    expect(row.status).toBe('success');
    expect(runningBuilds(db)).toBe(0);
    expect(ctx.dynamicChecks?.frontendBuild).toBeTruthy();
    db.close();
  });

  test('run_backend_build succeeds on a dynamic project', async () => {
    const dir = track(makeProject());
    const db = makeStudioDb();
    const ctx = makeCtx(db, dir);
    const tools = createDynamicTools();
    const r = await tools.run_backend_build(ctx, {});
    expect(r.ok).toBe(true);
    expect(existsSync(path.join(dir, 'backend', 'dist', 'server.js'))).toBe(true);
    expect(ctx.dynamicChecks?.backendBuild).toBeTruthy();
    db.close();
  });

  test('run_migrations applies to a temp DB and records per-file rows', async () => {
    const dir = track(makeProject());
    const db = makeStudioDb();
    const ctx = makeCtx(db, dir);
    const tools = createDynamicTools();
    const before = new Set(readdirSync(tmpdir()));
    const r = await tools.run_migrations(ctx, {});
    expect(r.ok).toBe(true);
    expect((r.data as { files: string[] }).files).toEqual(['001_init.sql']);
    const rows = migrationRows(db);
    expect(rows).toHaveLength(2); // one row set per pass (apply + idempotency)
    for (const row of rows) expect(row).toMatchObject({ name: '001_init.sql', status: 'success' });
    // temp verification DB cleaned up (pid-scoped: parallel test workers share tmpdir())
    const after = readdirSync(tmpdir()).filter((f) => f.startsWith(`af-migrate-${process.pid}-`) && !before.has(f));
    expect(after).toEqual([]);
    expect(ctx.dynamicChecks?.migrations).toBeTruthy();
    db.close();
  });

  test('run_migrations applies on empty DB and verifies idempotency on a second pass', async () => {
    const dir = track(makeProject());
    const db = makeStudioDb();
    const ctx = makeCtx(db, dir);
    const tools = createDynamicTools();
    const r = await tools.run_migrations(ctx, {});
    expect(r.ok).toBe(true);
    expect((r.data as { files: string[] }).files).toEqual(['001_init.sql']);
    expect((r.data as { idempotent: boolean }).idempotent).toBe(true);
    // second pass ran against the same temp DB: already applied, nothing new
    expect(r.output).toMatch(/already applied: 001_init\.sql/);
    const rows = migrationRows(db);
    expect(rows).toHaveLength(2); // one row set per pass
    for (const row of rows) expect(row.status).toBe('success');
    db.close();
  });

  test('run_api_tests returns pass/fail counts', async () => {
    const dir = track(makeProject());
    const db = makeStudioDb();
    const ctx = makeCtx(db, dir);
    const tools = createDynamicTools();
    const r = await tools.run_api_tests(ctx, {});
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ tests: 4, pass: 4, fail: 0 });
    expect(ctx.dynamicChecks?.apiTests).toBeTruthy();
    db.close();
  });

  test('static projects are rejected with NOT_DYNAMIC_PROJECT', async () => {
    const dir = track(makeProject());
    const db = makeStudioDb();
    const ctx = makeCtx(db, dir, { type: 'static' });
    const tools = createDynamicTools();
    for (const name of ['run_frontend_build', 'run_backend_build', 'run_migrations', 'run_api_tests'] as const) {
      const r = await tools[name](ctx, {});
      expect(r.ok).toBe(false);
      expect(r.code).toBe('NOT_DYNAMIC_PROJECT');
    }
    db.close();
  });

  test('missing package.json / lockfile are structured errors', async () => {
    const tools = createDynamicTools();
    {
      const dir = track(makeProject({ withPackageJson: false }));
      const db = makeStudioDb();
      const r = await tools.run_frontend_build(makeCtx(db, dir), {});
      expect(r.ok).toBe(false);
      expect(r.code).toBe('MISSING_PACKAGE_JSON');
      db.close();
    }
    {
      const dir = track(makeProject({ withLockfile: false }));
      const db = makeStudioDb();
      const r = await tools.run_backend_build(makeCtx(db, dir), {});
      expect(r.ok).toBe(false);
      expect(r.code).toBe('MISSING_LOCKFILE');
      db.close();
    }
  });

  test('broken frontend build keeps sources and reports diagnostics', async () => {
    const dir = track(makeProject());
    const db = makeStudioDb();
    const ctx = makeCtx(db, dir);
    setFixtureMode(path.join(dir, 'frontend'), 'fail');
    const tools = createDynamicTools();
    const r = await tools.run_frontend_build(ctx, {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe('FRONTEND_BUILD_FAILED');
    expect(r.output).toMatch(/TS2322/);
    // sources preserved
    expect(existsSync(path.join(dir, 'frontend', 'package.json'))).toBe(true);
    const row = db.prepare('SELECT status FROM builds').get() as { status: string };
    expect(row.status).toBe('failed');
    expect(runningBuilds(db)).toBe(0);
    db.close();
  });

  test('broken backend build reports BACKEND_BUILD_FAILED', async () => {
    const dir = track(makeProject());
    const db = makeStudioDb();
    const ctx = makeCtx(db, dir);
    setFixtureMode(path.join(dir, 'backend'), 'fail');
    const tools = createDynamicTools();
    const r = await tools.run_backend_build(ctx, {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe('BACKEND_BUILD_FAILED');
    db.close();
  });

  test('broken migration rolls back and records per-file terminal states', async () => {
    const dir = track(makeProject());
    writeFileSync(path.join(dir, 'migrations', '002_broken.sql'), 'CREATE TABLE oops oops oops;');
    const db = makeStudioDb();
    const ctx = makeCtx(db, dir);
    const tools = createDynamicTools();
    const r = await tools.run_migrations(ctx, {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe('MIGRATIONS_FAILED');
    expect(r.error).toMatch(/002_broken\.sql/);
    const rows = migrationRows(db);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ name: '001_init.sql', status: 'success' });
    expect(rows[1]).toMatchObject({ name: '002_broken.sql', status: 'failed' });
    // no dangling non-terminal rows
    const open = db.prepare("SELECT COUNT(*) AS n FROM migrations WHERE status IN ('pending','running')").get() as { n: number };
    expect(open.n).toBe(0);
    db.close();
  });

  test('modified migration checksum is a hard MIGRATION_CHECKSUM_MISMATCH', async () => {
    const dir = track(makeProject());
    const db = makeStudioDb();
    const ctx = makeCtx(db, dir);
    const tools = createDynamicTools();
    // the fixture emulates the template's observable checksum error
    setFixtureMode(dir, 'checksum-mismatch');
    const r = await tools.run_migrations(ctx, {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe('MIGRATION_CHECKSUM_MISMATCH');
    expect(r.error).toMatch(/001_init\.sql/);
    const rows = migrationRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: '001_init.sql', status: 'failed' });
    expect(String(rows[0]!.error)).toMatch(/MIGRATION_CHECKSUM_MISMATCH/);
    db.close();
  });

  test('failing API tests return counts and diagnostics', async () => {
    const dir = track(makeProject());
    const db = makeStudioDb();
    const ctx = makeCtx(db, dir);
    setFixtureMode(dir, 'fail');
    const tools = createDynamicTools();
    const r = await tools.run_api_tests(ctx, {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe('API_TESTS_FAILED');
    expect(r.data).toEqual({ tests: 4, pass: 3, fail: 1 });
    expect(r.output).toMatch(/login rejects wrong password/);
    db.close();
  });

  test('build timeout produces BUILD_TIMEOUT with terminal state', async () => {
    const dir = track(makeProject());
    const db = makeStudioDb();
    const ctx = makeCtx(db, dir, { buildTimeoutMs: 2000 });
    setFixtureMode(path.join(dir, 'frontend'), 'slow');
    const tools = createDynamicTools();
    const r = await tools.run_frontend_build(ctx, {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe('BUILD_TIMEOUT');
    expect(runningBuilds(db)).toBe(0);
    db.close();
  }, 30000);

  test('timeout kills the whole process tree: no orphaned grandchildren', async () => {
    const dir = track(makeProject());
    const db = makeStudioDb();
    const ctx = makeCtx(db, dir, { buildTimeoutMs: 3000 });
    setFixtureMode(path.join(dir, 'frontend'), 'slow');
    const tools = createDynamicTools();
    const r = await tools.run_frontend_build(ctx, {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe('BUILD_TIMEOUT');
    // the slow fixture wrote its (grandchild) pid before sleeping
    const pidFile = path.join(dir, 'frontend', 'dist', 'slow.pid');
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(Number.isFinite(pid)).toBe(true);
    // the tree must actually be gone when the tool returns (not just signalled)
    expect(await waitPidGone(pid)).toBe(true);
    db.close();
  }, 30000);

  test('cancellation kills the whole process tree: no orphaned grandchildren', async () => {
    const dir = track(makeProject());
    const db = makeStudioDb();
    const t0 = Date.now();
    const ctx = makeCtx(db, dir, { isCancelled: () => Date.now() - t0 > 1500 });
    setFixtureMode(path.join(dir, 'frontend'), 'slow');
    const tools = createDynamicTools();
    const r = await tools.run_frontend_build(ctx, {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe('BUILD_CANCELLED');
    expect(runningBuilds(db)).toBe(0);
    const pidFile = path.join(dir, 'frontend', 'dist', 'slow.pid');
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(await waitPidGone(pid)).toBe(true);
    db.close();
  }, 30000);

  test('cancellation produces BUILD_CANCELLED', async () => {
    const dir = track(makeProject());
    const db = makeStudioDb();
    const ctx = makeCtx(db, dir, { isCancelled: () => true });
    const tools = createDynamicTools();
    const r = await tools.run_frontend_build(ctx, {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe('BUILD_CANCELLED');
    expect(runningBuilds(db)).toBe(0);
    db.close();
  });

  test('LLM-provided paths/commands are ignored (confinement)', async () => {
    const dir = track(makeProject());
    const sentinel = path.join(tmpdir(), `af-dyn-sentinel-${Date.now()}.txt`);
    writeFileSync(sentinel, 'untouched');
    const db = makeStudioDb();
    const ctx = makeCtx(db, dir);
    const tools = createDynamicTools();
    const r = await tools.run_frontend_build(ctx, {
      cwd: '/tmp/evil',
      path: '../../../etc',
      cmd: 'rm',
      args: ['-rf', '/'],
    } as unknown as Record<string, unknown>);
    expect(r.ok).toBe(true); // args ignored, fixed pipeline ran
    expect(existsSync(path.join(dir, 'frontend', 'dist', 'index.html'))).toBe(true);
    expect(readFileSync(sentinel, 'utf8')).toBe('untouched');
    rmSync(sentinel, { force: true });
    db.close();
  });

  test('logs are sanitized of secrets', async () => {
    const dir = track(makeProject());
    const db = makeStudioDb();
    const ctx = makeCtx(db, dir);
    setFixtureMode(path.join(dir, 'frontend'), 'secrets');
    const tools = createDynamicTools();
    const r = await tools.run_frontend_build(ctx, {});
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/\[redacted\]/);
    expect(r.output).not.toMatch(/hunter2-secret-value/);
    expect(r.output).not.toMatch(/abc123token456/);
    db.close();
  });

  test('exception inside the tool leaves terminal state, not a dangling row', async () => {
    const dir = track(makeProject());
    const realDb = makeStudioDb();
    const flakyDb = {
      prepare: (sql: string) => {
        if (/INSERT INTO builds/.test(sql)) throw new Error('simulated db failure');
        return realDb.prepare(sql);
      },
      exec: (sql: string) => realDb.exec(sql),
    };
    const ctx = makeCtx(flakyDb as unknown as Database.Database, dir);
    const tools = createDynamicTools();
    const r = await tools.run_frontend_build(ctx, {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe('BUILD_EXCEPTION');
    expect(runningBuilds(realDb)).toBe(0);
    realDb.close();
  });

  test('changing sources invalidates the verification receipt and its followers', async () => {
    const dir = track(makeProject());
    const db = makeStudioDb();
    const ctx = makeCtx(db, dir);
    const tools = createDynamicTools();
    expect((await tools.run_frontend_build(ctx, {})).ok).toBe(true);
    expect((await tools.run_backend_build(ctx, {})).ok).toBe(true);
    expect((await tools.run_migrations(ctx, {})).ok).toBe(true);
    expect((await tools.run_api_tests(ctx, {})).ok).toBe(true);
    // 5A subset complete (preview precondition met), 5B checks still missing.
    expect(previewGateStatus(ctx).ok).toBe(true);
    expect(dynamicGateStatus(ctx).complete).toBe(false);
    expect(dynamicGateStatus(ctx).missing).toEqual(['fullstackPreview', 'authenticatedFlow']);
    // later frontend change invalidates frontendBuild AND its followers
    writeFileSync(path.join(dir, 'frontend', 'src-marker.txt'), 'changed');
    invalidateDynamicChecks(ctx);
    expect(ctx.dynamicChecks?.frontendBuild).toBeUndefined();
    expect(ctx.dynamicChecks?.backendBuild).toBeUndefined();
    expect(ctx.dynamicChecksOrder).toEqual([]);
    const gate = dynamicGateStatus(ctx);
    expect(gate.complete).toBe(false);
    expect(gate.missing).toEqual([...DYNAMIC_CHECK_ORDER]);
    db.close();
  });

  test('backend change keeps the earlier frontend check (prefix invariant)', async () => {
    const dir = track(makeProject());
    const db = makeStudioDb();
    const ctx = makeCtx(db, dir);
    const tools = createDynamicTools();
    expect((await tools.run_frontend_build(ctx, {})).ok).toBe(true);
    expect((await tools.run_backend_build(ctx, {})).ok).toBe(true);
    // backend change: earliest affected check is backendBuild
    writeFileSync(path.join(dir, 'backend', 'src-marker.txt'), 'changed');
    invalidateDynamicChecks(ctx);
    expect(ctx.dynamicChecks?.frontendBuild).toBeTruthy();
    expect(ctx.dynamicChecks?.backendBuild).toBeUndefined();
    expect(ctx.dynamicChecksOrder).toEqual(['frontendBuild']);
    expect(dynamicGateStatus(ctx).missing).toEqual(['backendBuild', 'migrations', 'apiTests', 'fullstackPreview', 'authenticatedFlow']);
    db.close();
  });

  test('out-of-order execution cannot accumulate: each check clears its followers', async () => {
    const dir = track(makeProject());
    const db = makeStudioDb();
    const ctx = makeCtx(db, dir);
    const tools = createDynamicTools();
    // deliberately backwards: api_tests first, then migrations, backend, frontend
    expect((await tools.run_api_tests(ctx, {})).ok).toBe(true);
    expect(ctx.dynamicChecksOrder).toEqual(['apiTests']);
    expect((await tools.run_migrations(ctx, {})).ok).toBe(true);
    expect(ctx.dynamicChecksOrder).toEqual(['migrations']);
    expect((await tools.run_backend_build(ctx, {})).ok).toBe(true);
    expect(ctx.dynamicChecksOrder).toEqual(['backendBuild']);
    expect((await tools.run_frontend_build(ctx, {})).ok).toBe(true);
    expect(ctx.dynamicChecksOrder).toEqual(['frontendBuild']);
    // only the last-run check survived; the gate forces the correct order
    const gate = dynamicGateStatus(ctx);
    expect(gate.complete).toBe(false);
    expect(gate.missing).toEqual(['backendBuild', 'migrations', 'apiTests', 'fullstackPreview', 'authenticatedFlow']);
    db.close();
  });

  test('in-order execution completes the 5A subset but not the 5B gate', async () => {
    const dir = track(makeProject());
    const db = makeStudioDb();
    const ctx = makeCtx(db, dir);
    const tools = createDynamicTools();
    expect((await tools.run_frontend_build(ctx, {})).ok).toBe(true);
    expect((await tools.run_backend_build(ctx, {})).ok).toBe(true);
    expect((await tools.run_migrations(ctx, {})).ok).toBe(true);
    expect((await tools.run_api_tests(ctx, {})).ok).toBe(true);
    // The four 5A checks satisfy the preview precondition…
    expect(previewGateStatus(ctx).ok).toBe(true);
    expect(ctx.dynamicChecksOrder).toEqual([...DYNAMIC_CHECK_ORDER_5A]);
    // …but the full gate needs the two 5B checks as well.
    const gate = dynamicGateStatus(ctx);
    expect(gate.complete).toBe(false);
    expect(gate.missing).toEqual(['fullstackPreview', 'authenticatedFlow']);
    expect(gate.orderValid).toBe(false);
    db.close();
  });

  test('migrations receipt covers backend/ and the root package.json', async () => {
    const dir = track(makeProject());
    const db = makeStudioDb();
    const ctx = makeCtx(db, dir);
    const tools = createDynamicTools();
    expect((await tools.run_migrations(ctx, {})).ok).toBe(true);
    expect(ctx.dynamicChecks?.migrations).toBeTruthy();
    // changing backend/ (not migrations/) must stale the migrations receipt
    writeFileSync(path.join(dir, 'backend', 'src-marker.txt'), 'changed');
    invalidateDynamicChecks(ctx);
    expect(ctx.dynamicChecks?.migrations).toBeUndefined();
    db.close();
  });

  test('buildChildEnv drops secrets and keeps only allowlisted variables', () => {
    process.env.GROQ_API_KEY = 'secret-groq';
    process.env.OPENROUTER_API_KEY = 'secret-openrouter';
    process.env.APPFORGE_ADMIN_TOKEN = 'secret-admin';
    process.env.AF_TEST_SECRET = 'secret-custom';
    const env = buildChildEnv();
    expect(env.GROQ_API_KEY).toBeUndefined();
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
    expect(env.APPFORGE_ADMIN_TOKEN).toBeUndefined();
    expect(env.AF_TEST_SECRET).toBeUndefined();
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.HOME).toBe(process.env.HOME);
    delete process.env.GROQ_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.APPFORGE_ADMIN_TOKEN;
    delete process.env.AF_TEST_SECRET;
  });

  test('buildChildEnv allows explicit DB_PATH and rejects unknown extra keys', () => {
    const env = buildChildEnv({ DB_PATH: '/tmp/x.db' });
    expect(env.DB_PATH).toBe('/tmp/x.db');
    expect(() => buildChildEnv({ EVIL_KEY: 'x' })).toThrow(/not allowlisted/);
  });

  test('generated code cannot see Studio secrets through the child environment', async () => {
    const dir = track(makeProject());
    const db = makeStudioDb();
    const ctx = makeCtx(db, dir);
    process.env.GROQ_API_KEY = 'secret-groq';
    process.env.OPENROUTER_API_KEY = 'secret-openrouter';
    process.env.APPFORGE_ADMIN_TOKEN = 'secret-admin';
    process.env.AF_TEST_SECRET = 'secret-custom';
    setFixtureMode(path.join(dir, 'frontend'), 'env-dump');
    const tools = createDynamicTools();
    const r = await tools.run_frontend_build(ctx, {});
    expect(r.ok).toBe(true);
    // the fixture ran (marker lines present) and no secret was visible.
    // NOTE: sanitizeSecrets redacts the "=hidden" values themselves
    // (api[_-]key= pattern), so assert absence of VISIBLE instead.
    expect(r.output).toMatch(/ENVCHECK GROQ_API_KEY=/);
    expect(r.output).toMatch(/ENVCHECK OPENROUTER_API_KEY=/);
    expect(r.output).toMatch(/ENVCHECK APPFORGE_ADMIN_TOKEN=/);
    expect(r.output).toMatch(/ENVCHECK AF_TEST_SECRET=/);
    expect(r.output).toMatch(/ENVCHECK PATH=present/);
    expect(r.output).not.toMatch(/VISIBLE/);
    expect(r.output).not.toContain('secret-groq');
    expect(r.output).not.toContain('secret-openrouter');
    expect(r.output).not.toContain('secret-admin');
    expect(r.output).not.toContain('secret-custom');
    delete process.env.GROQ_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.APPFORGE_ADMIN_TOKEN;
    delete process.env.AF_TEST_SECRET;
    db.close();
  });

  test('error fields are sanitized too, not just output', async () => {
    const dir = track(makeProject());
    const db = makeStudioDb();
    // force a build exception whose message carries a secret-like value
    const evilDb = {
      prepare: (sql: string) => {
        if (/INSERT INTO builds/.test(sql)) throw new Error('connection failed with password=hunter2-secret');
        return db.prepare(sql);
      },
      exec: (sql: string) => db.exec(sql),
    };
    const evilCtx = makeCtx(evilDb as unknown as Database.Database, dir);
    const tools = createDynamicTools();
    const r = await tools.run_frontend_build(evilCtx, {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe('BUILD_EXCEPTION');
    expect(r.error).not.toContain('hunter2-secret');
    expect(r.error).toMatch(/\[redacted\]/);
    db.close();
  });

  test('sanitizeSecrets redacts passwords, tokens and cookies', () => {
    const out = sanitizeSecrets(
      'login with password=s3cr3t-ok\n' +
        'authorization: Bearer abcdef123456\n' +
        'cookie: af_session=tokengoeshere123; Path=/\n' +
        'plain text stays',
    );
    expect(out).not.toMatch(/s3cr3t-ok/);
    expect(out).not.toMatch(/abcdef123456/);
    expect(out).not.toMatch(/tokengoeshere123/);
    expect(out).toMatch(/plain text stays/);
  });
});
