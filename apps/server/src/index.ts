/**
 * AppForge AI Studio — backend API (CONTRACT.md §3).
 * Fastify + SQLite WAL. Run with: npx tsx apps/server/src/index.ts
 * (no build step for the backend; `npm run typecheck` for types).
 */

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import archiver from 'archiver';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
import { z } from 'zod';
import type Database from 'better-sqlite3';
import type {
  ApiError,
  BuildRecord,
  ChatMessage,
  Project,
  RevisionInfo,
  Run,
  RunStats,
  Settings,
} from 'appforge-shared';
import { openDb } from './db.js';
import { assessTechnologyCompatibility } from './compatibility.js';
import { buildFileTree, createProject, deleteProject, frontendDir, getProject, nowIso, projectDir, resolveIn, rowToProject } from './projects.js';
import { checkBrowser, createTools, requestCancel, runAgentOnce, runCmd, startWorker, type AgentSettings, type ToolContext } from 'appforge-worker';

export const VERSION = '0.1.0';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

interface StoredSettings {
  provider: 'groq' | 'openrouter';
  model: string;
  temperature: number;
  maxTokens: number;
  maxIterations: number;
  llmTimeoutMs: number;
  cmdTimeoutMs: number;
  runTimeoutMs: number;
  language: 'es' | 'en';
  theme: 'dark' | 'light';
  autoRevision: boolean;
  autoBuild: boolean;
  secrets?: { groqKey?: string; openrouterKey?: string; vercelToken?: string };
}

function defaultSettings(): StoredSettings {
  return {
    provider: (process.env.LLM_PROVIDER === 'openrouter' ? 'openrouter' : 'groq') as 'groq' | 'openrouter',
    model: process.env.LLM_MODEL ?? '',
    temperature: Number(process.env.LLM_TEMPERATURE ?? 0.2),
    maxTokens: Number(process.env.LLM_MAX_TOKENS ?? 8000),
    maxIterations: 8,
    llmTimeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 120_000),
    cmdTimeoutMs: 180_000,
    runTimeoutMs: 900_000,
    language: 'es',
    theme: 'dark',
    autoRevision: true,
    autoBuild: true,
    secrets: {},
  };
}

export function ensureSettingsRow(db: Database.Database): StoredSettings {
  const row = db.prepare('SELECT data_json FROM settings WHERE id=1').get() as { data_json: string } | undefined;
  if (row) return { ...defaultSettings(), ...JSON.parse(row.data_json) };
  const s = defaultSettings();
  db.prepare('INSERT INTO settings(id, data_json) VALUES (1, ?)').run(JSON.stringify(s));
  return s;
}

export function toPublicSettings(s: StoredSettings): Settings {
  return {
    provider: s.provider,
    model: s.model,
    temperature: s.temperature,
    maxTokens: s.maxTokens,
    maxIterations: s.maxIterations,
    llmTimeoutMs: s.llmTimeoutMs,
    cmdTimeoutMs: s.cmdTimeoutMs,
    runTimeoutMs: s.runTimeoutMs,
    language: s.language,
    theme: s.theme,
    autoRevision: s.autoRevision,
    autoBuild: s.autoBuild,
    secrets: {
      groq: { configured: !!(s.secrets?.groqKey || process.env.GROQ_API_KEY) },
      openrouter: { configured: !!(s.secrets?.openrouterKey || process.env.OPENROUTER_API_KEY) },
      vercel: { configured: !!s.secrets?.vercelToken },
    },
  };
}

export function getAgentSettings(db: Database.Database): AgentSettings {
  const s = ensureSettingsRow(db);
  return {
    provider: s.provider,
    model: s.model,
    temperature: s.temperature,
    maxTokens: s.maxTokens,
    maxIterations: s.maxIterations,
    llmTimeoutMs: s.llmTimeoutMs,
    cmdTimeoutMs: s.cmdTimeoutMs,
    runTimeoutMs: s.runTimeoutMs,
    language: s.language,
    autoRevision: s.autoRevision,
  };
}

/** Test E: runs left queued/running across a restart become coherent errors. */
export function reconcileInterruptedRuns(db: Database.Database): number {
  const r = db
    .prepare("UPDATE runs SET status='error', finished_at=?, error=? WHERE status IN ('queued','running')")
    .run(nowIso(), 'interrupted by restart');
  return Number(r.changes);
}

