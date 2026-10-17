/**
 * Fase 5B — controlled editing areas for dynamic projects.
 *
 * The file tools (read/write/patch/delete/list/mkdir/search) originally worked
 * only inside frontend/. For dynamic projects they now accept an explicit
 * `area` and resolve the path internally inside the active project:
 *
 *   { "area": "backend", "path": "src/routes/items.ts" }
 *
 * Static projects keep exactly their previous behaviour: no `area` parameter
 * is accepted and every path resolves under frontend/.
 *
 * Areas and their allowed shapes:
 *   frontend    -> frontend tree             (whole frontend tree)
 *   backend     -> backend/src tree          (source code only)
 *   migrations  -> migrations top-level     (SQL files only)
 *   tests       -> tests top-level          (test files only)
 *
 * Always forbidden (AppForge-controlled or sensitive), in every area:
 *   .env*, data/, backups/, metadata/, logs/, node_modules/, dist/, .git/,
 *   Dockerfile, docker-compose.yml, package.json, lockfiles, scripts/.
 *
 * Hardening on every resolution: absolute paths, `..` escape, null bytes
 * (via resolveIn), symlink escape (realpath must stay inside the area root),
 * max file size and UTF-8 text only for reads/writes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveIn } from './paths.js';
import type { ToolContext } from './tools.js';

/** Tiny project-type lookup (kept local to avoid a tools<->dynamicTools cycle). */
function isDynamicProject(ctx: ToolContext): boolean {
  try {
    const row = ctx.db
      .prepare('SELECT type FROM projects WHERE id=?')
      .get(ctx.projectId) as { type?: string } | undefined;
    return row?.type === 'dynamic';
  } catch {
    return false;
  }
}

export type DynamicArea = 'frontend' | 'backend' | 'migrations' | 'tests';

const AREA_NAMES: DynamicArea[] = ['frontend', 'backend', 'migrations', 'tests'];

/** Max bytes for a single read/write/patch through the file tools. */
export const AREA_MAX_FILE_BYTES = 1_000_000;

interface AreaDef {
  /** Directory inside the project that is the root of this area. */
  dir: string;
  /** Allowed relative (posix) shapes inside the area. */
  allowed: RegExp;
  /** Human hint used in errors and docs. */
  hint: string;
}

const AREA_DEFS: Record<DynamicArea, AreaDef> = {
  frontend: { dir: 'frontend', allowed: /^.*$/, hint: 'frontend/**/*' },
  backend: { dir: 'backend', allowed: /^(\.|src(\/.*)?)$/, hint: 'backend/src/**/*' },
  migrations: { dir: 'migrations', allowed: /^(\.|[^/]+\.sql)$/, hint: 'migrations/*.sql' },
  tests: { dir: 'tests', allowed: /^(\.|[^/]+\.test\.mjs)$/, hint: 'tests/*.test.mjs' },
};

/** Paths AppForge keeps under its own control (never LLM-editable). */
const FORBIDDEN: Array<{ re: RegExp; why: string }> = [
  { re: /^\.env(\.|$)/, why: '.env files are AppForge-controlled' },
  { re: /^data(\/|$)/, why: 'data/ is a runtime directory' },
  { re: /^backups(\/|$)/, why: 'backups/ is AppForge-controlled' },
  { re: /^metadata(\/|$)/, why: 'metadata/ is AppForge-controlled' },
  { re: /^logs(\/|$)/, why: 'logs/ is a runtime directory' },
  { re: /^node_modules(\/|$)/, why: 'node_modules/ is managed by the installer' },
  { re: /^dist(\/|$)/, why: 'dist/ is a build artifact' },
  { re: /^\.git(\/|$)/, why: '.git/ is AppForge-controlled' },
  { re: /^Dockerfile$/, why: 'Dockerfile is AppForge-controlled' },
  { re: /^docker-compose\.ya?ml$/, why: 'docker-compose.yml is AppForge-controlled' },
  { re: /^package\.json$/, why: 'package.json is AppForge-controlled (dependencies and scripts)' },
  { re: /^(package-lock\.json|pnpm-lock\.ya?ml|yarn\.lock)$/, why: 'lockfiles are AppForge-controlled' },
  { re: /^scripts(\/|$)/, why: 'scripts/ are AppForge-controlled operational scripts' },
];

export class AreaError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function areaArg(raw: unknown): DynamicArea | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string' || !AREA_NAMES.includes(raw as DynamicArea)) {
    throw new AreaError(
      'INVALID_AREA',
      `area must be one of ${AREA_NAMES.join(', ')}; received ${JSON.stringify(raw)}`,
    );
  }
  return raw as DynamicArea;
}

