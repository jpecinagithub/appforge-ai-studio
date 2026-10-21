/**
 * Fase 1 (agent hardening): guards applied to write_file / write_files
 * BEFORE anything touches disk. A rejected write is never applied.
 *
 * Two failure modes from the pcBOX / PlayStation regression cases are
 * blocked here:
 *
 *  1. Placeholder overwrites — the agent replaced a full route module with
 *     a 4-line stub (`export function registerTodoRoutes() {}`), emptying
 *     the implementation while call sites kept passing 3 arguments
 *     (TS2554 at verify time, many repair turns later). The guard refuses
 *     to (a) empty an existing non-empty file, and (b) drop — or shrink
 *     the parameter list of — an exported symbol that other project files
 *     import. Symbol identity for functions includes arity precisely
 *     because the observed stub KEPT the exported name and only lost its
 *     parameters.
 *
 *  2. Loose scratch scripts at the frontend root — test_backend.js,
 *     debug_server.js and friends were written next to index.html and
 *     polluted the app. Root-level script files in the frontend area of
 *     DYNAMIC projects are rejected with a hint towards a work subfolder;
 *     known build config files (vite.config.*, vitest.config.*) stay
 *     allowed. The rule is scoped to dynamic projects on purpose: the
 *     junk entered through the dynamic area system, and the codebase
 *     pins "static projects keep exactly their previous behaviour"
 *     (dynamicAreas.test.ts) as a contract.
 *
 * The checks are deliberately mechanical (regex-level symbol extraction,
 * direct relative imports only) — they are a safety net against gutting a
 * file, not a type system. The compiler remains the source of truth.
 */
import fs from 'node:fs';
import path from 'node:path';

const IGNORED_DIRS = new Set(['node_modules', 'dist', '.git']);
const CODE_FILE_RE = /\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs)$/;
const MAX_SCAN_BYTES = 1_000_000;

// ---------------------------------------------------------------------------
// Exported symbol extraction
// ---------------------------------------------------------------------------

export interface ExportedSymbol {
  name: string;
  /** Parameter count for function declarations; null when unknown/not a function. */
  arity: number | null;
}

function countParams(params: string): number {
  const trimmed = params.trim();
  if (!trimmed) return 0;
  let depth = 0;
  let count = 1;
  for (const ch of trimmed) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) count++;
  }
  return count;
}

/** Extract the exported symbols of a TS/JS module (name → arity for functions). */
export function extractExportedSymbols(content: string): Map<string, ExportedSymbol> {
  const symbols = new Map<string, ExportedSymbol>();
  const fnRe = /export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g;
  for (const m of content.matchAll(fnRe)) {
    symbols.set(m[1]!, { name: m[1]!, arity: countParams(m[2]!) });
  }
  const declRe = /export\s+(?:default\s+)?(?:abstract\s+)?(?:class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  for (const m of content.matchAll(declRe)) {
    if (!symbols.has(m[1]!)) symbols.set(m[1]!, { name: m[1]!, arity: null });
  }
  // export { a, b as c } — the exported name is the alias (c).
  const listRe = /export\s*\{([^}]*)\}/g;
  for (const m of content.matchAll(listRe)) {
    for (const part of m[1]!.split(',')) {
      const entry = part.trim();
      if (!entry) continue;
      const alias = entry.match(/(?:\bas\s+)?([A-Za-z_$][\w$]*)$/);
      if (alias && !symbols.has(alias[1]!)) symbols.set(alias[1]!, { name: alias[1]!, arity: null });
    }
  }
  if (/export\s+default\b/.test(content)) {
    if (!symbols.has('default')) symbols.set('default', { name: 'default', arity: null });
  }
  return symbols;
}

// ---------------------------------------------------------------------------
// Import scanning (direct relative imports only)
// ---------------------------------------------------------------------------

interface ImportRef {
  /** Importing file (absolute path). */
  fromAbs: string;
  /** Symbols consumed from the target: named imports, 'default', or '*' for namespace imports. */
  symbols: Set<string>;
}

