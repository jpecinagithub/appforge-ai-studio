/**
 * Agent tools (CONTRACT.md §6). Every tool is confined to the active project:
 * any path that resolves outside the project directory is rejected with
 * INVALID_PATH. `run_command` uses an allowlist and execFile WITHOUT a shell.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { FileNode, ToolResult } from 'appforge-shared';
import type { ToolDef } from './llm.js';
import { dependencyFingerprint, lockMatchesManifest, sourceFingerprint } from './fingerprint.js';
import { checkBrowser, type BrowserStep, type BrowserSession } from './browser.js';

export interface ToolContext {
  db: Database.Database;
  projectId: string;
  /** $DATA_DIR/projects/{id} — file tools are confined here */
  projectDir: string;
  /** $DATA_DIR/projects/{id}/frontend — run_command cwd, build/install root */
  frontendDir: string;
  cmdTimeoutMs: number;
  /** longer timeout for npm install / npm run build */
  buildTimeoutMs: number;
  /** In-memory receipts are valid only for exactly the sources that were checked. */
  builtFingerprint?: string;
  browserFingerprint?: string;
  interactionFingerprint?: string;
  interactiveControls?: number;
  /** Server-created build record; the manual Rebuild uses the same pipeline. */
  buildId?: string;
  browserSession?: BrowserSession;
  lastBrowserSteps?: BrowserStep[];
  lastBrowserStart?: BrowserSession;
}

export type ToolHandler = (ctx: ToolContext, args: Record<string, unknown>) => Promise<ToolResult>;

const TRUNC_CHARS = 20_000;
const MAX_FILE_BYTES = 1_000_000;
const MAX_IMAGE_BYTES = 12_000_000;
const IGNORED_DIRS = new Set(['node_modules', 'dist', '.git']);

export const nowIso = () => new Date().toISOString();

function trunc(s: string): string {
  return s.length > TRUNC_CHARS ? s.slice(0, TRUNC_CHARS) + `\n…[truncated ${s.length - TRUNC_CHARS} chars]` : s;
}

function fail(code: string, error: string, durationMs = 0): ToolResult {
  return { ok: false, code, error, durationMs };
}

function strArg(args: Record<string, unknown>, name: string, required = true): string {
  const v = args[name];
  if (v === undefined || v === null) {
    if (required) throw new Error(`missing required argument: ${name}`);
    return '';
  }
  if (typeof v !== 'string') throw new Error(`argument ${name} must be a string`);
  return v;
}

/**
 * Content para write_file: tolerante con objetos/arrays (el modelo a veces
 * pasa el objeto JS en vez del texto JSON). Los serializa con indentación.
 */
function contentArg(args: Record<string, unknown>): string {
  const v = args['content'];
  if (v === undefined || v === null) throw new Error('missing required argument: content');
  if (typeof v === 'string') return v;
  if (typeof v === 'object') return JSON.stringify(v, null, 2);
  throw new Error(`argument content must be a string (got ${typeof v})`);
}

/**
 * Resolve `p` inside `root`. Rejects absolute paths, null bytes and any
 * path escaping `root` (e.g. `../` traversal) with an INVALID_PATH error.
 */
export function resolveIn(root: string, p: string): string {
  if (typeof p !== 'string' || p.length === 0 || p.includes('\0')) {
    const e = new Error(`invalid path: ${JSON.stringify(p)}`) as Error & { code: string };
    e.code = 'INVALID_PATH';
    throw e;
  }
  const absRoot = path.resolve(root);
  const resolved = path.resolve(absRoot, p);
  if (resolved !== absRoot && !resolved.startsWith(absRoot + path.sep)) {
    const e = new Error(`path escapes project directory: ${p}`) as Error & { code: string };
    e.code = 'INVALID_PATH';
    throw e;
  }
  return resolved;
}

