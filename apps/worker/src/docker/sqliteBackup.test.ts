/**
 * Fase 7A — Tests unitarios de backup SQLite (sin Docker).
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  isValidBackupId,
  newBackupId,
  quickCheck,
  backupDirFor,
  writeBackupManifest,
  readBackupManifest,
  enforceRetention,
  sha256File,
  BackupError,
} from './sqliteBackup.js';

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'af-bk-ut-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function makeDb(p: string): void {
  const db = new DatabaseSync(p);
  db.exec('CREATE TABLE t(a TEXT); INSERT INTO t VALUES (\'x\');');
  db.close();
}

describe('backupId', () => {
  test('formato válido', () => {
    expect(isValidBackupId(newBackupId())).toBe(true);
    expect(isValidBackupId('bk_abc-123_XYZ')).toBe(true);
    expect(isValidBackupId('nope')).toBe(false);
    expect(isValidBackupId('bk_' + 'x'.repeat(65))).toBe(false);
    expect(isValidBackupId(null)).toBe(false);
  });
});

describe('quickCheck', () => {
  test('BD válida pasa', () => {
    const p = path.join(root, 'ok.db');
    makeDb(p);
    expect(() => quickCheck(p)).not.toThrow();
  });
  test('fichero corrupto falla', () => {
    const p = path.join(root, 'bad.db');
    fs.writeFileSync(p, 'esto no es sqlite');
    expect(() => quickCheck(p)).toThrowError(BackupError);
  });
  test('fichero inexistente falla', () => {
    expect(() => quickCheck(path.join(root, 'no.db'))).toThrowError(BackupError);
  });
});

describe('manifiesto', () => {
  test('roundtrip', () => {
    const dir = backupDirFor(root, 'proj-1', 'bk_abc');
    expect(dir).toBe(path.join(root, 'project-backups', 'proj-1', 'bk_abc'));
    const m = {
      backupId: 'bk_abc',
      projectId: 'proj-1',
      deploymentId: 'dep-1',
      createdAt: new Date().toISOString(),
      hadDatabase: true,
      files: [{ name: 'app.db', size: 10, sha256: 'a'.repeat(64) }],
    };
    writeBackupManifest(dir, m);
    expect(readBackupManifest(dir)).toEqual(m);
  });
  test('backupDirFor rechaza id inválido', () => {
    expect(() => backupDirFor(root, 'p', 'mal')).toThrowError(BackupError);
  });
});

describe('retención', () => {
  test('conserva 10 + protegidos', () => {
    const ids: string[] = [];
    const base = Date.now() - 100_000;
    for (let i = 0; i < 13; i++) {
      const id = `bk_${String(i).padStart(3, '0')}`;
      ids.push(id);
      const d = path.join(root, 'project-backups', 'p1', id);
      fs.mkdirSync(d, { recursive: true });
      const f = path.join(d, 'backup.json');
      fs.writeFileSync(f, '{}');
      // mtime determinista: bk_000 el más antiguo.
      const t = new Date(base + i * 1000);
      fs.utimesSync(f, t, t);
    }
    // El más antiguo queda protegido aunque salga del top 10.
    const removed = enforceRetention({ dataDir: root, projectId: 'p1', protectedIds: new Set([ids[0]]) });
    const remaining = fs.readdirSync(path.join(root, 'project-backups', 'p1'));
    expect(remaining).toHaveLength(11);
    expect(remaining).toContain(ids[0]);
    expect(removed).toHaveLength(2);
    expect(removed).not.toContain(ids[0]);
  });
  test('sha256File', () => {
    const p = path.join(root, 'f.bin');
    fs.writeFileSync(p, 'hola');
    const { size, sha256 } = sha256File(p);
    expect(size).toBe(4);
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
