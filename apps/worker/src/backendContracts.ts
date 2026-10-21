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

// ---------------------------------------------------------------------------
// Core schema lint for migration writes (schema contract guard, 2026-10-21).
//
// Live case (project 07007457, run b6de6a05): the agent rewrote
// migrations/001_init.sql from scratch and its `sessions` table lost the
// `last_seen_at` column the template's session code writes on every
// create/validate. Register then failed with a 500 ERR_SQLITE_ERROR and
// run_api_tests cascaded to 10/17 — discovered only at test time. This lint
// flags a core CREATE TABLE that drops a required column in the SAME turn
// the migration is written. The authoritative check is the schema
// introspection in run_migrations (dynamicTools.ts); this is the early
// warning, and like the checks above it never blocks a write.
// ---------------------------------------------------------------------------

/** Columns the template's auth/session code requires, per core table. */
export const CORE_TABLE_REQUIRED_COLUMNS: Record<string, readonly string[]> = {
  users: ['id', 'email', 'password_hash', 'display_name', 'created_at', 'updated_at'],
  sessions: ['id', 'user_id', 'token_hash', 'created_at', 'expires_at', 'last_seen_at'],
};

/** First tokens that start a table-level constraint, never a column. */
const CONSTRAINT_STARTERS = new Set(['PRIMARY', 'FOREIGN', 'UNIQUE', 'CHECK', 'CONSTRAINT', 'KEY', 'INDEX']);

/**
 * Parse `CREATE TABLE` blocks out of SQL text: table name → set of column
 * names it defines. Pure text scanning (no SQL engine): the block body is
 * split on top-level commas and each definition contributes its first
 * token, skipping constraint lines (PRIMARY KEY / FOREIGN KEY / UNIQUE /
 * CHECK / CONSTRAINT / KEY / INDEX).
 */
export function parseCreateTableColumns(sql: string): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  const noComments = sql.replace(/--[^\n]*/g, '');
  const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?["'`[\]]?([A-Za-z_][A-Za-z0-9_]*)["'`\]]?\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(noComments)) !== null) {
    const table = m[1]!.toLowerCase();
    // Scan to the matching close paren (quote- and nesting-aware).
    let depth = 1;
    let inString = false;
    let end = re.lastIndex;
    for (; end < noComments.length; end++) {
      const ch = noComments[end]!;
      if (inString) {
        if (ch === "'") {
          if (noComments[end + 1] === "'") end++; // '' escape
          else inString = false;
        }
        continue;
      }
      if (ch === "'") inString = true;
      else if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    const body = noComments.slice(re.lastIndex, end);
    // Split the body on top-level commas only.
    const defs: string[] = [];
    let d = 0;
    let str = false;
    let start = 0;
    for (let i = 0; i <= body.length; i++) {
      const ch = body[i];
      if (i === body.length || (ch === ',' && d === 0 && !str)) {
        defs.push(body.slice(start, i));
        start = i + 1;
        continue;
      }
      if (str) {
        if (ch === "'") {
          if (body[i + 1] === "'") i++;
          else str = false;
        }
        continue;
      }
      if (ch === "'") str = true;
      else if (ch === '(') d++;
      else if (ch === ')') d--;
    }
    const cols = new Set<string>();
    for (const def of defs) {
      const token = def.trim().match(/^["'`[\]]?([A-Za-z_][A-Za-z0-9_]*)/)?.[1];
      if (!token) continue;
      if (CONSTRAINT_STARTERS.has(token.toUpperCase())) continue;
      cols.add(token.toLowerCase());
    }
    tables.set(table, cols);
    re.lastIndex = end + 1;
  }
  return tables;
}

/**
 * Violations found in migration SQL text: a CREATE TABLE for a core table
 * (users/sessions) that omits columns the template's auth/session code
 * requires. Other tables are not judged — new domain tables are the
 * project's own business.
 */
export function analyzeMigrationSql(content: string): string[] {
  const tables = parseCreateTableColumns(content);
  const violations: string[] = [];
  for (const [table, required] of Object.entries(CORE_TABLE_REQUIRED_COLUMNS)) {
    const cols = tables.get(table);
    if (!cols) continue;
    const missing = required.filter((c) => !cols.has(c));
    if (missing.length > 0) {
      violations.push(
        `CREATE TABLE ${table} is missing column(s) the template requires: ${missing.join(', ')}. ` +
          'The template auth/session code (backend/src/auth/routes.ts, backend/src/auth/session.ts) reads and writes exactly these columns — ' +
          'sessions.last_seen_at, for example, is written on every session create/validate, so a sessions table without it makes register fail with a 500 at runtime. ' +
          'run_migrations verifies the applied schema against the template and will refuse to pass while any core column is missing: ' +
          'restore the column here, or add it with ALTER TABLE in a NEW migration — never rewrite an already-applied migration.',
      );
    }
  }
  return violations;
}

/** Note text to append to a migrations write result, or null when clean. */
export function migrationSqlNote(snippets: string[]): string | null {
  try {
    const violations = analyzeMigrationSql(snippets.join('\n'));
    if (violations.length === 0) return null;
    return `Migration schema check (fix now, run_migrations will fail later):\n${violations.map((v) => `- ${v}`).join('\n')}`;
  } catch {
    return null;
  }
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