/** Run a command without a shell, capturing output. Shared with the server (builds/git). */
export async function runCmd(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<{ code: number; stdout: string; stderr: string; durationMs: number; timedOut: boolean }> {
  const t0 = Date.now();
  // Windows cannot execute npm.cmd/npx.cmd with shell:false. Invoke their
  // JavaScript entry point with the current Node binary instead.
  let executable = cmd;
  let executableArgs = args;
  if (process.platform === 'win32' && /^(npm|npx)$/i.test(cmd)) {
    const bin = cmd.toLowerCase();
    const fromEnv = bin === 'npm' ? process.env.npm_execpath : process.env.npx_execpath;
    const cli = fromEnv ?? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', `${bin}-cli.js`);
    executable = process.execPath;
    executableArgs = [cli, ...args];
  }
  return new Promise((resolve) => {
    execFile(executable, executableArgs, { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 32 * 1024 * 1024, env: opts.env }, (err, stdout, stderr) => {
      const durationMs = Date.now() - t0;
      const timedOut = !!err && ((err as NodeJS.ErrnoException & { killed?: boolean }).killed === true || /timed out/i.test(err.message));
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code as number) : 1) : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), durationMs, timedOut });
    });
  });
}

function relPosix(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/');
}

function buildTree(root: string, dir: string, relBase: string): FileNode[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const nodes: FileNode[] = [];
  for (const e of entries) {
    if (e.name === '.' || e.name === '..') continue;
    if (e.isDirectory() && IGNORED_DIRS.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    const rel = relBase ? `${relBase}/${e.name}` : e.name;
    if (e.isDirectory()) {
      nodes.push({ name: e.name, path: rel, type: 'dir', children: buildTree(root, abs, rel) });
    } else if (e.isFile()) {
      nodes.push({ name: e.name, path: rel, type: 'file' });
    }
  }
  nodes.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return nodes;
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function listFiles(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const t0 = Date.now();
  try {
    const sub = args.path === undefined ? '.' : strArg(args, 'path');
    const dir = resolveIn(ctx.frontendDir, sub);
    const st = fs.statSync(dir);
    if (!st.isDirectory()) return fail('NOT_A_DIRECTORY', `${sub} is not a directory`, Date.now() - t0);
    return { ok: true, data: buildTree(ctx.frontendDir, dir, relPosix(ctx.frontendDir, dir) === '' ? '' : relPosix(ctx.frontendDir, dir)), durationMs: Date.now() - t0 };
  } catch (e) {
    return fail((e as { code?: string }).code ?? 'LIST_FAILED', (e as Error).message, Date.now() - t0);
  }
}

async function readFile(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const t0 = Date.now();
  try {
    const p = strArg(args, 'path');
    const abs = resolveIn(ctx.frontendDir, p);
    const st = fs.statSync(abs);
    if (!st.isFile()) return fail('NOT_A_FILE', `${p} is not a file`, Date.now() - t0);
    if (st.size > MAX_FILE_BYTES) return fail('FILE_TOO_LARGE', `${p} exceeds ${MAX_FILE_BYTES} bytes`, Date.now() - t0);
    return { ok: true, data: { content: fs.readFileSync(abs, 'utf8') }, durationMs: Date.now() - t0 };
  } catch (e) {
    const code = (e as { code?: string }).code;
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fail('FILE_NOT_FOUND', `file not found: ${args.path}`, Date.now() - t0);
    return fail(code ?? 'READ_FAILED', (e as Error).message, Date.now() - t0);
  }
}

async function writeFile(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const t0 = Date.now();
  try {
    const p = strArg(args, 'path');
    const content = contentArg(args);
    const abs = resolveIn(ctx.frontendDir, p);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    return { ok: true, data: { bytes: Buffer.byteLength(content, 'utf8') }, durationMs: Date.now() - t0 };
  } catch (e) {
    return fail((e as { code?: string }).code ?? 'WRITE_FAILED', (e as Error).message, Date.now() - t0);
  }
}

async function writeFiles(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const t0 = Date.now();
  try {
    if (!Array.isArray(args.files) || args.files.length === 0 || args.files.length > 20) throw new Error('files must contain 1 to 20 files');
    // Validate the entire batch before writing any file.
    const files = args.files.map((file) => {
      const p = strArg(file, 'path');
      const content = contentArg(file);
      return { path: p, abs: resolveIn(ctx.frontendDir, p), content };
    });
    for (const file of files) {
      fs.mkdirSync(path.dirname(file.abs), { recursive: true });
      fs.writeFileSync(file.abs, file.content, 'utf8');
    }
    return { ok: true, data: { paths: files.map((file) => file.path) }, durationMs: Date.now() - t0 };
  } catch (e) {
    return fail((e as { code?: string }).code ?? 'WRITE_FAILED', (e as Error).message, Date.now() - t0);
  }
}

/** Replaces the FIRST occurrence of `search` in the file. */
async function patchFile(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const t0 = Date.now();
  try {
    const p = strArg(args, 'path');
    const search = strArg(args, 'search');
    const replace = strArg(args, 'replace');
    const abs = resolveIn(ctx.frontendDir, p);
    const current = fs.readFileSync(abs, 'utf8');
    if (!current.includes(search)) return fail('PATCH_NOT_FOUND', `search string not found in ${p}`, Date.now() - t0);
    fs.writeFileSync(abs, current.replace(search, replace), 'utf8');
    return { ok: true, data: { replacements: 1 }, durationMs: Date.now() - t0 };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fail('FILE_NOT_FOUND', `file not found: ${args.path}`, Date.now() - t0);
    return fail((e as { code?: string }).code ?? 'PATCH_FAILED', (e as Error).message, Date.now() - t0);
  }
}

async function deleteFile(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const t0 = Date.now();
  try {
    const p = strArg(args, 'path');
    const abs = resolveIn(ctx.frontendDir, p);
    const st = fs.statSync(abs);
    fs.rmSync(abs, { recursive: st.isDirectory(), force: true });
    return { ok: true, data: { deleted: p }, durationMs: Date.now() - t0 };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fail('FILE_NOT_FOUND', `not found: ${args.path}`, Date.now() - t0);
    return fail((e as { code?: string }).code ?? 'DELETE_FAILED', (e as Error).message, Date.now() - t0);
  }
}

async function createDirectory(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const t0 = Date.now();
  try {
    const p = strArg(args, 'path');
    fs.mkdirSync(resolveIn(ctx.frontendDir, p), { recursive: true });
    return { ok: true, durationMs: Date.now() - t0 };
  } catch (e) {
    return fail((e as { code?: string }).code ?? 'MKDIR_FAILED', (e as Error).message, Date.now() - t0);
  }
}

type OpenverseImage = {
  title?: string;
  creator?: string;
  creator_url?: string;
  license?: string;
  license_version?: string;
  license_url?: string;
  source?: string;
  url?: string;
  thumbnail?: string;
  foreign_landing_url?: string;
  width?: number;
  height?: number;
  mature?: boolean;
};

function imageExtension(contentType: string): string | null {
  const mime = contentType.split(';', 1)[0]?.trim().toLowerCase();
  if (mime === 'image/jpeg') return '.jpg';
  if (mime === 'image/png') return '.png';
  if (mime === 'image/webp') return '.webp';
  return null;
}

function assetPathWithExtension(requestedPath: string, extension: string): string {
  const current = path.extname(requestedPath).toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.webp'].includes(current)) {
    return requestedPath.slice(0, -current.length) + extension;
  }
  return requestedPath + extension;
}

/**
 * Finds a reusable photograph through Openverse, downloads it into public/
 * and writes a sidecar attribution receipt. Only licenses that permit
 * commercial reuse are requested; the app must still render the credit.
 */
async function acquireImage(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const t0 = Date.now();
  try {
    const query = strArg(args, 'query').trim();
    const requestedPath = strArg(args, 'path').replaceAll('\\', '/');
    if (query.length < 2 || query.length > 160) return fail('INVALID_QUERY', 'query must contain 2 to 160 characters', Date.now() - t0);
    if (!requestedPath.startsWith('public/')) return fail('INVALID_PATH', 'image assets must be saved below public/', Date.now() - t0);

    const endpoint = new URL('https://api.openverse.org/v1/images/');
    endpoint.searchParams.set('q', query);
    endpoint.searchParams.set('license', 'cc0,pdm,by,by-sa');
    endpoint.searchParams.set('page_size', '20');
    endpoint.searchParams.set('mature', 'false');
    const search = await fetch(endpoint, {
      headers: { Accept: 'application/json', 'User-Agent': 'AppForge-AI-Studio/0.1 (licensed asset acquisition)' },
      signal: AbortSignal.timeout(Math.min(ctx.cmdTimeoutMs, 30_000)),
    });
    if (!search.ok) return fail('IMAGE_SEARCH_FAILED', `Openverse returned HTTP ${search.status}`, Date.now() - t0);
    const payload = (await search.json()) as { results?: OpenverseImage[] };
    const candidates = (payload.results ?? [])
      .filter((item) => !item.mature
        && /^https:\/\//.test(item.url ?? '')
        && /^https:\/\//.test(item.foreign_landing_url ?? '')
        && /^https:\/\/api\.openverse\.org\//.test(item.thumbnail ?? ''))
      .sort((a, b) => {
        const aPixels = (a.width ?? 0) * (a.height ?? 0);
        const bPixels = (b.width ?? 0) * (b.height ?? 0);
        const aLandscape = (a.width ?? 0) >= (a.height ?? Infinity) ? 1 : 0;
        const bLandscape = (b.width ?? 0) >= (b.height ?? Infinity) ? 1 : 0;
        return bLandscape - aLandscape || bPixels - aPixels;
      });
    if (candidates.length === 0) return fail('IMAGE_NOT_FOUND', `No reusable photograph found for "${query}"`, Date.now() - t0);

    let selected: OpenverseImage | undefined;
    let bytes: Buffer | undefined;
    let extension: string | null = null;
    for (const candidate of candidates.slice(0, 6)) {
      try {
        // Download through Openverse's thumbnail proxy instead of contacting
        // arbitrary source hosts returned by the search index (SSRF boundary).
        const response = await fetch(candidate.thumbnail!, {
          headers: { Accept: 'image/jpeg,image/png,image/webp', 'User-Agent': 'AppForge-AI-Studio/0.1 (licensed asset acquisition)' },
          redirect: 'error',
          signal: AbortSignal.timeout(Math.min(ctx.cmdTimeoutMs, 30_000)),
        });
        extension = imageExtension(response.headers.get('content-type') ?? '');
        const announced = Number(response.headers.get('content-length') ?? 0);
        if (!response.ok || !extension || announced > MAX_IMAGE_BYTES) continue;
        const downloaded = Buffer.from(await response.arrayBuffer());
        if (downloaded.length === 0 || downloaded.length > MAX_IMAGE_BYTES) continue;
        selected = candidate;
        bytes = downloaded;
        break;
      } catch {
        // Try the next licensed candidate when a source host is unavailable.
      }
    }
    if (!selected || !bytes || !extension) return fail('IMAGE_DOWNLOAD_FAILED', `Reusable images were found for "${query}", but none could be downloaded safely`, Date.now() - t0);

    const relativePath = assetPathWithExtension(requestedPath, extension);
    const absolutePath = resolveIn(ctx.frontendDir, relativePath);
    const receiptPath = `${absolutePath}.license.json`;
    if (fs.existsSync(absolutePath) || fs.existsSync(receiptPath)) {
      return fail('ASSET_EXISTS', `refusing to overwrite existing asset: ${relativePath}`, Date.now() - t0);
    }
    const attribution = {
      title: selected.title ?? query,
      creator: selected.creator ?? 'Unknown creator',
      creatorUrl: selected.creator_url ?? null,
      license: `${(selected.license ?? 'unknown').toUpperCase()}${selected.license_version ? ` ${selected.license_version}` : ''}`,
      licenseUrl: selected.license_url ?? null,
      source: selected.source ?? 'Openverse',
      sourceUrl: selected.foreign_landing_url,
      originalUrl: selected.url,
      query,
      acquiredAt: nowIso(),
    };
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, bytes);
    fs.writeFileSync(receiptPath, JSON.stringify(attribution, null, 2) + '\n', 'utf8');
    return {
      ok: true,
      data: {
        path: relativePath,
        publicUrl: './' + relativePath.slice('public/'.length),
        attribution,
        attributionPath: relPosix(ctx.frontendDir, receiptPath),
        width: selected.width ?? null,
        height: selected.height ?? null,
      },
      durationMs: Date.now() - t0,
    };
  } catch (e) {
    const name = (e as Error).name;
    const code = name === 'TimeoutError' || name === 'AbortError' ? 'IMAGE_TIMEOUT' : ((e as { code?: string }).code ?? 'IMAGE_ACQUISITION_FAILED');
    return fail(code, (e as Error).message, Date.now() - t0);
  }
}

function isTextFile(abs: string): boolean {
  const textExt = new Set(['.ts', '.tsx', '.js', '.jsx', '.json', '.css', '.html', '.md', '.txt', '.yml', '.yaml', '.toml', '.svg', '.env']);
  if (textExt.has(path.extname(abs).toLowerCase())) return true;
  try {
    const head = fs.readFileSync(abs, { flag: 'r' }).subarray(0, 8000) as Buffer;
    return !head.includes(0);
  } catch {
    return false;
  }
}

async function searchCode(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const t0 = Date.now();
  try {
    const pattern = strArg(args, 'pattern');
    const matches: Array<{ file: string; line: number; text: string }> = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (matches.length >= 200) return;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!IGNORED_DIRS.has(e.name)) walk(abs);
        } else if (e.isFile()) {
          try {
            if (fs.statSync(abs).size > MAX_FILE_BYTES || !isTextFile(abs)) continue;
            const lines = fs.readFileSync(abs, 'utf8').split('\n');
            lines.forEach((text, i) => {
              if (matches.length < 200 && text.includes(pattern)) {
                matches.push({ file: relPosix(ctx.frontendDir, abs), line: i + 1, text: text.slice(0, 300) });
              }
            });
          } catch {
            /* unreadable — skip */
          }
        }
      }
    };
    walk(ctx.frontendDir);
    return { ok: true, data: { matches, truncated: matches.length >= 200 }, durationMs: Date.now() - t0 };
  } catch (e) {
    return fail((e as { code?: string }).code ?? 'SEARCH_FAILED', (e as Error).message, Date.now() - t0);
  }
}

