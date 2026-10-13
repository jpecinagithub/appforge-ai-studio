import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dependencyFingerprint, lockMatchesManifest, sourceFingerprint } from './fingerprint.js';
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'af-hash-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
it('detects changed dependencies even with an existing stale lockfile', () => {
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { react: '^19' } }));
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ packages: { '': { dependencies: { react: '^19' } } } }));
  expect(lockMatchesManifest(root)).toBe(true);
  const previous = dependencyFingerprint(root);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { react: '^19', 'react-router-dom': '^7' } }));
  expect(lockMatchesManifest(root)).toBe(false);
  expect(dependencyFingerprint(root)).not.toBe(previous);
});
it('invalidates verification for source changes but not generated artifacts', () => {
  fs.writeFileSync(path.join(root, 'App.tsx'), 'before');
  const before = sourceFingerprint(root);
  fs.mkdirSync(path.join(root, 'dist'));
  fs.writeFileSync(path.join(root, 'dist', 'index.html'), 'built');
  expect(sourceFingerprint(root)).toBe(before);
  fs.writeFileSync(path.join(root, 'App.tsx'), 'after');
  expect(sourceFingerprint(root)).not.toBe(before);
});
