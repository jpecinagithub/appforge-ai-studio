/**
 * Fase 7A — Tests unitarios del snapshot inmutable (sin Docker).
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createSnapshot,
  verifySnapshot,
  fingerprintOfEntries,
  APPFORGE_DOCKERIGNORE,
  SnapshotError,
} from './snapshot.js';

let root = '';
let projectDir = '';
let snapsRoot = '';

function writeFile(rel: string, content: string): void {
  const abs = path.join(projectDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'af-snap-ut-'));
  projectDir = path.join(root, 'proj');
  snapsRoot = path.join(root, 'snaps');
  fs.mkdirSync(projectDir, { recursive: true });
  writeFile('Dockerfile', 'FROM node:24-slim\n');
  writeFile('backend/src/server.js', 'console.log(1)');
  writeFile('frontend/src/app.js', 'export {}');
  writeFile('migrations/001_init.sql', 'CREATE TABLE t(a);');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('exclusiones', () => {
  test('excluye runtime del manifiesto y del disco', () => {
    writeFile('.git/config', 'x');
    writeFile('node_modules/a/index.js', 'x');
    writeFile('dist/bundle.js', 'x');
    writeFile('.env', 'SECRET=1');
    writeFile('.env.local', 'SECRET=2');
    writeFile('data/app.db', 'x');
    writeFile('backups/old.db', 'x');
    writeFile('app.log', 'x');
    writeFile('notes.db-wal', 'x');
    const s = createSnapshot({ projectDir, snapshotsRoot: snapsRoot, deploymentId: 'dep-1' });
    const paths = s.entries.map((e) => e.path);
    expect(paths).toContain('Dockerfile');
    expect(paths).toContain('backend/src/server.js');
    for (const p of paths) {
      expect(p).not.toMatch(/\.git|node_modules|dist\/|\.env|app\.db|backups|\.log/);
    }
    expect(fs.existsSync(path.join(s.dir, '.env'))).toBe(false);
    expect(fs.existsSync(path.join(s.dir, 'data'))).toBe(false);
  });
});

describe('symlinks (fail closed)', () => {
  test('rechaza symlink que escapa', () => {
    fs.symlinkSync('/etc/passwd', path.join(projectDir, 'evil'));
    expect(() => createSnapshot({ projectDir, snapshotsRoot: snapsRoot, deploymentId: 'dep-2' })).toThrowError(
      expect.objectContaining({ code: 'SYMLINK_REJECTED' }),
    );
  });
  test('rechaza symlink interno también', () => {
    writeFile('real.txt', 'x');
    fs.symlinkSync('real.txt', path.join(projectDir, 'link.txt'));
    expect(() => createSnapshot({ projectDir, snapshotsRoot: snapsRoot, deploymentId: 'dep-3' })).toThrowError(
      expect.objectContaining({ code: 'SYMLINK_REJECTED' }),
    );
  });
});

describe('manifiesto y fingerprint', () => {
  test('manifiesto ordenado y fingerprint estable', () => {
    const a = createSnapshot({ projectDir, snapshotsRoot: snapsRoot, deploymentId: 'dep-a' });
    const b = createSnapshot({ projectDir, snapshotsRoot: snapsRoot, deploymentId: 'dep-b' });
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const paths = a.entries.map((e) => e.path);
    expect([...paths].sort()).toEqual(paths);
    for (const e of a.entries) {
      expect(e.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof e.size).toBe('number');
    }
  });
  test('un cambio altera el fingerprint', () => {
    const a = createSnapshot({ projectDir, snapshotsRoot: snapsRoot, deploymentId: 'dep-a' });
    writeFile('backend/src/server.js', 'console.log(2)');
    const b = createSnapshot({ projectDir, snapshotsRoot: snapsRoot, deploymentId: 'dep-b' });
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });
  test('verifySnapshot detecta manipulación', () => {
    const s = createSnapshot({ projectDir, snapshotsRoot: snapsRoot, deploymentId: 'dep-a' });
    expect(verifySnapshot(s.dir)).toBe(s.fingerprint);
    fs.writeFileSync(path.join(s.dir, 'Dockerfile'), 'FROM evil\n');
    expect(() => verifySnapshot(s.dir)).toThrowError(expect.objectContaining({ code: 'SNAPSHOT_TAMPERED' }));
  });
  test('verifySnapshot detecta fichero añadido', () => {
    const s = createSnapshot({ projectDir, snapshotsRoot: snapsRoot, deploymentId: 'dep-a' });
    fs.writeFileSync(path.join(s.dir, 'extra.sh'), 'x');
    expect(() => verifySnapshot(s.dir)).toThrowError(expect.objectContaining({ code: 'SNAPSHOT_TAMPERED' }));
  });
  test('no sobrescribe un snapshot existente', () => {
    createSnapshot({ projectDir, snapshotsRoot: snapsRoot, deploymentId: 'dep-a' });
    expect(() => createSnapshot({ projectDir, snapshotsRoot: snapsRoot, deploymentId: 'dep-a' })).toThrowError(
      expect.objectContaining({ code: 'SNAPSHOT_EXISTS' }),
    );
  });
  test('.dockerignore controlado por AppForge', () => {
    const s = createSnapshot({ projectDir, snapshotsRoot: snapsRoot, deploymentId: 'dep-a' });
    const content = fs.readFileSync(path.join(s.dir, '.dockerignore'), 'utf8');
    expect(content).toBe(APPFORGE_DOCKERIGNORE);
    expect(content).toContain('.env');
    expect(content).toContain('node_modules/');
  });
  test('fingerprintOfEntries es determinista', () => {
    const s = createSnapshot({ projectDir, snapshotsRoot: snapsRoot, deploymentId: 'dep-a' });
    expect(fingerprintOfEntries(s.entries)).toBe(s.fingerprint);
    expect(fingerprintOfEntries([...s.entries].reverse())).toBe(s.fingerprint);
  });
});

describe('validación de deploymentId', () => {
  test('rechaza ids maliciosos', () => {
    for (const bad of ['../x', 'a/b', '', 'x'.repeat(200)]) {
      expect(() => createSnapshot({ projectDir, snapshotsRoot: snapsRoot, deploymentId: bad })).toThrowError(
        SnapshotError,
      );
    }
  });
});