async function installDependencies(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const t0 = Date.now();
  void args;
  const receipt = path.join(ctx.frontendDir, 'node_modules', '.appforge-dependencies');
  const fingerprint = dependencyFingerprint(ctx.frontendDir);
  if (fs.existsSync(receipt) && fs.readFileSync(receipt, 'utf8') === fingerprint) {
    return { ok: true, output: 'Dependencies already match package.json and package-lock.json.', durationMs: Date.now() - t0 };
  }
  // A generated package.json may add dependencies without updating its lockfile.
  const lock = lockMatchesManifest(ctx.frontendDir);
  const npmArgs = lock ? ['ci', '--no-audit', '--no-fund'] : ['install', '--no-audit', '--no-fund'];
  const r = await runCmd('npm', npmArgs, { cwd: ctx.frontendDir, timeoutMs: ctx.buildTimeoutMs });
  const output = trunc(`$ npm ${npmArgs.join(' ')}\n${r.stdout}\n${r.stderr}`);
  if (r.timedOut) return { ok: false, code: 'INSTALL_TIMEOUT', error: 'npm install timed out', durationMs: r.durationMs, output };
  if (r.code !== 0) return { ok: false, code: 'INSTALL_FAILED', error: `npm install exited with code ${r.code}`, durationMs: r.durationMs, output };
  fs.mkdirSync(path.dirname(receipt), { recursive: true });
  fs.writeFileSync(receipt, dependencyFingerprint(ctx.frontendDir), 'utf8');
  return { ok: true, durationMs: r.durationMs, output };
}

