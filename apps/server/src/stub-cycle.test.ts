/**
 * Full stub cycle (acceptance): runAgentOnce with APPFORGE_LLM_STUB=1 must
 * personalize the template, install deps, build, preview and finish 'done'.
 * This exercises the real toolchain (npm ci + vite build) — slow by design.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { openDb } from './db.js';
import { createProject } from './projects.js';
import { runAgentOnce, type AgentSettings } from 'appforge-worker';

process.env.APPFORGE_LLM_STUB = '1';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.resolve(SRC_DIR, '..', '..', '..', 'templates');

let db: Database.Database;
let dataDir: string;
let projectId: string;

const SETTINGS: AgentSettings = {
  provider: 'groq',
  model: 'stub',
  temperature: 0.2,
  maxTokens: 8000,
  maxIterations: 8,
  llmTimeoutMs: 120_000,
  cmdTimeoutMs: 180_000,
  runTimeoutMs: 900_000,
  language: 'en',
  autoRevision: false,
};

beforeAll(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-stub-test-'));
  db = openDb(dataDir);
  const p = createProject(db, dataDir, TEMPLATES_DIR, { name: 'Stub Test App' });
  projectId = p.id;
});

afterAll(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('stub agent cycle', () => {
  it('personalizes template, installs, builds, previews and completes', { timeout: 300_000 }, async () => {
    const runId = randomUUID();
    const now = new Date().toISOString();
    db.prepare('INSERT INTO runs(id, project_id, prompt, status, created_at) VALUES (?,?,?,?,?)').run(runId, projectId, 'make me an app', 'queued', now);

    await runAgentOnce(db, runId, { dataDir, settings: SETTINGS });

    const run = db.prepare('SELECT status, error, stats_json FROM runs WHERE id=?').get(runId) as { status: string; error: string | null; stats_json: string | null };
    expect(run.error).toBeNull();
    expect(run.status).toBe('done');

    // Template personalized
    const appTsx = fs.readFileSync(path.join(dataDir, 'projects', projectId, 'frontend', 'src', 'App.tsx'), 'utf8');
    expect(appTsx).toContain('Stub App');

    // Real production build
    expect(fs.existsSync(path.join(dataDir, 'projects', projectId, 'frontend', 'dist', 'index.html'))).toBe(true);
  const thumbnail = fs.readFileSync(path.join(dataDir, 'projects', projectId, 'frontend', 'dist', '__appforge', 'thumbnail.webp'));
  expect(thumbnail.length).toBeGreaterThan(1_000);
  expect(thumbnail.subarray(0, 4).toString('ascii')).toBe('RIFF');

    // Preview marked ready
    const previewUrl = (db.prepare('SELECT preview_url FROM projects WHERE id=?').get(projectId) as { preview_url: string }).preview_url;
    expect(previewUrl).toBe(`/p/${projectId}/`);

    // Events recorded (tool calls + done)
    const kinds = (db.prepare('SELECT kind, COUNT(*) AS c FROM run_events WHERE run_id=? GROUP BY kind').all(runId) as Array<{ kind: string; c: number }>);
    const byKind = Object.fromEntries(kinds.map((k) => [k.kind, k.c]));
    expect(byKind.tool_call ?? 0).toBeGreaterThanOrEqual(5);
    expect(byKind.done).toBe(1);

    // Assistant summary message persisted to the chat
    const msg = db.prepare("SELECT role, content FROM messages WHERE project_id=? AND role='assistant' ORDER BY created_at DESC LIMIT 1").get(projectId) as { content: string } | undefined;
    expect(msg?.content).toContain('Stub run complete');

    // Stats
    const stats = JSON.parse(run.stats_json!) as { toolCalls: number; llmCalls: number };
    expect(stats.toolCalls).toBeGreaterThanOrEqual(5);
    expect(stats.llmCalls).toBeGreaterThanOrEqual(6);
  });
});
