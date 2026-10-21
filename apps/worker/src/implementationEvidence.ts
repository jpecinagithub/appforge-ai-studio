/**
 * Implementation evidence for dynamic projects (Puerta de implementación,
 * 2026-10-21). The six-check gate proves the code that is present works; it
 * cannot prove the requested app was built at all: the starter template
 * passes all six checks by design, and the previous guard only rejected a
 * project whose every area was byte-identical to the template — a single
 * migration file defeated it (live case: "PcBox online", 2026-10-21, where
 * the run wrote only migrations/002_catalog.sql, verified the untouched
 * template and finished "done" without any store existing).
 *
 * This module computes, deterministically and without an LLM, whether a
 * dynamic project still IS the starter template in the areas that make it
 * an app, plus whether it grew any new surface:
 *
 *  1. Key areas: BOTH `frontend/src` and `backend/src` must differ from
 *     the template. Changing only migrations/tests/docs does not count.
 *  2. Backend surface: at least one route file under `backend/src/routes/`
 *     that the template does not ship, or an existing route file that
 *     declares MORE route handlers than its template counterpart, or
 *     `server.ts` itself declaring more handlers — AND, in every case,
 *     the file must be WIRED: reachable from `backend/src/server.ts`
 *     through the relative-import chain. A new route file that nothing
 *     imports never runs, so it is not surface (symmetric hole, found by
 *     characterization test on 2026-10-21: an unregistered routes file
 *     satisfied the old check with `missing: []`).
 *  3. Frontend surface: the app's ENTRY POINT must diverge from the
 *     template — either `frontend/src/App.tsx` differs from the
 *     template, or `frontend/src/main.tsx` differs AND the root
 *     component it imports exists in the project and is new or differs
 *     from its template counterpart (legitimate bypass of App.tsx).
 *     New files under `frontend/src` that the entry chain never reaches
 *     do NOT count: the live "T-shirts" case (2026-10-21, project
 *     497f482d) closed done 6/6 and deployed the template's todo app
 *     because the shop the agent built lived in unreferenced components
 *     while App.tsx stayed byte-identical to the template — and the
 *     authenticated flow only exercises auth, which the template passes
 *     by construction.
 *
 * When the templates directory is unavailable the check reports
 * `checked: false` and the caller falls back to the legacy behaviour:
 * the evidence must never block a run just because it could not run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { sourceFingerprint } from './fingerprint.js';

export interface ImplementationEvidence {
  /** False when the starter template could not be located: check skipped. */
  checked: boolean;
  implemented: boolean;
  /** Concrete, model-actionable gaps (empty when implemented/skipped). */
  missing: string[];
}

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);

function listFiles(root: string): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.add(path.relative(root, full));
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out;
}

function fingerprintOrNull(root: string): string | null {
  if (!fs.existsSync(root)) return null;
  try { return sourceFingerprint(root); } catch { return null; }
}