function dirSizeSync(dir: string): number {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSizeSync(p);
    else if (e.isFile()) total += fs.statSync(p).size;
  }
  return total;
}

async function runBuild(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const t0 = Date.now();
  void args;
  // Registra el build en la BD para que la pestaña Builds del estudio lo muestre.
  const buildId = ctx.buildId ?? randomUUID();
  if (ctx.buildId) ctx.db.prepare("UPDATE builds SET status='running', started_at=? WHERE id=?").run(nowIso(), buildId);
  else ctx.db
    .prepare(
      'INSERT INTO builds(id, project_id, status, started_at, finished_at, duration_ms, logs, artifacts_json, error) VALUES (?,?,?,?,?,?,?,?,?)',
    )
    .run(buildId, ctx.projectId, 'running', nowIso(), null, null, '', null, null);
  const finish = (status: string, logs: string, artifacts: unknown, error: string | null, durationMs: number) => {
    ctx.db
      .prepare('UPDATE builds SET status=?, finished_at=?, duration_ms=?, logs=?, artifacts_json=?, error=? WHERE id=?')
      .run(status, nowIso(), durationMs, logs, artifacts ? JSON.stringify(artifacts) : null, error, buildId);
  };
  ctx.builtFingerprint = undefined;
  ctx.browserFingerprint = undefined;
  ctx.interactionFingerprint = undefined;
  const installed = await installDependencies(ctx, {});
  if (!installed.ok) {
    finish('failed', installed.output ?? '', null, installed.error ?? 'dependency installation failed', Date.now() - t0);
    return installed;
  }
  const inputFingerprint = sourceFingerprint(ctx.frontendDir);
  const r = await runCmd('npm', ['run', 'build'], { cwd: ctx.frontendDir, timeoutMs: ctx.buildTimeoutMs });
  const output = trunc(`${installed.output}\n$ npm run build\n${r.stdout}\n${r.stderr}`);
  if (r.timedOut) {
    finish('failed', output, null, 'build timed out', r.durationMs);
    return { ok: false, code: 'BUILD_TIMEOUT', error: 'build timed out', durationMs: r.durationMs, output };
  }
  if (r.code !== 0) {
    finish('failed', output, null, `build exited with code ${r.code}`, r.durationMs);
    return { ok: false, code: 'BUILD_FAILED', error: `build exited with code ${r.code}`, durationMs: r.durationMs, output };
  }
  const distIndex = path.join(ctx.frontendDir, 'dist', 'index.html');
  if (!fs.existsSync(distIndex)) {
    finish('failed', output, null, 'build succeeded but dist/index.html is missing', r.durationMs);
    return { ok: false, code: 'BUILD_NO_OUTPUT', error: 'build succeeded but dist/index.html is missing', durationMs: r.durationMs, output };
  }
  const durationMs = Date.now() - t0;
  if (sourceFingerprint(ctx.frontendDir) !== inputFingerprint) {
    finish('failed', output, null, 'source files changed during build; rebuild required', durationMs);
    return fail('BUILD_SOURCE_CHANGED', 'source files changed during build; rebuild required', durationMs);
  }
  ctx.builtFingerprint = inputFingerprint;
  finish('success', output, { distSize: dirSizeSync(path.join(ctx.frontendDir, 'dist')) }, null, durationMs);
  return { ok: true, data: { dist: 'dist/index.html', buildId }, durationMs, output };
}

