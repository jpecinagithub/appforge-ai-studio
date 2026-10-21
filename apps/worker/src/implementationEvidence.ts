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
 *     that the template does not ship, or an existing route file (or
 *     `server.ts`) that declares MORE route handlers than its template
 *     counterpart.
 *  3. Frontend surface: `frontend/src/App.tsx` differs from the template,
 *     or `frontend/src` contains a file the template does not ship.
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

function hasNewBackendSurface(projectDir: string, starter: string): boolean {
  const starterRoutesDir = path.join(starter, 'backend', 'src', 'routes');
  const projectRoutesDir = path.join(projectDir, 'backend', 'src', 'routes');
  const starterRoutes = listFiles(starterRoutesDir);
  const projectRoutes = listFiles(projectRoutesDir);
  // A route file the template does not ship.
  for (const file of projectRoutes) if (!starterRoutes.has(file)) return true;
  // An existing route file (or server.ts) declaring more handlers than the
  // template counterpart.
  const comparable = [...projectRoutes].map((f) => path.join('routes', f));
  comparable.push('server.ts');
  for (const rel of comparable) {
    const projectContent = readOrNull(path.join(projectDir, 'backend', 'src', rel));
    if (projectContent === null) continue;
    const starterContent = readOrNull(path.join(starter, 'backend', 'src', rel)) ?? '';
    if (countRouteHandlers(projectContent) > countRouteHandlers(starterContent)) return true;
  }
  return false;
}

function hasNewFrontendSurface(projectDir: string, starter: string): boolean {
  const projectSrc = path.join(projectDir, 'frontend', 'src');
  const starterSrc = path.join(starter, 'frontend', 'src');
  const projectApp = readOrNull(path.join(projectSrc, 'App.tsx'));
  const starterApp = readOrNull(path.join(starterSrc, 'App.tsx'));
  if (projectApp !== null && starterApp !== null && projectApp !== starterApp) return true;
  const starterFiles = listFiles(starterSrc);
  for (const file of listFiles(projectSrc)) if (!starterFiles.has(file)) return true;
  return false;
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
    missing.push('no new backend route surface: add a route file under backend/src/routes or extend an existing one with new endpoints');
  }
  if (!hasNewFrontendSurface(projectDir, starter)) {
    missing.push('no new frontend surface: src/App.tsx is unchanged and frontend/src has no new files');
  }
  return { checked: true, implemented: missing.length === 0, missing };
}