/** Builds cannot survive a process restart; close stale UI state coherently. */
export function reconcileInterruptedBuilds(db: Database.Database): number {
  const finishedAt = nowIso();
  const r = db
    .prepare("UPDATE builds SET status='failed', finished_at=?, error=?, logs=COALESCE(logs,'') || ? WHERE status IN ('pending','running')")
    .run(finishedAt, 'interrupted by server restart', '\nBuild interrupted by server restart. Source files were preserved.');
  return Number(r.changes);
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function rowToRun(r: Record<string, any>): Run {
  let stats: RunStats | null = null;
  try {
    stats = r.stats_json ? (JSON.parse(r.stats_json) as RunStats) : null;
  } catch {
    stats = null;
  }
  return {
    id: r.id,
    projectId: r.project_id,
    prompt: r.prompt,
    status: r.status,
    createdAt: r.created_at,
    startedAt: r.started_at ?? null,
    finishedAt: r.finished_at ?? null,
    stats,
    error: r.error ?? null,
  };
}

function rowToMessage(r: Record<string, any>): ChatMessage {
  return { id: r.id, projectId: r.project_id, role: r.role, content: r.content, createdAt: r.created_at, tokens: r.tokens ?? null };
}

function rowToBuild(r: Record<string, any>): BuildRecord {
  let artifacts: { distSize: number } | null = null;
  try {
    artifacts = r.artifacts_json ? (JSON.parse(r.artifacts_json) as { distSize: number }) : null;
  } catch {
    artifacts = null;
  }
  return {
    id: r.id,
    projectId: r.project_id,
    status: r.status,
    startedAt: r.started_at,
    finishedAt: r.finished_at ?? null,
    durationMs: r.duration_ms ?? null,
    logs: r.logs ?? '',
    artifacts,
    error: r.error ?? null,
  };
}

function rowToRevision(r: Record<string, any>): RevisionInfo {
  return { id: r.id, projectId: r.project_id, label: r.label, gitSha: r.git_sha, createdAt: r.created_at };
}

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const ProjectCreate = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional().default(''),
  type: z.enum(['static', 'dynamic']).optional().default('static'),
});
const ProjectPatch = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
  status: z.string().max(40).optional(),
  model: z.string().max(120).nullable().optional(),
  previewUrl: z.string().max(500).nullable().optional(),
  productionUrl: z.string().max(500).nullable().optional(),
  config: z.record(z.unknown()).optional(),
});
const MessageCreate = z.object({ role: z.enum(['user', 'assistant', 'system']), content: z.string().min(1).max(200_000) });
const RunCreate = z.object({
  prompt: z.string().min(1).max(20_000),
  language: z.enum(['es', 'en']).optional(),
});
const FileWrite = z.object({ path: z.string().min(1).max(500), content: z.string().max(5_000_000) });
const ContentQuery = z.object({ path: z.string().min(1).max(500) });
const RevisionCreate = z.object({ label: z.string().max(200).optional() });
const ProjectsQuery = z.object({
  search: z.string().max(200).optional(),
  type: z.enum(['static', 'dynamic']).optional(),
  status: z.string().max(40).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(24),
});
const SettingsPatch = z.object({
  provider: z.enum(['groq', 'openrouter']).optional(),
  model: z.string().max(200).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(128_000).optional(),
  maxIterations: z.number().int().min(1).max(32).optional(),
  llmTimeoutMs: z.number().int().min(1_000).max(600_000).optional(),
  cmdTimeoutMs: z.number().int().min(1_000).max(600_000).optional(),
  runTimeoutMs: z.number().int().min(60_000).max(3_600_000).optional(),
  language: z.enum(['es', 'en']).optional(),
  theme: z.enum(['dark', 'light']).optional(),
  autoRevision: z.boolean().optional(),
  autoBuild: z.boolean().optional(),
  secrets: z
    .object({
      groqKey: z.string().max(500).optional(),
      openrouterKey: z.string().max(500).optional(),
      vercelToken: z.string().max(500).optional(),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export interface ServerOptions {
  db: Database.Database;
  dataDir: string;
  templatesDir: string;
  adminToken?: string;
  corsOrigin?: string;
  /** apps/studio/dist — served at / when it exists (single-server mode) */
  studioDistDir?: string;
}

const err = (code: string, message: string): ApiError => ({ error: { code, message } });

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

/** Serve a static file over a hijacked reply (headers must precede writeHead). */
function sendFile(abs: string, raw: import('node:http').ServerResponse): void {
  const stream = fs.createReadStream(abs);
  raw.writeHead(200, { 'Content-Type': MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream' });
  stream.on('error', () => {
    try { raw.end(); } catch { /* ignore */ }
  });
  stream.pipe(raw);
}

function diagnosticHtml(projectId: string, projectName: string): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sin preview — ${projectName}</title>
<style>body{background:#0b0f14;color:#e6edf3;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{max-width:520px;padding:32px;border:1px solid #1f2937;border-radius:12px;background:#111827;text-align:center}
h1{font-size:20px;margin:0 0 8px}p{color:#9ca3af;font-size:14px}
button{background:#06b6d4;border:0;color:#04222b;font-weight:700;padding:10px 18px;border-radius:8px;cursor:pointer;margin:6px}
a{color:#06b6d4;font-size:14px}#msg{font-size:13px;color:#9ca3af;margin-top:10px;min-height:18px}</style></head><body>
<div class="card"><h1>No hay preview disponible</h1>
<p>El proyecto <b>${projectName}</b> aún no tiene un build de producción (<code>frontend/dist</code>).</p>
<button onclick="rebuild()">Rebuild</button>
<a href="/api/projects/${projectId}/builds">Ver logs de builds</a>
<div id="msg"></div></div>
<script>async function rebuild(){const t=localStorage.getItem('appforge_token');const msg=document.getElementById('msg');
msg.textContent='Lanzando build…';
try{const r=await fetch('/api/projects/${projectId}/builds',{method:'POST',headers:t?{Authorization:'Bearer '+t}:{}});
msg.textContent='Build: '+r.status+(r.ok?' — recargando en 20 s…':'');
if(r.ok)setTimeout(()=>location.reload(),20000);}catch(e){msg.textContent='Error: '+e;}}</script>
</body></html>`;
}

export function buildServer(opts: ServerOptions): FastifyInstance {
  const { db, dataDir, templatesDir, adminToken } = opts;
  const app = Fastify({ logger: false });
  const thumbnailJobs = new Map<string, ReturnType<typeof checkBrowser>>();
  void app.register(cors, { origin: opts.corsOrigin ?? '*' });

  // --- rate limit: 120 req/min/IP on /api ---
  const hits = new Map<string, number[]>();
  app.addHook('onRequest', async (req, reply) => {
    const url = req.raw.url ?? '';
    const isApi = url === '/api' || url.startsWith('/api/');
    if (isApi) {
      const now = Date.now();
      const arr = (hits.get(req.ip) ?? []).filter((t) => now - t < 60_000);
      arr.push(now);
      hits.set(req.ip, arr);
      if (arr.length > 120) {
        reply.code(429).send(err('RATE_LIMITED', 'Too many requests (120/min)'));
        return;
      }
    }
    // Generated apps under /p are intentionally public deployments. Only the
    // administrative API requires the bearer token.
    if (adminToken && isApi) {
      const h = req.headers.authorization ?? '';
      const bearer = h.startsWith('Bearer ') ? h.slice(7) : null;
      const qToken = (req.query as Record<string, unknown> | undefined)?.token;
      const token = bearer ?? (typeof qToken === 'string' ? qToken : null);
      if (token !== adminToken) {
        reply.code(401).send(err('UNAUTHORIZED', 'Missing or invalid admin token'));
        return;
      }
    }
  });

  app.setErrorHandler((e, _req, reply) => {
    if (e instanceof z.ZodError) {
      reply.code(400).send(err('VALIDATION_ERROR', e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')));
      return;
    }
    const status = typeof (e as { statusCode?: unknown }).statusCode === 'number' ? ((e as { statusCode: number }).statusCode as number) : 500;
    if (status >= 500) console.error('[api]', e);
    reply.code(status >= 500 ? 500 : status).send(err(status >= 500 ? 'INTERNAL' : 'REQUEST_ERROR', status >= 500 ? 'Internal server error' : (e as Error).message));
  });

  const needProject = (id: string): Project => {
    const p = getProject(db, id);
    if (!p) {
      const e = new Error('project not found') as Error & { statusCode: number; code: string };
      e.statusCode = 404;
      e.code = 'PROJECT_NOT_FOUND';
      throw e;
    }
    return p;
  };

  // ------------------------------------------------------------------ system
  app.get('/api/health', async () => ({ ok: true, version: VERSION }));

  // ---------------------------------------------------------------- projects
  app.get('/api/projects', async (req) => {
    const q = ProjectsQuery.parse(req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.search) { where.push('(name LIKE ? OR description LIKE ?)'); params.push(`%${q.search}%`, `%${q.search}%`); }
    if (q.type) { where.push('type=?'); params.push(q.type); }
    if (q.status) { where.push('status=?'); params.push(q.status); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (db.prepare(`SELECT COUNT(*) AS c FROM projects ${w}`).get(...params) as { c: number }).c;
    const rows = db.prepare(`SELECT * FROM projects ${w} ORDER BY updated_at DESC LIMIT ? OFFSET ?`).all(...params, q.pageSize, (q.page - 1) * q.pageSize) as Record<string, any>[];
    return { items: rows.map(rowToProject), total };
  });

  app.post('/api/projects', async (req, reply) => {
    const body = ProjectCreate.parse(req.body);
    const p = createProject(db, dataDir, templatesDir, body);
    reply.code(201);
    return p;
  });

  app.get('/api/projects/:id', async (req) => {
    const { id } = req.params as { id: string };
    return needProject(id);
  });

  app.patch('/api/projects/:id', async (req) => {
    const { id } = req.params as { id: string };
    needProject(id);
    const body = ProjectPatch.parse(req.body);
    const sets: string[] = [];
    const params: unknown[] = [];
    const map: Record<string, string> = { name: 'name', description: 'description', status: 'status', model: 'model', previewUrl: 'preview_url', productionUrl: 'production_url' };
    for (const [k, col] of Object.entries(map)) {
      if ((body as Record<string, unknown>)[k] !== undefined) { sets.push(`${col}=?`); params.push((body as Record<string, unknown>)[k]); }
    }
    if (body.config !== undefined) { sets.push('config_json=?'); params.push(JSON.stringify(body.config)); }
    if (sets.length > 0) {
      sets.push('updated_at=?');
      params.push(nowIso(), id);
      db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id=?`).run(...params);
    }
    return getProject(db, id)!;
  });

  app.delete('/api/projects/:id', async (req) => {
    const { id } = req.params as { id: string };
    if (!deleteProject(db, dataDir, id)) {
      const e = new Error('project not found') as Error & { statusCode: number };
      e.statusCode = 404;
      throw e;
    }
    return { ok: true };
  });

  // ------------------------------------------------------------------- chat
  app.get('/api/projects/:id/messages', async (req) => {
    const { id } = req.params as { id: string };
    needProject(id);
    const rows = db.prepare('SELECT * FROM messages WHERE project_id=? ORDER BY created_at ASC').all(id) as Record<string, any>[];
    return { items: rows.map(rowToMessage) };
  });

  app.post('/api/projects/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string };
    needProject(id);
    const body = MessageCreate.parse(req.body);
    const m: ChatMessage = { id: randomUUID(), projectId: id, role: body.role, content: body.content, createdAt: nowIso(), tokens: null };
    db.prepare('INSERT INTO messages(id, project_id, role, content, created_at, tokens) VALUES (?,?,?,?,?,?)').run(m.id, m.projectId, m.role, m.content, m.createdAt, null);
    reply.code(201);
    return m;
  });

  // ------------------------------------------------------------------- runs
  app.post('/api/projects/:id/runs', async (req, reply) => {
    const { id } = req.params as { id: string };
    needProject(id);
    const body = RunCreate.parse(req.body);
    const active = db.prepare("SELECT id FROM runs WHERE project_id=? AND status IN ('queued','running') LIMIT 1").get(id);
    if (active) {
      reply.code(409);
      return err('RUN_ACTIVE', 'There is already an active run for this project');
    }
    const runId = randomUUID();
    const created = nowIso();
    const compatibility = assessTechnologyCompatibility(body.prompt, body.language ?? ensureSettingsRow(db).language);
    if (!compatibility.compatible) {
      const stats: RunStats = { iterations: 0, llmCalls: 0, llmMs: 0, buildMs: 0, tokensIn: 0, tokensOut: 0, toolCalls: 0, errors: 0 };
      db.transaction(() => {
        db.prepare('INSERT INTO runs(id, project_id, prompt, status, created_at, started_at, finished_at, stats_json, error) VALUES (?,?,?,?,?,?,?,?,?)').run(
          runId, id, body.prompt, 'done', created, created, created, JSON.stringify(stats), null,
        );
        db.prepare('INSERT INTO messages(id, project_id, role, content, created_at, tokens) VALUES (?,?,?,?,?,?)').run(randomUUID(), id, 'user', body.prompt, created, null);
        db.prepare('INSERT INTO messages(id, project_id, role, content, created_at, tokens) VALUES (?,?,?,?,?,?)').run(randomUUID(), id, 'assistant', compatibility.message, created, 0);
        db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(created, id);
      })();
      const row = db.prepare('SELECT * FROM runs WHERE id=?').get(runId) as Record<string, any>;
      reply.code(201);
      return rowToRun(row);
    }
    db.prepare('INSERT INTO runs(id, project_id, prompt, status, created_at, started_at, finished_at, stats_json, error) VALUES (?,?,?,?,?,?,?,?,?)').run(
      runId, id, body.prompt, 'queued', created, null, null, null, null,
    );
    db.prepare('INSERT INTO messages(id, project_id, role, content, created_at, tokens) VALUES (?,?,?,?,?,?)').run(randomUUID(), id, 'user', body.prompt, created, null);
    const row = db.prepare('SELECT * FROM runs WHERE id=?').get(runId) as Record<string, any>;
    reply.code(201);
    return rowToRun(row);
  });

  app.get('/api/projects/:id/runs', async (req) => {
    const { id } = req.params as { id: string };
    needProject(id);
    const rows = db.prepare('SELECT * FROM runs WHERE project_id=? ORDER BY created_at DESC').all(id) as Record<string, any>[];
    return { items: rows.map(rowToRun) };
  });

  app.get('/api/runs/:runId', async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const row = db.prepare('SELECT * FROM runs WHERE id=?').get(runId) as Record<string, any> | undefined;
    if (!row) { reply.code(404); return err('RUN_NOT_FOUND', 'run not found'); }
    return rowToRun(row);
  });

  app.post('/api/runs/:runId/cancel', async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const row = db.prepare('SELECT status FROM runs WHERE id=?').get(runId) as { status: string } | undefined;
    if (!row) { reply.code(404); return err('RUN_NOT_FOUND', 'run not found'); }
    if (row.status === 'queued' || row.status === 'running') {
      db.prepare("UPDATE runs SET status='cancelled', finished_at=? WHERE id=?").run(nowIso(), runId);
      requestCancel(runId);
    }
    return { ok: true };
  });

  // SSE: replay ordered by seq, then live poll; :ping every 15s; close on done|error.
  app.get('/api/runs/:runId/events', async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const run = db.prepare('SELECT id FROM runs WHERE id=?').get(runId);
    if (!run) { reply.code(404); return err('RUN_NOT_FOUND', 'run not found'); }
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': opts.corsOrigin ?? '*',
    });
    let lastSeq = 0;
    let closed = false;
    let poll: ReturnType<typeof setInterval> | undefined;
    let ping: ReturnType<typeof setInterval> | undefined;
    const send = (seq: number, kind: string, payload: string) => {
      if (!closed) reply.raw.write(`id: ${seq}\nevent: ${kind}\ndata: ${payload}\n\n`);
    };
    const close = () => {
      if (closed) return;
      closed = true;
      if (poll) clearInterval(poll);
      if (ping) clearInterval(ping);
      try { reply.raw.end(); } catch { /* already closed */ }
    };
    let terminal = false;
    const drain = () => {
      const rows = db.prepare('SELECT seq, kind, payload_json AS payload FROM run_events WHERE run_id=? AND seq>? ORDER BY seq').all(runId, lastSeq) as Array<{ seq: number; kind: string; payload: string }>;
      for (const r of rows) {
        send(r.seq, r.kind, r.payload);
        lastSeq = r.seq;
        if (r.kind === 'done' || r.kind === 'error') terminal = true;
      }
      if (terminal) close();
    };
    drain();
    if (terminal) return;
    poll = setInterval(() => { try { drain(); } catch { /* db closed */ } }, 500);
    ping = setInterval(() => { if (!closed) reply.raw.write(':ping\n\n'); }, 15_000);
    req.raw.on('close', close);
  });

  // ------------------------------------------------------------------- files
  app.get('/api/projects/:id/files', async (req) => {
    const { id } = req.params as { id: string };
    needProject(id);
    const fdir = frontendDir(dataDir, id);
    if (!fs.existsSync(fdir)) return { tree: [] };
    return { tree: buildFileTree(fdir) };
  });

  app.get('/api/projects/:id/files/content', async (req, reply) => {
    const { id } = req.params as { id: string };
    needProject(id);
    const q = ContentQuery.parse(req.query);
    let abs: string;
    try {
      abs = resolveIn(frontendDir(dataDir, id), q.path);
    } catch (e) {
      reply.code(400);
      return err('INVALID_PATH', (e as Error).message);
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) { reply.code(404); return err('FILE_NOT_FOUND', 'file not found'); }
    return { path: q.path, content: fs.readFileSync(abs, 'utf8') };
  });

  app.put('/api/projects/:id/files/content', async (req, reply) => {
    const { id } = req.params as { id: string };
    needProject(id);
    const body = FileWrite.parse(req.body);
    let abs: string;
    try {
      abs = resolveIn(frontendDir(dataDir, id), body.path);
    } catch (e) {
      reply.code(400);
      return err('INVALID_PATH', (e as Error).message);
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body.content, 'utf8');
    db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(nowIso(), id);
    return { ok: true };
  });

  // ------------------------------------------------------------------ builds
  app.post('/api/projects/:id/builds', async (req, reply) => {
    const { id } = req.params as { id: string };
    needProject(id);
    const active = db.prepare("SELECT id FROM builds WHERE project_id=? AND status IN ('pending','running') LIMIT 1").get(id);
    if (active) {
      reply.code(409);
      return err('BUILD_ACTIVE', 'There is already a build in progress for this project');
    }
    const buildId = randomUUID();
    db.prepare('INSERT INTO builds(id, project_id, status, started_at, finished_at, duration_ms, logs, artifacts_json, error) VALUES (?,?,?,?,?,?,?,?,?)').run(
      buildId, id, 'pending', nowIso(), null, null, '', null, null,
    );
    void executeBuild(db, dataDir, buildId);
    const row = db.prepare('SELECT * FROM builds WHERE id=?').get(buildId) as Record<string, any>;
    reply.code(201);
    return rowToBuild(row);
  });

  app.get('/api/projects/:id/builds', async (req) => {
    const { id } = req.params as { id: string };
    needProject(id);
    const rows = db.prepare('SELECT * FROM builds WHERE project_id=? ORDER BY started_at DESC').all(id) as Record<string, any>[];
    return { items: rows.map(rowToBuild) };
  });

  app.get('/api/builds/:buildId', async (req, reply) => {
    const { buildId } = req.params as { buildId: string };
    const row = db.prepare('SELECT * FROM builds WHERE id=?').get(buildId) as Record<string, any> | undefined;
    if (!row) { reply.code(404); return err('BUILD_NOT_FOUND', 'build not found'); }
    return rowToBuild(row);
  });

  // ----------------------------------------------------------------- archive
  app.get('/api/projects/:id/archive', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = needProject(id);
    const dir = projectDir(dataDir, id);
    reply.hijack();
    const slug = p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
    reply.raw.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${slug}.zip"`,
    });
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (e: Error) => { try { reply.raw.destroy(e); } catch { /* ignore */ } });
    archive.pipe(reply.raw);
    archive.glob('**', {
      cwd: dir,
      dot: true,
      ignore: ['node_modules/**', 'dist/**', '.git/**', '*.db', '*.log', 'frontend/node_modules/**', 'frontend/dist/**', '**/*.db-*'],
    });
    await archive.finalize();
  });

  // --------------------------------------------------------------- revisions
  app.get('/api/projects/:id/revisions', async (req) => {
    const { id } = req.params as { id: string };
    needProject(id);
    const rows = db.prepare('SELECT * FROM revisions WHERE project_id=? ORDER BY created_at DESC').all(id) as Record<string, any>[];
    return { items: rows.map(rowToRevision) };
  });

  app.post('/api/projects/:id/revisions', async (req, reply) => {
    const { id } = req.params as { id: string };
    needProject(id);
    const body = RevisionCreate.parse(req.body);
    const dir = projectDir(dataDir, id);
    const label = body.label?.trim() || 'checkpoint';
    const add = await runCmd('git', ['add', '-A'], { cwd: dir, timeoutMs: 30_000 });
    if (add.code !== 0) { reply.code(500); return err('GIT_ERROR', `git add failed: ${(add.stdout + add.stderr).slice(0, 500)}`); }
    const status = await runCmd('git', ['status', '--porcelain'], { cwd: dir, timeoutMs: 30_000 });
    if (status.code !== 0) { reply.code(500); return err('GIT_ERROR', 'git status failed'); }
    if (status.stdout.trim().length > 0) {
      const commit = await runCmd('git', ['-c', 'user.name=AppForge', '-c', 'user.email=appforge@local', 'commit', '-m', label], { cwd: dir, timeoutMs: 30_000 });
      if (commit.code !== 0) { reply.code(500); return err('GIT_ERROR', `git commit failed: ${(commit.stdout + commit.stderr).slice(0, 500)}`); }
    }
    const rev = await runCmd('git', ['rev-parse', 'HEAD'], { cwd: dir, timeoutMs: 30_000 });
    if (rev.code !== 0) { reply.code(500); return err('GIT_ERROR', 'git rev-parse failed (no commits?)'); }
    const sha = rev.stdout.trim();
    const revId = randomUUID();
    db.prepare('INSERT INTO revisions(id, project_id, label, git_sha, created_at) VALUES (?,?,?,?,?)').run(revId, id, label, sha, nowIso());
    const row = db.prepare('SELECT * FROM revisions WHERE id=?').get(revId) as Record<string, any>;
    reply.code(201);
    return rowToRevision(row);
  });

  app.post('/api/projects/:id/revisions/:rid/restore', async (req, reply) => {
    const { id, rid } = req.params as { id: string; rid: string };
    needProject(id);
    const row = db.prepare('SELECT * FROM revisions WHERE id=? AND project_id=?').get(rid, id) as Record<string, any> | undefined;
    if (!row) { reply.code(404); return err('REVISION_NOT_FOUND', 'revision not found'); }
    const dir = projectDir(dataDir, id);
    const reset = await runCmd('git', ['reset', '--hard', row.git_sha], { cwd: dir, timeoutMs: 60_000 });
    if (reset.code !== 0) { reply.code(500); return err('GIT_ERROR', `git reset failed: ${(reset.stdout + reset.stderr).slice(0, 500)}`); }
    db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(nowIso(), id);
    return { ok: true };
  });

  // ----------------------------------------------------------------- deploy
  app.post('/api/projects/:id/deploy', async (req, reply) => {
    const { id } = req.params as { id: string };
    needProject(id);
    reply.code(501);
    return err('PHASE_3', 'Deployments are planned for Phase 3 and are not implemented yet');
  });

  // ----------------------------------------------------------------- preview
  app.get('/api/projects/:id/preview', async (req) => {
    const { id } = req.params as { id: string };
    needProject(id);
    const distIndex = path.join(frontendDir(dataDir, id), 'dist', 'index.html');
    let status: 'ready' | 'building' | 'none' = 'none';
    if (fs.existsSync(distIndex)) status = 'ready';
    else {
      const b = db.prepare("SELECT id FROM builds WHERE project_id=? AND status IN ('pending','running') LIMIT 1").get(id);
      if (b) status = 'building';
    }
    return { url: `/p/${id}/`, status };
  });

  // ---------------------------------------------------------------- settings
  app.get('/api/settings', async () => toPublicSettings(ensureSettingsRow(db)));

  app.patch('/api/settings', async (req) => {
    const body = SettingsPatch.parse(req.body);
    const stored = ensureSettingsRow(db);
    const next: StoredSettings = { ...stored };
    for (const k of ['provider', 'model', 'temperature', 'maxTokens', 'maxIterations', 'llmTimeoutMs', 'cmdTimeoutMs', 'runTimeoutMs', 'language', 'theme', 'autoRevision', 'autoBuild'] as const) {
      const v = (body as Record<string, unknown>)[k];
      if (v !== undefined) (next as unknown as Record<string, unknown>)[k] = v;
    }
    if (body.secrets) {
      next.secrets = { ...(next.secrets ?? {}) };
      for (const [k, v] of Object.entries(body.secrets)) {
        if (v === undefined) continue;
        (next.secrets as Record<string, unknown>)[k] = v === '' ? undefined : v;
      }
    }
    db.prepare('UPDATE settings SET data_json=? WHERE id=1').run(JSON.stringify(next));
    return toPublicSettings(next);
  });

  // Existing projects created before thumbnail support are captured lazily
  // on the first Library image request. Concurrent requests share one job.
  app.get('/p/:projectId/__appforge/thumbnail.webp', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const project = getProject(db, projectId);
    if (!project) { reply.code(404); return ''; }
    const distDir = path.join(frontendDir(dataDir, projectId), 'dist');
    const thumbnail = path.join(distDir, '__appforge', 'thumbnail.webp');
    if (!fs.existsSync(thumbnail)) {
      if (!fs.existsSync(path.join(distDir, 'index.html'))) { reply.code(404); return ''; }
      let job = thumbnailJobs.get(projectId);
      if (!job) {
        job = checkBrowser(distDir, projectId, [], 45_000, {}, thumbnail);
        thumbnailJobs.set(projectId, job);
        void job.finally(() => thumbnailJobs.delete(projectId));
      }
      const result = await job;
      if (!result.ok || !fs.existsSync(thumbnail)) { reply.code(404); return ''; }
    }
    reply.hijack();
    sendFile(thumbnail, reply.raw);
  });

  // ------------------------------------------------------- static preview /p
  app.get('/p/:projectId/*', async (req, reply) => {
    const { projectId } = req.params as { projectId: string; '*': string };
    const p = getProject(db, projectId);
    if (!p) {
      reply.code(404).type('text/html; charset=utf-8');
      return '<h1>Project not found</h1>';
    }
    const distDir = path.join(frontendDir(dataDir, projectId), 'dist');
    const indexHtml = path.join(distDir, 'index.html');
    if (!fs.existsSync(indexHtml)) {
      reply.code(404).type('text/html; charset=utf-8');
      return diagnosticHtml(projectId, p.name);
    }
    const rel = ((req.params as Record<string, string>)['*'] ?? '').split('?')[0];
    let abs = indexHtml;
    if (rel) {
      const candidate = path.normalize(path.join(distDir, rel));
      if (candidate !== distDir && !candidate.startsWith(distDir + path.sep)) {
        reply.code(400).type('text/html; charset=utf-8');
        return '<h1>Invalid path</h1>';
      }
      try {
        const st = fs.statSync(candidate);
        abs = st.isDirectory() ? indexHtml : candidate;
      } catch {
        abs = indexHtml; // SPA fallback
      }
    }
    reply.hijack();
    sendFile(abs, reply.raw);
  });

  // --------------------------------------- studio SPA (single-server mode, if built)
  const studioDist = opts.studioDistDir ?? path.resolve(SRC_DIR, '..', '..', 'studio', 'dist');
  if (fs.existsSync(path.join(studioDist, 'index.html'))) {
    app.get('/*', async (req, reply) => {
      const url = req.raw.url ?? '/';
      if (url === '/api' || url.startsWith('/api/')) { reply.code(404); return err('NOT_FOUND', 'not found'); }
      const rel = url.split('?')[0].replace(/^\/+/, '');
      const candidate = path.normalize(path.join(studioDist, rel || 'index.html'));
      let abs = path.join(studioDist, 'index.html');
      if ((candidate === studioDist || candidate.startsWith(studioDist + path.sep)) && rel) {
        try {
          const st = fs.statSync(candidate);
          abs = st.isDirectory() ? abs : candidate;
        } catch {
          abs = path.join(studioDist, 'index.html');
        }
      }
      reply.hijack();
      sendFile(abs, reply.raw);
    });
  }

  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send(err('NOT_FOUND', 'not found'));
  });

  return app;
}