/**
 * start_preview: ensure the production build exists and mark the preview as
 * ready. The server serves it at /p/:projectId/ from frontend/dist.
 */
async function startPreview(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const t0 = Date.now();
  void args;
  const distIndex = path.join(ctx.frontendDir, 'dist', 'index.html');
  if (!fs.existsSync(distIndex) || ctx.builtFingerprint !== sourceFingerprint(ctx.frontendDir)) {
    const built = await runBuild(ctx, {});
    if (!built.ok) {
      return { ok: false, code: 'PREVIEW_BUILD_FAILED', error: built.error, durationMs: Date.now() - t0, output: built.output };
    }
  }
  if (ctx.browserFingerprint !== ctx.builtFingerprint) {
    if (ctx.lastBrowserSteps?.length) ctx.browserSession = structuredClone(ctx.lastBrowserStart ?? {});
    const tested = await testPreview(ctx, { steps: ctx.lastBrowserSteps ?? [] });
    if (!tested.ok) return tested;
  }
  const url = `/p/${ctx.projectId}/`;
  ctx.db.prepare('UPDATE projects SET preview_url=?, updated_at=? WHERE id=?').run(url, nowIso(), ctx.projectId);
  return { ok: true, data: { url, status: 'ready' }, durationMs: Date.now() - t0 };
}

