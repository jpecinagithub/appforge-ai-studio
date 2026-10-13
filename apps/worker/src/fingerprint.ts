import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function sourceFingerprint(root: string): string {
  const hash = createHash('sha256');
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['node_modules', 'dist', '.git'].includes(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) hash.update(path.relative(root, file)).update('\0').update(fs.readFileSync(file)).update('\0');
    }
  };
  walk(root);
  return hash.digest('hex');
}

export function dependencyFingerprint(root: string): string {
  return createHash('sha256').update(['package.json', 'package-lock.json'].map((file) => {
    try { return fs.readFileSync(path.join(root, file), 'utf8'); } catch { return ''; }
  }).join('\0')).digest('hex');
}

export function lockMatchesManifest(root: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const locked = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')).packages?.[''];
    if (!locked) return false;
    for (const key of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const normalize = (value: Record<string, unknown> = {}) => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
      if (normalize(pkg[key]) !== normalize(locked[key])) return false;
    }
    return true;
  } catch { return false; }
}
