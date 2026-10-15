/** Regression for the production failure: last-turn compiler errors must be repaired. */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import type { LlmMessage, LlmResponse } from 'appforge-shared';
import { openDb } from './db.js';
import { createProject } from './projects.js';
import { createTools, LlmError, runAgentOnce, type AgentSettings, type ToolContext } from 'appforge-worker';

const { model } = vi.hoisted(() => ({ model: vi.fn() }));
vi.mock('../../worker/src/llm.js', async (original) => ({ ...await original<typeof import('../../worker/src/llm.js')>(), isStubMode: () => false, chatLlm: model }));

let db: Database.Database;
let dataDir: string;
let projectId: string;
let ctx: ToolContext;
const settings: AgentSettings = { provider: 'groq', model: 'test', temperature: 0, maxTokens: 8000, maxIterations: 1, llmTimeoutMs: 30000, cmdTimeoutMs: 60000, runTimeoutMs: 180000, language: 'es', autoRevision: false };
const goodApp = `import { useState } from 'react';
export default function App() { const [likes, setLikes] = useState(0); return <main><h1>Catálogo de coches</h1><button onClick={() => setLikes(likes + 1)}>Me gusta</button><p>Favoritos: {likes}</p></main>; }`;
const response = (name: string, args: Record<string, unknown>): LlmResponse => ({ content: null, toolCalls: [{ id: `tool-${Math.random()}`, name, arguments: args }], usage: { promptTokens: 1, completionTokens: 1 } });

beforeAll(() => {
  vi.stubEnv('GROQ_API_KEY', 'test-key');
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-generation-'));
  db = openDb(dataDir);
  const templates = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../templates');
  projectId = createProject(db, dataDir, templates, { name: 'Repair regression' }).id;
  const projectDir = path.join(dataDir, 'projects', projectId);
  ctx = { db, projectId, projectDir, frontendDir: path.join(projectDir, 'frontend'), cmdTimeoutMs: 60000, buildTimeoutMs: 60000 };
});
afterAll(() => { db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); vi.unstubAllEnvs(); });

it('automatically installs, repairs a final-turn TypeScript failure and tests the real app in Chromium', { timeout: 180000 }, async () => {
  model.mockImplementationOnce(async () => response('write_files', { files: [{ path: 'src/App.tsx', content: `const unused = 1;\n${goodApp}` }] }));
  model.mockImplementationOnce(async (_cfg, history: LlmMessage[]) => {
    expect(history.at(-1)?.content).toContain('TS6133');
    expect(history.at(-1)?.content).toContain('repair turns');
    return response('write_files', { files: [{ path: 'src/App.tsx', content: goodApp }] });
  });
  model.mockImplementationOnce(async (_cfg, history: LlmMessage[]) => {
    expect(history.at(-1)?.content).toContain('Interaction verification missing');
    return response('test_preview', { steps: [
    { action: 'click', selector: 'button' }, { action: 'expect_text', value: 'Favoritos: 1' },
  ] }); });
  db.prepare('INSERT INTO runs(id,project_id,prompt,status,created_at) VALUES (?,?,?,?,?)').run('repair-run', projectId, 'Catálogo con me gusta', 'queued', new Date().toISOString());
  await runAgentOnce(db, 'repair-run', { dataDir, settings });
  const run = db.prepare('SELECT status,error,stats_json FROM runs WHERE id=?').get('repair-run') as { status: string; error: string; stats_json: string };
  expect(run.error).toBeNull();
  expect(run.status).toBe('done');
  expect(JSON.parse(run.stats_json).iterations).toBeGreaterThan(settings.maxIterations);
  expect(model).toHaveBeenCalledTimes(3);
  const builds = db.prepare('SELECT status, logs FROM builds WHERE project_id=? ORDER BY started_at').all(projectId) as Array<{ status: string; logs: string }>;
  expect(builds.map((b) => b.status)).toEqual(['failed', 'success']);
  expect(builds[0].logs).toContain('TS6133');
  expect(builds[0].logs).not.toContain("Cannot find module 'react'");
  const result = db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND kind='tool_result' AND payload_json LIKE '%test_preview%' AND payload_json LIKE '%steps passed%'").get('repair-run');
  expect(result).toBeTruthy();
});