// ---------------------------------------------------------------------------
// Builds (background execution)
// ---------------------------------------------------------------------------

async function executeBuild(db: Database.Database, dataDir: string, buildId: string): Promise<void> {
  const row = db.prepare('SELECT * FROM builds WHERE id=?').get(buildId) as Record<string, any> | undefined;
  if (!row) return;
  const t0 = Date.now();
  try {
    const ctx: ToolContext = { db, projectId: row.project_id, projectDir: projectDir(dataDir, row.project_id), frontendDir: frontendDir(dataDir, row.project_id), cmdTimeoutMs: 180_000, buildTimeoutMs: 600_000, buildId };
    const result = await createTools().start_preview(ctx, {});
    if (!result.ok) {
      db.prepare("UPDATE builds SET status='failed', finished_at=?, duration_ms=?, logs=COALESCE(logs,'') || ?, error=? WHERE id=?").run(nowIso(), Date.now() - t0, `\n${result.output ?? result.error}`, result.error ?? 'verification failed', buildId);
    }
  } catch (e) {
    db.prepare("UPDATE builds SET status='failed', finished_at=?, error=? WHERE id=?").run(nowIso(), `build crashed: ${(e as Error).message}`.slice(0, 2000), buildId);
  }
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const dataDir = process.env.DATA_DIR ?? path.resolve(process.cwd(), 'data');
  const templatesDir = process.env.TEMPLATES_DIR ?? path.resolve(process.cwd(), 'templates');
  const db = openDb(dataDir);
  ensureSettingsRow(db);
  const interrupted = reconcileInterruptedRuns(db);
  if (interrupted > 0) console.log(`[server] marked ${interrupted} interrupted run(s) as error`);
  const interruptedBuilds = reconcileInterruptedBuilds(db);
  if (interruptedBuilds > 0) console.log(`[server] marked ${interruptedBuilds} interrupted build(s) as failed`);

  const worker = startWorker(db, { dataDir, pollMs: 2000, getSettings: () => getAgentSettings(db) });
  const app = buildServer({
    db,
    dataDir,
    templatesDir,
    adminToken: process.env.APPFORGE_ADMIN_TOKEN,
    corsOrigin: process.env.CORS_ORIGIN ?? '*',
  });

  const shutdown = async () => {
    worker.stop();
    try { await app.close(); } catch { /* ignore */ }
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  const port = Number(process.env.PORT ?? 3001);
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`[server] listening on :${port} (data=${dataDir})`);
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isMain) {
  main().catch((e) => {
    console.error('[server] fatal:', e);
    process.exit(1);
  });
}
