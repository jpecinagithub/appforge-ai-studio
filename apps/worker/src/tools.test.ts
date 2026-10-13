import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTools, resolveIn, runCmd, type ToolContext } from './tools.js';

let projectDir: string;
let frontendDir: string;
let db: Database.Database;
let ctx: ToolContext;

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-tools-'));
  frontendDir = path.join(projectDir, 'frontend');
  fs.mkdirSync(path.join(frontendDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(frontendDir, 'src', 'App.tsx'), 'export default function App(){return 1;}');
  fs.writeFileSync(path.join(projectDir, 'outside.txt'), 'secret');
  db = new Database(':memory:');
  ctx = { db, projectId: 'p1', projectDir, frontendDir, cmdTimeoutMs: 10_000, buildTimeoutMs: 60_000 };
});

afterEach(() => {
  db.close();
  fs.rmSync(projectDir, { recursive: true, force: true });
});

describe('path confinement', () => {
  it('rejects .. traversal on read', async () => {
    const tools = createTools();
    const r = await tools.read_file(ctx, { path: '../outside.txt' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('INVALID_PATH');
  });

  it('rejects absolute paths on read', async () => {
    const tools = createTools();
    const r = await tools.read_file(ctx, { path: '/etc/passwd' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('INVALID_PATH');
  });

  it('rejects traversal on write', async () => {
    const tools = createTools();
    const r = await tools.write_file(ctx, { path: '../../evil.txt', content: 'x' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('INVALID_PATH');
    expect(fs.existsSync(path.join(os.tmpdir(), 'evil.txt'))).toBe(false);
  });

  it('rejects sneaky a/../../b paths via resolveIn', () => {
    expect(() => resolveIn(frontendDir, 'a/../../outside.txt')).toThrowError();
    try {
      resolveIn(frontendDir, 'a/../../outside.txt');
      expect.unreachable();
    } catch (e) {
      expect((e as { code?: string }).code).toBe('INVALID_PATH');
    }
  });

  it('allows normal nested paths', async () => {
    const tools = createTools();
    const w = await tools.write_file(ctx, { path: 'src/nested/ok.txt', content: 'hello' });
    expect(w.ok).toBe(true);
    const r = await tools.read_file(ctx, { path: 'src/nested/ok.txt' });
    expect(r.ok).toBe(true);
    expect((r.data as { content: string }).content).toBe('hello');
  });
});

describe('patch_file', () => {
  it('reports PATCH_NOT_FOUND when search string is absent', async () => {
    const tools = createTools();
    const r = await tools.patch_file(ctx, { path: 'src/App.tsx', search: 'does-not-exist', replace: 'x' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('PATCH_NOT_FOUND');
  });
});

describe('run_command allowlist', () => {
  it('rejects non-allowlisted binaries', async () => {
    const tools = createTools();
    const r = await tools.run_command(ctx, { cmd: 'rm', args: ['-rf', '/'] });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('COMMAND_NOT_ALLOWED');
  });

  it('rejects shell metacharacters smuggled as the command', async () => {
    const tools = createTools();
    const r = await tools.run_command(ctx, { cmd: 'node; rm -rf /' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('COMMAND_NOT_ALLOWED');
  });

  it('runs node without a shell', async () => {
    const tools = createTools();
    const r = await tools.run_command(ctx, { cmd: 'node', args: ['--version'] });
    expect(r.ok).toBe(true);
    expect(r.output ?? '').toContain('v');
  });

  it('resolves the npm launcher without a shell on every platform', async () => {
    const r = await runCmd('npm', ['--version'], { cwd: frontendDir, timeoutMs: 10_000 });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+/);
  });
});