function resolveImportTarget(fromAbs: string, spec: string): string | null {
  if (!spec.startsWith('./') && !spec.startsWith('../')) return null;
  const base = path.resolve(path.dirname(fromAbs), spec);
  const candidates: string[] = [];
  const push = (p: string) => candidates.push(p);
  push(base);
  if (/\.(?:js|mjs)$/.test(base)) {
    // NodeNext style: ./routes/todos.js refers to ./routes/todos.ts on disk.
    push(base.replace(/\.(?:js|mjs)$/, '.ts'));
    push(base.replace(/\.(?:js|mjs)$/, '.tsx'));
    push(base.replace(/\.(?:js|mjs)$/, '.mts'));
  }
  for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs']) push(base + ext);
  for (const idx of ['index.ts', 'index.tsx', 'index.js', 'index.jsx']) push(path.join(base, idx));
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  // The target file may not need to exist for path EQUALITY (it always does
  // when the guard runs — the file being overwritten), but during a batch
  // the importer may resolve to a file whose on-disk state is pre-batch.
  // Fall back to the extension-mapped candidate that matches by shape.
  return null;
}

function collectProjectFiles(root: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const abs = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) collectProjectFiles(abs, out);
    } else if (entry.isFile() && CODE_FILE_RE.test(entry.name)) {
      out.push(abs);
    }
  }
}

/**
 * Symbols that other project files import FROM targetAbs. Files present in
 * `batchContents` (abs path → post-write content) are read from the batch
 * instead of disk, so an atomic write_files that updates the importers in
 * the same call is judged by its final state.
 */
export function findImportedSymbols(
  projectDir: string,
  targetAbs: string,
  batchContents?: ReadonlyMap<string, string>,
): Map<string, string[]> {
  const imported = new Map<string, string[]>();
  const files: string[] = [];
  collectProjectFiles(projectDir, files);
  const importRe = /import\s+(?:type\s+)?(?:([^'";]*?)\s+from\s+)?['"]([^'"]+)['"]/g;
  const reExportRe = /export\s+(?:\{([^}]*)\}|\*)\s+from\s+['"]([^'"]+)['"]/g;
  for (const fromAbs of files) {
    if (path.resolve(fromAbs) === path.resolve(targetAbs)) continue;
    let content: string;
    try {
      content = batchContents?.get(path.resolve(fromAbs)) ?? fs.readFileSync(fromAbs, 'utf8');
    } catch {
      continue;
    }
    if (content.length > MAX_SCAN_BYTES) continue;
    const noteUse = (symbols: Set<string>) => {
      for (const s of symbols) {
        const rel = path.relative(projectDir, fromAbs).split(path.sep).join('/');
        const list = imported.get(s) ?? [];
        if (!list.includes(rel)) list.push(rel);
        imported.set(s, list);
      }
    };
    for (const m of content.matchAll(importRe)) {
      const resolved = resolveImportTarget(fromAbs, m[2]!);
      if (!resolved || path.resolve(resolved) !== path.resolve(targetAbs)) continue;
      const clause = (m[1] ?? '').trim();
      const symbols = new Set<string>();
      if (clause) {
        const named = clause.match(/\{([^}]*)\}/);
        if (named) {
          for (const part of named[1]!.split(',')) {
            const entry = part.trim().replace(/^type\s+/, '');
            if (!entry) continue;
            const original = entry.split(/\s+as\s+/)[0]!.trim();
            if (original) symbols.add(original);
          }
        }
        if (/\*\s+as\s+[A-Za-z_$]/.test(clause)) symbols.add('*');
        const head = clause.replace(/\{[^}]*\}/, '').replace(/\*\s+as\s+[A-Za-z_$][\w$]*/, '').replace(/,/g, ' ').trim();
        if (/^[A-Za-z_$][\w$]*$/.test(head)) symbols.add('default');
      }
      noteUse(symbols);
    }
    for (const m of content.matchAll(reExportRe)) {
      const resolved = resolveImportTarget(fromAbs, m[2]!);
      if (!resolved || path.resolve(resolved) !== path.resolve(targetAbs)) continue;
      const symbols = new Set<string>();
      if (m[1]) {
        for (const part of m[1].split(',')) {
          const entry = part.trim().replace(/^type\s+/, '');
          if (!entry) continue;
          const original = entry.split(/\s+as\s+/)[0]!.trim();
          if (original) symbols.add(original);
        }
      } else {
        symbols.add('*');
      }
      noteUse(symbols);
    }
  }
  return imported;
}

// ---------------------------------------------------------------------------
// The write guard itself
// ---------------------------------------------------------------------------

export type WriteGuardResult = { ok: true } | { ok: false; message: string };

