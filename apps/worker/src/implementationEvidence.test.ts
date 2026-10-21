/**
 * Puerta de implementación — unit tests for implementationEvidence.
 *
 * Reproduces, at file level, the live failure of 2026-10-21 ("PcBox
 * online"): a run that wrote ONLY a migration, verified the untouched
 * starter template (which passes the six checks by design) and finished.
 * The old any-area-changed guard accepted that; the evidence must not.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { implementationEvidence } from './implementationEvidence.js';

const APP_TS = 'export default function App(){ return <div>todos</div>; }';
const TODOS_TS = "export default async function todos(app:any){ app.get('/api/todos', async()=>[]); app.post('/api/todos', async()=>({})); }";
const USERS_TS = "export default async function users(app:any){ app.get('/api/users', async()=>[]); }";
const SERVER_TS = "import todos from './routes/todos.js'; export const app = {};";

function write(root: string, rel: string, content: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function makeTree(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  write(dir, 'frontend/src/App.tsx', APP_TS);
  write(dir, 'frontend/src/api.ts', 'export const api = {};');
  write(dir, 'frontend/src/main.tsx', "import App from './App';");
  write(dir, 'backend/src/server.ts', SERVER_TS);
  write(dir, 'backend/src/routes/todos.ts', TODOS_TS);
  write(dir, 'backend/src/routes/users.ts', USERS_TS);
  write(dir, 'migrations/001_init.sql', 'CREATE TABLE notes(id TEXT);');
  return dir;
}

function makePair(): { templatesDir: string; project: string } {
  const starter = makeTree('af-evidence-starter-');
  const templatesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-evidence-templates-'));
  fs.cpSync(starter, path.join(templatesDir, 'dynamic-react-node'), { recursive: true });
  const project = makeTree('af-evidence-project-');
  return { templatesDir, project };
}

describe('implementationEvidence', () => {
  it('rejects the pristine starter, listing every gap', () => {
    const { templatesDir, project } = makePair();
    const ev = implementationEvidence(project, templatesDir);
    expect(ev.checked).toBe(true);
    expect(ev.implemented).toBe(false);
    expect(ev.missing.join(' ')).toContain('frontend/src is still the untouched starter template');
    expect(ev.missing.join(' ')).toContain('backend/src is still the untouched starter template');
    expect(ev.missing.join(' ')).toContain('no new backend route surface');
    expect(ev.missing.join(' ')).toContain('no new frontend surface');
  });

  it('rejects a migration-only change (the PcBox online case)', () => {
    const { templatesDir, project } = makePair();
    write(project, 'migrations/002_catalog.sql', 'CREATE TABLE products(id TEXT PRIMARY KEY, name TEXT, price REAL);');
    const ev = implementationEvidence(project, templatesDir);
    expect(ev.implemented).toBe(false);
    expect(ev.missing.join(' ')).toContain('backend/src is still the untouched starter template');
    expect(ev.missing.join(' ')).toContain('frontend/src is still the untouched starter template');
  });

  it('rejects backend-only and frontend-only implementations', () => {
    const { templatesDir, project } = makePair();
    write(project, 'backend/src/routes/products.ts', "export default async function products(app:any){ app.get('/api/products', async()=>[]); }");
    let ev = implementationEvidence(project, templatesDir);
    expect(ev.implemented).toBe(false);
    expect(ev.missing.join(' ')).toContain('frontend/src is still the untouched starter template');

    write(project, 'frontend/src/App.tsx', 'export default function App(){ return <div>store</div>; }');
    ev = implementationEvidence(project, templatesDir);
    expect(ev.implemented).toBe(true);
    expect(ev.missing).toEqual([]);
  });

  it('accepts endpoints added inside an existing route file plus a new frontend file', () => {
    const { templatesDir, project } = makePair();
    write(project, 'backend/src/routes/todos.ts', TODOS_TS + "\nexport async function products(app:any){ app.get('/api/products', async()=>[]); app.post('/api/products', async()=>({})); }");
    write(project, 'frontend/src/components/Catalog.tsx', 'export function Catalog(){ return null; }');
    const ev = implementationEvidence(project, templatesDir);
    expect(ev.implemented).toBe(true);
  });

  it('rejects cosmetic backend changes with no new route surface', () => {
    const { templatesDir, project } = makePair();
    write(project, 'backend/src/server.ts', SERVER_TS + '\n// comment only');
    write(project, 'frontend/src/App.tsx', 'export default function App(){ return <div>store</div>; }');
    const ev = implementationEvidence(project, templatesDir);
    expect(ev.implemented).toBe(false);
    expect(ev.missing.join(' ')).toContain('no new backend route surface');
  });

  it('skips the check when the templates directory is unavailable', () => {
    const project = makeTree('af-evidence-solo-');
    expect(implementationEvidence(project, undefined)).toEqual({ checked: false, implemented: true, missing: [] });
    expect(implementationEvidence(project, '/nonexistent')).toEqual({ checked: false, implemented: true, missing: [] });
  });
});
