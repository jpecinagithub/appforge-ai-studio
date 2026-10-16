import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath (not .pathname): on Windows, .pathname yields /C:/... and
// join() then produces broken paths like C:\C:\Users\....
const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Reproducible installs: `npm ci` whenever a lockfile exists,
// plain `npm install` only to generate it the very first time.
for (const dir of ['frontend', 'backend']) {
  const lock = join(ROOT, dir, 'package-lock.json');
  const cmd = existsSync(lock) ? 'npm ci' : 'npm install';
  console.log(`[install] ${dir}: ${cmd}`);
  execSync(cmd, { cwd: join(ROOT, dir), stdio: 'inherit' });
}
console.log('[install] done');
