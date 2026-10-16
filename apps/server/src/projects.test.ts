import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from './db.js';
import { createProject, projectDir } from './projects.js';

const TEMPLATES_DIR = path.resolve(__dirname, '..', '..', '..', 'templates');

let db: Database.Database;
let dataDir: string;

beforeAll(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-projects-test-'));
  db = openDb(dataDir);
});

afterAll(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('createProject template selection', () => {
  it('scaffolds the static template by default', () => {
    const p = createProject(db, dataDir, TEMPLATES_DIR, { name: 'Static App' });
    const dir = projectDir(dataDir, p.id);
    expect(p.type).toBe('static');
    expect(fs.existsSync(path.join(dir, 'frontend', 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'backend'))).toBe(false);
  });

  it("scaffolds templates/dynamic-react-node for type 'dynamic'", () => {
    const p = createProject(db, dataDir, TEMPLATES_DIR, { name: 'Dynamic App', type: 'dynamic' });
    const dir = projectDir(dataDir, p.id);
    expect(p.type).toBe('dynamic');
    expect(fs.existsSync(path.join(dir, 'frontend', 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'backend', 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'migrations', '001_init.sql'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'Dockerfile'))).toBe(true);
    const context = fs.readFileSync(path.join(dir, 'PROJECT_CONTEXT.md'), 'utf8');
    expect(context).toContain('dynamic-react-node');
  });
});