async function testPreview(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const steps = (args.steps ?? []) as BrowserStep[];
  if (!Array.isArray(steps) || steps.length > 12) return fail('INVALID_ARGS', 'steps must be an array of at most 12 actions');
  if (ctx.builtFingerprint !== sourceFingerprint(ctx.frontendDir)) {
    const built = await runBuild(ctx, {});
    if (!built.ok) return built;
  }
  // Invalidate previous checks first, including a failed interaction test.
  ctx.browserFingerprint = undefined;
  ctx.interactionFingerprint = undefined;
  ctx.browserSession ??= {};
  const startingSession = structuredClone(ctx.browserSession);
  const distDir = path.join(ctx.frontendDir, 'dist');
  const screenshotPath = path.join(distDir, '__appforge', 'thumbnail.webp');
  const result = await checkBrowser(distDir, ctx.projectId, steps, Math.min(ctx.cmdTimeoutMs, 45_000), ctx.browserSession, screenshotPath);
  if (result.ok && ctx.builtFingerprint === sourceFingerprint(ctx.frontendDir)) {
    ctx.interactiveControls = (result.data as { interactiveControls: number }).interactiveControls;
    ctx.browserFingerprint = ctx.builtFingerprint;
    if (steps.length > 0) {
      ctx.lastBrowserSteps = steps;
      ctx.lastBrowserStart = startingSession;
    }
    if (steps.some((step) => ['click', 'fill', 'select'].includes(step.action)) && steps.some((step) => step.action === 'expect_text')) {
      ctx.interactionFingerprint = ctx.builtFingerprint;
    }
  }
  return result;
}

