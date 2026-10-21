/**
 * Puerta de implementación — unit tests for implementationEvidence.
 *
 * Reproduces, at file level, the live failures of 2026-10-21:
 *  - "PcBox online": a run that wrote ONLY a migration, verified the
 *    untouched starter template (which passes the six checks by design)
 *    and finished. The old any-area-changed guard accepted that.
 *  - "T-shirts" (497f482d): the shop was built in components that the
 *    entry point never referenced while App.tsx stayed byte-identical
 *    to the template; the run closed done 6/6 and DEPLOYED the
 *    template's todo app. Frontend surface is now entry-point
 *    divergence, not "some new file exists".
 *  - The symmetric backend hole, found by characterization the same
 *    day: a route file server.ts never imports satisfied the old
 *    backend-surface check. Route files must now be wired from the
 *    server entry point.
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
    expect(ev.missing.join(' ')).toContain('entry point still renders the untouched template (frontend/src/App.tsx is unchanged)');
    expect(ev.missing.join(' ')).toContain('wire the root component so the app renders your implementation');
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
    // A backend implementation means a route file REGISTERED from
    // server.ts (an unregistered file is dead code — see the dedicated
    // characterization-flip test below).
    write(project, 'backend/src/routes/products.ts', "export default async function products(app:any){ app.get('/api/products', async()=>[]); }");
    write(project, 'backend/src/server.ts', "import todos from './routes/todos.js';\nimport products from './routes/products.js';\nexport const app = {};");
    let ev = implementationEvidence(project, templatesDir);
    expect(ev.implemented).toBe(false);
    expect(ev.missing.join(' ')).toContain('frontend/src is still the untouched starter template');

    write(project, 'frontend/src/App.tsx', 'export default function App(){ return <div>store</div>; }');
    ev = implementationEvidence(project, templatesDir);
    expect(ev.implemented).toBe(true);
    expect(ev.missing).toEqual([]);
  });

  it('accepts endpoints added inside an existing route file plus an App.tsx that renders a new component', () => {
    const { templatesDir, project } = makePair();
    write(project, 'backend/src/routes/todos.ts', TODOS_TS + "\nexport async function products(app:any){ app.get('/api/products', async()=>[]); app.post('/api/products', async()=>({})); }");
    write(project, 'frontend/src/components/Catalog.tsx', 'export function Catalog(){ return null; }');
    write(project, 'frontend/src/App.tsx', "import { Catalog } from './components/Catalog';\nexport default function App(){ return <Catalog/>; }");
    const ev = implementationEvidence(project, templatesDir);
    expect(ev.implemented).toBe(true);
  });

  it('rejects the T-shirts case: template App.tsx plus unreferenced shop components', () => {
    const { templatesDir, project } = makePair();
    // Real, REGISTERED backend — only the frontend surface is in play.
    write(project, 'backend/src/routes/products.ts', "export default async function products(app:any){ app.get('/api/products', async()=>[]); }");
    write(project, 'backend/src/server.ts', "import todos from './routes/todos.js';\nimport products from './routes/products.js';\nexport const app = {};");
    // The shop exists — in components nothing imports. App.tsx and
    // main.tsx stay byte-identical to the template, so the deployed app
    // still renders the template's todo screen.
    write(project, 'frontend/src/components/ShopScreen.tsx', 'export function ShopScreen(){ return null; }');
    write(project, 'frontend/src/components/ProductCard.tsx', 'export function ProductCard(){ return null; }');
    write(project, 'frontend/src/components/CartItem.tsx', 'export function CartItem(){ return null; }');
    write(project, 'frontend/src/components/OrderItem.tsx', 'export function OrderItem(){ return null; }');
    const ev = implementationEvidence(project, templatesDir);
    expect(ev.implemented).toBe(false);
    expect(ev.missing).toHaveLength(1);
    expect(ev.missing[0]).toBe('entry point still renders the untouched template (frontend/src/App.tsx is unchanged); wire the root component so the app renders your implementation (e.g. render your main screen from App.tsx)');
  });

  it('accepts the same shop once App.tsx renders it', () => {
    const { templatesDir, project } = makePair();
    write(project, 'backend/src/routes/products.ts', "export default async function products(app:any){ app.get('/api/products', async()=>[]); }");
    write(project, 'backend/src/server.ts', "import todos from './routes/todos.js';\nimport products from './routes/products.js';\nexport const app = {};");
    write(project, 'frontend/src/components/ShopScreen.tsx', 'export function ShopScreen(){ return null; }');
    write(project, 'frontend/src/App.tsx', "import { ShopScreen } from './components/ShopScreen';\nexport default function App(){ return <ShopScreen/>; }");
    const ev = implementationEvidence(project, templatesDir);
    expect(ev.implemented).toBe(true);
    expect(ev.missing).toEqual([]);
  });

  it('accepts the main.tsx bypass: entry rewired to a new root component', () => {
    const { templatesDir, project } = makePair();
    write(project, 'backend/src/routes/products.ts', "export default async function products(app:any){ app.get('/api/products', async()=>[]); }");
    write(project, 'backend/src/server.ts', "import todos from './routes/todos.js';\nimport products from './routes/products.js';\nexport const app = {};");
    write(project, 'frontend/src/components/ShopScreen.tsx', 'export function ShopScreen(){ return null; }');
    write(project, 'frontend/src/ShopRoot.tsx', "import { ShopScreen } from './components/ShopScreen';\nexport default function ShopRoot(){ return <ShopScreen/>; }");
    // App.tsx stays the template's; main.tsx renders ShopRoot instead.
    write(project, 'frontend/src/main.tsx', "import { createRoot } from 'react-dom/client';\nimport ShopRoot from './ShopRoot';\ncreateRoot(document.getElementById('root')!).render(<ShopRoot />);");
    const ev = implementationEvidence(project, templatesDir);
    expect(ev.implemented).toBe(true);
    expect(ev.missing).toEqual([]);
  });

  it('rejects a changed main.tsx that still renders the template App', () => {
    const { templatesDir, project } = makePair();
    write(project, 'backend/src/routes/products.ts', "export default async function products(app:any){ app.get('/api/products', async()=>[]); }");
    write(project, 'backend/src/server.ts', "import todos from './routes/todos.js';\nimport products from './routes/products.js';\nexport const app = {};");
    write(project, 'frontend/src/main.tsx', "import App from './App';\nimport './index.css';\n// bootstrapped differently, same root\nconsole.log('boot');");
    const ev = implementationEvidence(project, templatesDir);
    expect(ev.implemented).toBe(false);
    expect(ev.missing.join(' ')).toContain('entry point still renders the untouched template (frontend/src/App.tsx is unchanged)');
  });

  it('rejects a new backend route file that server.ts never registers (characterization flip)', () => {
    // Characterization (2026-10-21, pre-fix): this exact shape returned
    // implemented=true with missing=[] — the symmetric hole. The route
    // file exists but nothing imports it, so it never runs.
    const { templatesDir, project } = makePair();
    write(project, 'frontend/src/App.tsx', 'export default function App(){ return <div>store</div>; }');
    write(project, 'backend/src/routes/products.ts', "export default async function products(app:any){ app.get('/api/products', async()=>[]); }");
    const ev = implementationEvidence(project, templatesDir);
    expect(ev.implemented).toBe(false);
    expect(ev.missing.join(' ')).toContain('no new backend route surface');
    expect(ev.missing.join(' ')).toContain('register it from backend/src/server.ts');
  });

  it('accepts a new backend route file once server.ts registers it', () => {
    const { templatesDir, project } = makePair();
    write(project, 'frontend/src/App.tsx', 'export default function App(){ return <div>store</div>; }');
    write(project, 'backend/src/routes/products.ts', "export default async function products(app:any){ app.get('/api/products', async()=>[]); }");
    write(project, 'backend/src/server.ts', "import todos from './routes/todos.js';\nimport products from './routes/products.js';\nexport const app = {};");
    const ev = implementationEvidence(project, templatesDir);
    expect(ev.implemented).toBe(true);
    expect(ev.missing).toEqual([]);
  });

  it('accepts a route registered transitively through a barrel file', () => {
    const { templatesDir, project } = makePair();
    write(project, 'frontend/src/App.tsx', 'export default function App(){ return <div>store</div>; }');
    write(project, 'backend/src/routes/products.ts', "export default async function products(app:any){ app.get('/api/products', async()=>[]); }");
    write(project, 'backend/src/routes/index.ts', "export { default } from './products.js';");
    write(project, 'backend/src/server.ts', "import todos from './routes/todos.js';\nimport products from './routes/index.js';\nexport const app = {};");
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