/**
 * Judge one write against the current on-disk content of its target.
 * `batchContents` (abs path → content) describes the other files written
 * in the same write_files call, including this target.
 */
export function checkWriteGuard(opts: {
  projectDir: string;
  targetAbs: string;
  displayPath: string;
  newContent: string;
  batchContents?: ReadonlyMap<string, string>;
}): WriteGuardResult {
  const targetAbs = path.resolve(opts.targetAbs);
  let current: string | null = null;
  try {
    current = fs.readFileSync(targetAbs, 'utf8');
  } catch {
    current = null; // new file: nothing to protect
  }
  if (current === null) return { ok: true };

  // (a) Emptying an existing non-empty file is never a legitimate edit.
  if (current.trim().length > 0 && opts.newContent.trim().length === 0) {
    return {
      ok: false,
      message:
        `write rejected: ${opts.displayPath} already exists with content and the new content is empty. ` +
        'Emptying a file breaks every importer. If the file really must go away, use delete_file; otherwise write the full updated content or use patch_file for a targeted edit.',
    };
  }

  // (b) Exported-symbol survival: a rewrite may not drop an export that
  // other files import, nor shrink an imported function's parameter list
  // (the placeholder-stub failure mode: same name, gutted signature).
  const before = extractExportedSymbols(current);
  if (before.size === 0) return { ok: true };
  const after = extractExportedSymbols(opts.newContent);
  const lost: string[] = [];
  const shrunk: Array<{ name: string; from: number; to: number }> = [];
  for (const [name, sym] of before) {
    const next = after.get(name);
    if (!next) lost.push(name);
    else if (sym.arity !== null && next.arity !== null && next.arity < sym.arity) {
      shrunk.push({ name, from: sym.arity, to: next.arity });
    }
  }
  if (lost.length === 0 && shrunk.length === 0) return { ok: true };

  const imported = findImportedSymbols(opts.projectDir, targetAbs, opts.batchContents);
  const namespaceImporters = imported.get('*') ?? [];
  const problems: string[] = [];
  for (const name of lost) {
    const users = imported.get(name) ?? namespaceImporters;
    if (users.length > 0) {
      problems.push(`export "${name}" is removed but still imported by ${users.join(', ')}`);
    }
  }
  for (const s of shrunk) {
    const users = imported.get(s.name) ?? namespaceImporters;
    if (users.length > 0) {
      problems.push(
        `export "${s.name}" drops parameters (${s.from} → ${s.to}) but is still imported by ${users.join(', ')} — call sites pass the old arguments`,
      );
    }
  }
  if (problems.length === 0) return { ok: true };
  return {
    ok: false,
    message:
      `write rejected: the new content of ${opts.displayPath} breaks its importers:\n- ${problems.join('\n- ')}\n` +
      'The write was NOT applied. Keep the exported API intact (same names and signatures) and change the implementation, ' +
      'or update every importer in the same write_files batch. For a small change prefer patch_file over rewriting the whole file.',
  };
}

// ---------------------------------------------------------------------------
// Frontend-root script hygiene (work 5)
// ---------------------------------------------------------------------------

const ROOT_SCRIPT_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.mts', '.cts']);
const ROOT_SCRIPT_ALLOWLIST = new Set([
  'vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs',
  'vitest.config.ts', 'vitest.config.js', 'vitest.config.mts', 'vitest.config.mjs',
]);

/**
 * Loose script files at the ROOT of the frontend area are how throwaway
 * probes (test_backend.js, debug_server.js…) ended up inside generated
 * apps. Returns a rejection message, or null when the path is fine.
 * `relPosix` is the path relative to the frontend area root.
 */
export function frontendRootScriptError(relPosix: string, displayPath: string): string | null {
  if (relPosix.includes('/')) return null; // inside a subfolder: fine
  const base = relPosix.split('/').pop() ?? relPosix;
  if (ROOT_SCRIPT_ALLOWLIST.has(base)) return null;
  const ext = path.posix.extname(base).toLowerCase();
  if (!ROOT_SCRIPT_EXTS.has(ext)) return null;
  return (
    `write rejected: "${displayPath}" would leave a loose script file at the root of the frontend area. ` +
    'Scratch/probe scripts do not belong next to index.html — they pollute the generated app. ' +
    `Put throwaway scripts in a work subfolder instead (for example "scratch/${base}") and real source code under "src/".`
  );
}