it('replays successful interactions against changed source, starting from the original test state', { timeout: 90000 }, async () => {
  const tools = createTools();
  const persistentApp = goodApp.replace('useState(0)', 'useState(Number(localStorage.getItem("likes") || 0))').replace('setLikes(likes + 1)', '(localStorage.setItem("likes", String(likes + 1)), setLikes(likes + 1))');
  await tools.write_file(ctx, { path: 'src/App.tsx', content: persistentApp });
  expect((await tools.test_preview(ctx, { steps: [{ action: 'click', selector: 'button' }, { action: 'expect_text', value: 'Favoritos: 1' }] })).ok).toBe(true);
  await tools.write_file(ctx, { path: 'src/App.tsx', content: `${persistentApp}\n// harmless edit` });
  expect((await tools.start_preview(ctx, {})).ok).toBe(true);
  await tools.write_file(ctx, { path: 'src/App.tsx', content: persistentApp.replaceAll('likes + 1', 'likes + 2') });
  expect((await tools.start_preview(ctx, {})).ok).toBe(false);
  ctx.lastBrowserSteps = undefined;
  ctx.lastBrowserStart = undefined;
  ctx.browserSession = undefined;
  await tools.write_file(ctx, { path: 'src/App.tsx', content: goodApp });
});

it('never publishes a stale successful bundle after source edits fail to compile', { timeout: 90000 }, async () => {
  const tools = createTools();
  expect((await tools.start_preview(ctx, {})).ok).toBe(true);
  await tools.write_file(ctx, { path: 'src/App.tsx', content: 'export default function App() { return DOES_NOT_EXIST; }' });
  const result = await tools.start_preview(ctx, {});
  expect(result.ok).toBe(false);
  expect(result.output).toContain('DOES_NOT_EXIST');
});

it('rejects a build that compiles but throws in the browser', { timeout: 90000 }, async () => {
  const tools = createTools();
  await tools.write_file(ctx, { path: 'src/App.tsx', content: 'export default function App(): never { throw new Error("runtime regression"); }' });
  const result = await tools.start_preview(ctx, {});
  expect(result.ok).toBe(false);
  expect(result.code).toBe('BROWSER_FAILED');
  expect(result.error).toContain('runtime regression');
  expect(ctx.browserFingerprint).toBeUndefined();
});

it('recovers from a provider timeout with compact current-state context', { timeout: 90000 }, async () => {
  model.mockReset().mockRejectedValueOnce(new LlmError('LLM_TIMEOUT', 'provider stalled'));
  model.mockImplementationOnce(async (_cfg, history: LlmMessage[]) => {
    expect(history.at(-1)?.content).toContain('RECOVERY MODE');
    return response('write_files', { files: [{ path: 'src/App.tsx', content: `${goodApp}\n// timeout recovery` }] });
  });
  model.mockImplementationOnce(async () => response('test_preview', { steps: [
    { action: 'click', selector: 'button' }, { action: 'expect_text', value: 'Favoritos: 1' },
  ] }));
  db.prepare('INSERT INTO runs(id,project_id,prompt,status,created_at) VALUES (?,?,?,?,?)').run('timeout-recovery-run', projectId, 'Recover after timeout', 'queued', new Date().toISOString());
  await runAgentOnce(db, 'timeout-recovery-run', { dataDir, settings });
  const run = db.prepare('SELECT status,error FROM runs WHERE id=?').get('timeout-recovery-run') as { status: string; error: string | null };
  expect(run.status).toBe('done');
  expect(run.error).toBeNull();
});

it('does not accept unchanged template output as completed work', { timeout: 30000 }, async () => {
  model.mockReset().mockResolvedValue({ content: 'Todo listo', toolCalls: [], usage: { promptTokens: 0, completionTokens: 0 } });
  db.prepare('INSERT INTO runs(id,project_id,prompt,status,created_at) VALUES (?,?,?,?,?)').run('no-code-run', projectId, 'Make an app', 'queued', new Date().toISOString());
  await runAgentOnce(db, 'no-code-run', { dataDir, settings });
  const run = db.prepare('SELECT status,error FROM runs WHERE id=?').get('no-code-run') as { status: string; error: string };
  expect(run.status).toBe('error');
  expect(run.error).toContain('No implementation');
  expect(model.mock.calls.length).toBeLessThanOrEqual(settings.maxIterations + 6);
});

it('rejects completion of an interactive app without an interaction assertion', { timeout: 90000 }, async () => {
  model.mockReset().mockImplementationOnce(async () => response('write_files', { files: [{ path: 'src/App.tsx', content: `${goodApp}\n// new implementation` }] }));
  model.mockResolvedValue({ content: 'Todo listo', toolCalls: [], usage: { promptTokens: 0, completionTokens: 0 } });
  db.prepare('INSERT INTO runs(id,project_id,prompt,status,created_at) VALUES (?,?,?,?,?)').run('untested-run', projectId, 'Make likes work', 'queued', new Date().toISOString());
  await runAgentOnce(db, 'untested-run', { dataDir, settings });
  const run = db.prepare('SELECT status,error FROM runs WHERE id=?').get('untested-run') as { status: string; error: string };
  expect(run.status).toBe('error');
  expect(run.error).toContain('Interaction verification missing');
});
