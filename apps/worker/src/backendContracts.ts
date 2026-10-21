/**
 * Backend contract lint for dynamic projects (agent autonomy, 2026-10-21).
 *
 * The Fase 1 immediate typecheck only speaks once the backend dependencies
 * are installed (it needs tsc), which in practice means after the first
 * run_backend_build — too late: in the live "PcBox online" run a9864671 the
 * agent wrote products/cart/orders against template contracts it did not
 * know (an invented sendError code, better-sqlite3's db.transaction on
 * node:sqlite) and only discovered the mismatches at build time, burning
 * its repair budget on discovery instead of fixes.
 *
 * This lint is pure text scanning — no compiler, no dependencies — so it
 * can annotate a backend write in the SAME turn it happens:
 *
 *  1. sendError codes: `ErrorCode` in backend/src/lib/errors.ts is a closed
 *     union. A literal code outside the union is a guaranteed TS error;
 *     the note names the code and the one file to extend (or the valid set).
 *  2. `.transaction(`: node:sqlite's DatabaseSync has no transaction
 *     helper. The note gives the BEGIN IMMEDIATE / COMMIT / ROLLBACK
 *     pattern (or the template's withTransaction helper when present).
 *
 * It never fails a write; it annotates the tool result, like the
 * typecheck note it complements.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Members of the `ErrorCode` union declared in a lib/errors.ts source. */
export function parseErrorCodes(errorsSource: string): Set<string> {
  const m = errorsSource.match(/export\s+type\s+ErrorCode\s*=([\s\S]*?);/);
  if (!m) return new Set();
  return new Set([...m[1]!.matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map((x) => x[1]!));
}

export function backendContractViolations(projectDir: string, snippets: string[]): string[] {
  const joined = snippets.join('\n');
  if (!joined.trim()) return [];
  const violations: string[] = [];

  // 1) sendError codes outside the closed union.
  const errorsPath = path.join(projectDir, 'backend', 'src', 'lib', 'errors.ts');
  let codes: Set<string> | null = null;
  try { codes = parseErrorCodes(fs.readFileSync(errorsPath, 'utf8')); } catch { codes = null; }
  if (codes && codes.size > 0) {
    const used = new Set([...joined.matchAll(/sendError\s*\(\s*[^,]+,\s*'([A-Z][A-Z0-9_]*)'/g)].map((x) => x[1]!));
    for (const code of used) {
      if (!codes.has(code)) {
        violations.push(
          `sendError code '${code}' is NOT in the ErrorCode union of backend/src/lib/errors.ts (valid: ${[...codes].join(', ')}). ` +
          `Either use one of the valid codes or add '${code}' to the union AND to the STATUS map in that one file.`,
        );
      }
    }
  }

  // 2) better-sqlite3-style .transaction() on node:sqlite's DatabaseSync.
  if (/\.transaction\s*\(/.test(joined)) {
    violations.push(
      'DatabaseSync (node:sqlite) has NO .transaction() helper — that is better-sqlite3 API and will not compile/run here. ' +
      "Wrap the block explicitly: db.exec('BEGIN IMMEDIATE'); try { …; db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } " +
      '(or use the withTransaction(db, fn) helper from backend/src/db/index.ts when the project provides it).',
    );
  }
  return violations;
}

/** Note text to append to a backend write result, or null when clean. */
export function backendContractsNote(projectDir: string, snippets: string[]): string | null {
  try {
    const violations = backendContractViolations(projectDir, snippets);
    if (violations.length === 0) return null;
    return `Backend contract check (fix now, these fail the backend build later):\n${violations.map((v) => `- ${v}`).join('\n')}`;
  } catch {
    return null;
  }
}