/** Reject symlink escapes: the real path must stay inside the area root. */
function assertNoSymlinkEscape(areaRoot: string, abs: string, label: string): void {
  const realRoot = fs.realpathSync(areaRoot);
  let cur = abs;
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  const realCur = fs.realpathSync(cur);
  if (realCur !== realRoot && !realCur.startsWith(realRoot + path.sep)) {
    throw new AreaError('SYMLINK_ESCAPE', `${label}: path escapes its area through a symlink`);
  }
}

export interface ResolvedAreaPath {
  /** The validated area (null for static projects, which resolve under frontend/). */
  area: DynamicArea | null;
  /** Absolute path inside the area root. */
  abs: string;
  /** The area root directory. */
  root: string;
  /** Relative posix path inside the area root. */
  rel: string;
}

/**
 * Resolve a file-tool path for the active project.
 *
 * Static projects: `area` must not be provided; resolves under frontend/
 * exactly as before (unchanged behaviour).
 *
 * Dynamic projects: `area` defaults to 'frontend'; the path is resolved
 * inside the area root and validated against the allowed shapes and the
 * forbidden list.
 */
export function resolveAreaPath(
  ctx: ToolContext,
  rawArea: unknown,
  p: string,
): ResolvedAreaPath {
  const dynamic = isDynamicProject(ctx);
  const area = areaArg(rawArea);

  if (!dynamic) {
    if (area !== undefined) {
      throw new AreaError(
        'AREA_NOT_SUPPORTED',
        'the "area" parameter is only available on dynamic projects',
      );
    }
    return {
      area: null,
      abs: resolveIn(ctx.frontendDir, p),
      root: path.resolve(ctx.frontendDir),
      rel: toRel(path.resolve(ctx.frontendDir), resolveIn(ctx.frontendDir, p)),
    };
  }

  const chosen: DynamicArea = area ?? 'frontend';
  const def = AREA_DEFS[chosen];
  const areaRoot = path.join(ctx.projectDir, def.dir);
  if (!fs.existsSync(areaRoot)) {
    throw new AreaError('AREA_MISSING', `area "${chosen}" is not scaffolded in this project`);
  }
  if (typeof p !== 'string' || p.length === 0) {
    throw new AreaError('INVALID_PATH', 'path must be a non-empty string');
  }
  if (path.isAbsolute(p)) {
    throw new AreaError('INVALID_PATH', 'absolute paths are not allowed; use a path relative to the area');
  }
  const abs = resolveIn(areaRoot, p);
  const rel = toRel(path.resolve(areaRoot), abs);
  const relPosix = rel.split(path.sep).join('/');
  if (!def.allowed.test(relPosix)) {
    throw new AreaError(
      'AREA_PATH_NOT_ALLOWED',
      `"${p}" is outside the allowed shape for area "${chosen}" (${def.hint})`,
    );
  }
  for (const f of FORBIDDEN) {
    if (f.re.test(relPosix)) {
      throw new AreaError('AREA_PATH_FORBIDDEN', `"${p}": ${f.why}`);
    }
  }
  assertNoSymlinkEscape(areaRoot, abs, p);
  return { area: chosen, abs, root: path.resolve(areaRoot), rel: relPosix };
}

function toRel(root: string, abs: string): string {
  const rel = path.relative(root, abs);
  return rel === '' ? '.' : rel;
}

/** Validate that a Buffer/string is UTF-8 text of acceptable size. */
export function assertAreaText(content: string, label: string): void {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > AREA_MAX_FILE_BYTES) {
    throw new AreaError('FILE_TOO_LARGE', `${label} exceeds ${AREA_MAX_FILE_BYTES} bytes`);
  }
  // A JS string cannot hold invalid UTF-8 except lone surrogates; the
  // round-trip catches those.
  const buf = Buffer.from(content, 'utf8');
  if (buf.toString('utf8') !== content) {
    throw new AreaError('NOT_UTF8_TEXT', `${label} is not valid UTF-8 text`);
  }
}

/**
 * Read a file as strict UTF-8 text. Decodes the ORIGINAL bytes with a fatal
 * TextDecoder: any invalid UTF-8 sequence throws NOT_UTF8_TEXT instead of
 * being silently replaced with U+FFFD (which fs.readFileSync(path, 'utf8')
 * does).
 */
export function readAreaTextFile(abs: string, label: string): string {
  let raw: Buffer;
  try {
    raw = fs.readFileSync(abs);
  } catch (e) {
    throw e;
  }
  if (raw.length > AREA_MAX_FILE_BYTES) {
    throw new AreaError('FILE_TOO_LARGE', `${label} exceeds ${AREA_MAX_FILE_BYTES} bytes`);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    throw new AreaError('NOT_UTF8_TEXT', `${label} is not valid UTF-8 text`);
  }
}

export function isAreaError(e: unknown): e is AreaError {
  return e instanceof AreaError;
}

export { AREA_NAMES, AREA_DEFS };
