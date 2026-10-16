/**
 * Cross-platform smoke test for the dynamic template.
 *
 * 1. Spawns `node backend/dist/server.js` directly with child_process.spawn
 *    (no npm wrapper: child.kill() reliably terminates the real server on
 *    every OS — killing the npm wrapper left the node child alive on
 *    Windows and SQLite deletion failed with "Device or resource busy").
 * 2. Polls /healthz until it answers.
 * 3. Kills the child and waits for the 'exit' event.
 * 4. Removes smoke.db, smoke.db-wal and smoke.db-shm (only after exit,
 *    so no file locks are held).
 * 5. Exits 0 only if health answered AND cleanup finished.
 *
 * Run from templates/dynamic-react-node/: node scripts/smoke-test.mjs
 * Requires the backend built (npm --prefix backend run build).
 */
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 18099;
const DB_PATH = join(tmpdir(), `appforge-smoke-${process.pid}.db`);

const child = spawn(
  process.execPath,
  [join(ROOT, 'backend', 'dist', 'server.js')],
  {
    env: { ...process.env, PORT: String(PORT), DB_PATH, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);

let serverOutput = '';
child.stdout.on('data', (d) => {
  serverOutput += d;
});
child.stderr.on('data', (d) => {
  serverOutput += d;
});

let healthOk = false;
let finished = false;

async function shutdown(code, reason) {
  if (finished) return;
  finished = true;
  if (reason) console.error(`SMOKE_FAIL: ${reason}`);
  if (serverOutput) console.error(`--- server output ---\n${serverOutput}`);

  // 3+4. Terminate and wait for exit before touching the DB files.
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve) => {
      const forceKill = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, 5000);
      child.once('exit', () => {
        clearTimeout(forceKill);
        resolve();
      });
      child.kill();
    });
  }

  // 5. Cleanup DB files (no locks held now).
  let cleaned = true;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      await rm(DB_PATH + suffix, { force: true });
    } catch (e) {
      cleaned = false;
      console.error(`cleanup failed for ${DB_PATH + suffix}: ${e.message}`);
    }
  }

  // 6. Exit 0 only if health answered AND cleanup finished.
  if (code === 0 && cleaned && healthOk) {
    console.log('SMOKE_OK');
    process.exit(0);
  }
  process.exit(1);
}

// Server died before answering health: fail fast.
child.once('exit', (exitCode, signal) => {
  if (!healthOk) shutdown(1, `server exited early (code=${exitCode} signal=${signal})`);
});

const deadline = Date.now() + 60000;
while (Date.now() < deadline && !finished) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
    if (res.ok) {
      console.log(`healthz: ${await res.text()}`);
      healthOk = true;
      await shutdown(0);
      break;
    }
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 500));
}
if (!finished) await shutdown(1, 'timeout waiting for /healthz');