async function gitCommit(ctx: ToolContext, label: string): Promise<{ sha: string; empty: boolean }> {
  const cwd = ctx.projectDir;
  await runCmd('git', ['add', '-A'], { cwd, timeoutMs: 30_000 });
  const status = await runCmd('git', ['status', '--porcelain'], { cwd, timeoutMs: 30_000 });
  if (status.code !== 0) throw new Error(`git status failed: ${status.stderr.slice(0, 500)}`);
  const empty = status.stdout.trim().length === 0;
  if (!empty) {
    const commit = await runCmd(
      'git',
      ['-c', 'user.name=AppForge', '-c', 'user.email=appforge@local', 'commit', '-m', label],
      { cwd, timeoutMs: 30_000 },
    );
    if (commit.code !== 0) throw new Error(`git commit failed: ${(commit.stdout + commit.stderr).slice(0, 500)}`);
  }
  const rev = await runCmd('git', ['rev-parse', 'HEAD'], { cwd, timeoutMs: 30_000 });
  if (rev.code !== 0) throw new Error('git rev-parse HEAD failed (no commits yet?)');
  return { sha: rev.stdout.trim(), empty };
}

async function createRevision(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const t0 = Date.now();
  try {
    const label = typeof args.label === 'string' && args.label.length > 0 ? args.label : 'checkpoint';
    const { sha, empty } = await gitCommit(ctx, label);
    const id = randomUUID();
    ctx.db
      .prepare('INSERT INTO revisions(id, project_id, label, git_sha, created_at) VALUES (?,?,?,?,?)')
      .run(id, ctx.projectId, label, sha, nowIso());
    return { ok: true, data: { id, sha, empty }, durationMs: Date.now() - t0 };
  } catch (e) {
    return fail('REVISION_FAILED', (e as Error).message, Date.now() - t0);
  }
}

const ALLOWED_COMMANDS = new Set(['npm', 'npx', 'node']);

async function runCommand(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const t0 = Date.now();
  const cmd = strArg(args, 'cmd');
  if (!ALLOWED_COMMANDS.has(cmd)) {
    return fail('COMMAND_NOT_ALLOWED', `command "${cmd}" is not allowlisted (allowed: npm, npx, node)`, Date.now() - t0);
  }
  const rawArgs = args.args ?? [];
  if (!Array.isArray(rawArgs) || rawArgs.some((a) => typeof a !== 'string')) {
    return fail('INVALID_ARGS', 'args must be an array of strings', Date.now() - t0);
  }
  const r = await runCmd(cmd, rawArgs as string[], { cwd: ctx.frontendDir, timeoutMs: ctx.cmdTimeoutMs });
  const output = trunc(`${r.stdout}\n${r.stderr}`);
  if (r.timedOut) return { ok: false, code: 'CMD_TIMEOUT', error: `command timed out after ${ctx.cmdTimeoutMs}ms`, durationMs: r.durationMs, output };
  if (r.code !== 0) return { ok: false, code: 'CMD_FAILED', error: `command exited with code ${r.code}`, durationMs: r.durationMs, output };
  return { ok: true, durationMs: r.durationMs, output };
}

// ---------------------------------------------------------------------------
// Registry + OpenAI function schemas (flat, per contract)
// ---------------------------------------------------------------------------

const S = (description: string) => ({ type: 'string', description });