function readOrNull(file: string): string | null {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

/** Route handler declarations (`app.get(`, `fastify.post(`, `router.delete(`…). */
function countRouteHandlers(content: string): number {
  return (content.match(/\.(get|post|put|patch|delete|all)\s*\(/g) ?? []).length;
}

const CODE_EXTS = new Set(['.tsx', '.ts', '.jsx', '.js']);

function isCodeFile(file: string): boolean {
  return CODE_EXTS.has(path.extname(file));
}

/**
 * Relative import specifiers ('./x', '../x') in a source file: static
 * imports, side-effect imports, re-exports, dynamic import() and
 * require(). Deliberately a regex, not a parser — good enough for
 * import chains. (Residual imprecision, accepted: an import-shaped
 * string inside a comment could add a phantom edge; a missed edge only
 * ever makes the check stricter.)
 */
function relativeImports(content: string): string[] {
  const specs = new Set<string>();
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"](\.[^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) specs.add(match[1]!);
  return [...specs];
}

/** Resolve a relative specifier against the importing file's directory. */
function resolveRelative(fromDir: string, spec: string): string | null {
  const base = path.resolve(fromDir, spec);
  const ext = path.extname(base);
  const candidates: string[] = [];
  if (ext) {
    candidates.push(base);
    // NodeNext-style specifiers in TS sources: './routes/todos.js' is
    // really todos.ts on disk; '.jsx' maps to '.tsx', '.mjs' to '.ts'.
    if (ext === '.js' || ext === '.mjs') candidates.push(base.slice(0, -ext.length) + '.ts');
    if (ext === '.jsx') candidates.push(base.slice(0, -ext.length) + '.tsx');
  } else {
    for (const e of ['.tsx', '.ts', '.jsx', '.js']) candidates.push(base + e);
    for (const e of ['.tsx', '.ts', '.jsx', '.js']) candidates.push(path.join(base, 'index' + e));
  }
  for (const candidate of candidates) {
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* keep looking */ }
  }
  return null;
}

/**
 * Every code file reachable from `entryFile` through relative imports
 * (the entry file itself included). Bounded so a pathological import
 * graph cannot hang the check.
 */
function reachableFrom(entryFile: string, maxFiles = 500): Set<string> {
  const seen = new Set<string>();
  const queue = [entryFile];
  while (queue.length > 0 && seen.size < maxFiles) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const content = readOrNull(file);
    if (content === null) continue;
    for (const spec of relativeImports(content)) {
      const resolved = resolveRelative(path.dirname(file), spec);
      if (resolved !== null && isCodeFile(resolved) && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return seen;
}

function hasNewBackendSurface(projectDir: string, starter: string): boolean {
  const starterRoutesDir = path.join(starter, 'backend', 'src', 'routes');
  const projectRoutesDir = path.join(projectDir, 'backend', 'src', 'routes');
  const starterRoutes = listFiles(starterRoutesDir);
  const projectRoutes = listFiles(projectRoutesDir);
  const projectServer = path.join(projectDir, 'backend', 'src', 'server.ts');
  // Wiring: a route file only counts if the server entry point reaches
  // it through its import chain. An unregistered routes file is dead
  // code, not surface.
  const reachable = fs.existsSync(projectServer) ? reachableFrom(projectServer) : new Set<string>();
  const isWired = (rel: string): boolean => reachable.has(path.join(projectRoutesDir, rel));
  // server.ts itself declaring more handlers than its template
  // counterpart (the entry point is wired by definition).
  const serverContent = readOrNull(projectServer);
  const starterServerContent = readOrNull(path.join(starter, 'backend', 'src', 'server.ts')) ?? '';
  if (serverContent !== null && countRouteHandlers(serverContent) > countRouteHandlers(starterServerContent)) return true;
  // A wired route file the template does not ship, declaring at least
  // one handler (a barrel or helper with no handlers is not a route
  // surface by itself — but the chain still reaches through it to the
  // files that do declare them).
  for (const file of projectRoutes) {
    if (starterRoutes.has(file) || !isWired(file)) continue;
    const content = readOrNull(path.join(projectRoutesDir, file));
    if (content !== null && countRouteHandlers(content) > 0) return true;
  }
  // A wired route file declaring more handlers than its template
  // counterpart.
  for (const rel of projectRoutes) {
    if (!isWired(rel)) continue;
    const projectContent = readOrNull(path.join(projectRoutesDir, rel));
    if (projectContent === null) continue;
    const starterContent = readOrNull(path.join(starterRoutesDir, rel)) ?? '';
    if (countRouteHandlers(projectContent) > countRouteHandlers(starterContent)) return true;
  }
  return false;
}

/**
 * Frontend surface = the app's entry point diverges from the template:
 *  (a) `src/App.tsx` itself differs from the template; or
 *  (b) `src/main.tsx` differs AND a root component it imports exists in
 *      the project and is new or differs from its template counterpart
 *      (legitimate bypass of App.tsx).
 * Unreferenced new files no longer count — that was the T-shirts hole.
 */
function frontendSurface(projectDir: string, starter: string): { ok: boolean; appUnchanged: boolean } {
  const projectSrc = path.join(projectDir, 'frontend', 'src');
  const starterSrc = path.join(starter, 'frontend', 'src');
  const projectApp = readOrNull(path.join(projectSrc, 'App.tsx'));
  const starterApp = readOrNull(path.join(starterSrc, 'App.tsx'));
  const appUnchanged = projectApp !== null && starterApp !== null && projectApp === starterApp;
  if (projectApp !== null && starterApp !== null && projectApp !== starterApp) {
    return { ok: true, appUnchanged: false };
  }
  const projectMain = readOrNull(path.join(projectSrc, 'main.tsx'));
  const starterMain = readOrNull(path.join(starterSrc, 'main.tsx'));
  if (projectMain !== null && starterMain !== null && projectMain !== starterMain) {
    for (const spec of relativeImports(projectMain)) {
      const resolved = resolveRelative(projectSrc, spec);
      if (resolved === null || !isCodeFile(resolved)) continue;
      const rel = path.relative(projectSrc, resolved);
      if (rel === 'main.tsx') continue;
      const projectContent = readOrNull(resolved);
      if (projectContent === null) continue;
      const starterContent = readOrNull(path.join(starterSrc, rel));
      if (starterContent === null || starterContent !== projectContent) {
        return { ok: true, appUnchanged };
      }
    }
  }
  return { ok: false, appUnchanged };
}

export function implementationEvidence(projectDir: string, templatesDir?: string): ImplementationEvidence {
  const starter = templatesDir ? path.join(templatesDir, 'dynamic-react-node') : '';
  if (!starter || !fs.existsSync(path.join(starter, 'frontend', 'src')) || !fs.existsSync(path.join(starter, 'backend', 'src'))) {
    return { checked: false, implemented: true, missing: [] };
  }
  const missing: string[] = [];

  const frontendChanged = fingerprintOrNull(path.join(projectDir, 'frontend', 'src'))
    !== fingerprintOrNull(path.join(starter, 'frontend', 'src'));
  const backendChanged = fingerprintOrNull(path.join(projectDir, 'backend', 'src'))
    !== fingerprintOrNull(path.join(starter, 'backend', 'src'));
  if (!frontendChanged) missing.push('frontend/src is still the untouched starter template');
  if (!backendChanged) missing.push('backend/src is still the untouched starter template');

  if (!hasNewBackendSurface(projectDir, starter)) {
    missing.push('no new backend route surface: add a route file under backend/src/routes and register it from backend/src/server.ts, or extend an existing registered route file with new endpoints');
  }
  const surface = frontendSurface(projectDir, starter);
  if (!surface.ok) {
    missing.push(surface.appUnchanged
      ? 'entry point still renders the untouched template (frontend/src/App.tsx is unchanged); wire the root component so the app renders your implementation (e.g. render your main screen from App.tsx)'
      : 'entry point still renders the untouched template (no new or changed root component is wired from frontend/src/main.tsx); wire the root component so the app renders your implementation (e.g. render your main screen from App.tsx)');
  }
  return { checked: true, implemented: missing.length === 0, missing };
}