export const TOOL_DEFS: ToolDef[] = [
  { name: 'write_files', description: 'Write a complete set of related files in ONE call. Preferred when implementing a new app; paths relative to frontend/.', parameters: { type: 'object', properties: { files: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', properties: { path: S('Relative path'), content: S('Complete file text') }, required: ['path', 'content'], additionalProperties: false } } }, required: ['files'], additionalProperties: false } },
  { name: 'list_files', description: 'List the project file tree (frontend/ as root).', parameters: { type: 'object', properties: { path: S('Subdirectory relative to frontend/, default ".".') }, additionalProperties: false } },
  { name: 'read_file', description: 'Read a text file relative to frontend/.', parameters: { type: 'object', properties: { path: S('File path relative to frontend/.') }, required: ['path'], additionalProperties: false } },
  { name: 'write_file', description: 'Write (create or overwrite) a file relative to frontend/. Creates parent dirs. content MUST be a string with the full file text (for .json files, pass the JSON text, not an object).', parameters: { type: 'object', properties: { path: S('File path relative to frontend/.'), content: S('Full file content as a string.') }, required: ['path', 'content'], additionalProperties: false } },
  { name: 'patch_file', description: 'Replace the FIRST occurrence of `search` with `replace` in a file relative to frontend/.', parameters: { type: 'object', properties: { path: S('File path relative to frontend/.'), search: S('Exact text to find (first occurrence).'), replace: S('Replacement text.') }, required: ['path', 'search', 'replace'], additionalProperties: false } },
  { name: 'delete_file', description: 'Delete a file or directory relative to frontend/.', parameters: { type: 'object', properties: { path: S('Path relative to frontend/.') }, required: ['path'], additionalProperties: false } },
  { name: 'create_directory', description: 'Create a directory (recursive) relative to frontend/.', parameters: { type: 'object', properties: { path: S('Directory path relative to frontend/.') }, required: ['path'], additionalProperties: false } },
  { name: 'acquire_image', description: 'Find and download a relevant real photograph from Openverse under a commercial-reuse license. Saves the image below public/ plus a .license.json attribution receipt. Use the returned publicUrl in the UI and render a visible source/creator credit. Never claim the photo is the exact listed item unless independently verified.', parameters: { type: 'object', properties: { query: S('Specific visual search, including subject/model and desired angle or setting.'), path: S('Destination below public/, preferably without an extension, e.g. public/assets/cars/tesla-model-s.') }, required: ['query', 'path'], additionalProperties: false } },
  { name: 'search_code', description: 'Substring search across text files under frontend/ (skips node_modules, dist, .git).', parameters: { type: 'object', properties: { pattern: S('Literal substring to search for.') }, required: ['pattern'], additionalProperties: false } },
  { name: 'install_dependencies', description: 'Ensure dependencies match package.json, updating a stale lockfile when needed. run_build does this automatically.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'run_build', description: 'Install dependencies automatically, then run the strict TypeScript + Vite production build. Returns compiler diagnostics on failure.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'test_preview', description: 'Build if needed, then run the current app in real Chromium on desktop/mobile. Use steps to test requested interactions. Selectors must identify ONE element: e.g. button:has-text("Añadir"), or button:has-text("Me gusta") >> nth=0 for the first repeated card. expect_text checks visible text; reload tests persistence. Returns accessible page snapshot and runtime errors.', parameters: { type: 'object', properties: { steps: { type: 'array', maxItems: 12, items: { type: 'object', properties: { action: { type: 'string', enum: ['click', 'fill', 'select', 'expect_text', 'reload'] }, selector: S('CSS selector for click/fill/select; append >> nth=0 for the first of repeated matches'), value: S('Input/select value or visible text to expect') }, required: ['action'], additionalProperties: false } } }, additionalProperties: false } },
  { name: 'start_preview', description: 'Verify a current build in Chromium, then publish the preview at /p/:projectId/. Never reuses an outdated build.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'create_revision', description: 'Git checkpoint of the project (add -A + commit) and record it as a revision.', parameters: { type: 'object', properties: { label: S('Revision label.') }, additionalProperties: false } },
  { name: 'run_command', description: 'Run an allowlisted command (npm, npx, node) WITHOUT a shell, cwd=frontend/.', parameters: { type: 'object', properties: { cmd: S('One of: npm, npx, node.'), args: { type: 'array', items: { type: 'string' }, description: 'Arguments, each a string.' } }, required: ['cmd'], additionalProperties: false } },
];

export function createTools(): Record<string, ToolHandler> {
  return {
    list_files: listFiles,
    read_file: readFile,
    write_file: writeFile,
    write_files: writeFiles,
    patch_file: patchFile,
    delete_file: deleteFile,
    create_directory: createDirectory,
    acquire_image: acquireImage,
    search_code: searchCode,
    install_dependencies: installDependencies,
    run_build: runBuild,
    start_preview: startPreview,
    test_preview: testPreview,
    create_revision: createRevision,
    run_command: runCommand,
  };
}
