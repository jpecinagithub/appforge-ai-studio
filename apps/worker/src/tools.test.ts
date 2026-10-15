import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  vi.restoreAllMocks();
  db.close();
  fs.rmSync(projectDir, { recursive: true, force: true });
});

describe('acquire_image', () => {
  it('downloads a licensed image and records its attribution', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      results: [{
        title: '2014 Tesla Model S',
        creator: 'Example photographer',
        license: 'by-sa',
        license_version: '4.0',
        license_url: 'https://creativecommons.org/licenses/by-sa/4.0/',
        source: 'flickr',
        url: 'https://images.example.test/tesla.jpg',
        thumbnail: 'https://api.openverse.org/v1/images/example/thumb/',
        foreign_landing_url: 'https://example.test/photo/tesla',
        width: 1600,
        height: 900,
        mature: false,
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    }));

    const result = await createTools().acquire_image(ctx, {
      query: 'Tesla Model S side view',
      path: 'public/assets/cars/tesla-model-s',
    });

    expect(result.ok).toBe(true);
    expect((result.data as { publicUrl: string }).publicUrl).toBe('./assets/cars/tesla-model-s.jpg');
    expect(fs.readFileSync(path.join(frontendDir, 'public/assets/cars/tesla-model-s.jpg'))).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const receipt = JSON.parse(fs.readFileSync(path.join(frontendDir, 'public/assets/cars/tesla-model-s.jpg.license.json'), 'utf8')) as { creator: string; license: string };
    expect(receipt).toMatchObject({ creator: 'Example photographer', license: 'BY-SA 4.0' });
  });

  it('retries a temporarily unavailable Openverse thumbnail', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.spyOn(globalThis, 'fetch');
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
        results: [{
          title: 'Yamaha MT-09', creator: 'Example photographer', license: 'by',
          url: 'https://images.example.test/yamaha.jpg',
          thumbnail: 'https://api.openverse.org/v1/images/example/thumb/',
          foreign_landing_url: 'https://example.test/photo/yamaha',
          width: 1600, height: 900, mature: false,
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
      fetchMock.mockResolvedValueOnce(new Response('{}', { status: 406, headers: { 'content-type': 'application/json' } }));
      fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      }));

      const pending = createTools().acquire_image(ctx, {
        query: 'Yamaha MT-09 motorcycle',
        path: 'public/assets/yamaha-mt09',
      });
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(result.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to an allowlisted original CDN when the thumbnail proxy stays unavailable', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.spyOn(globalThis, 'fetch');
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
        results: [{
          title: 'Honda Africa Twin', creator: 'Example photographer', license: 'by-sa',
          url: 'https://live.staticflickr.com/1234/honda.jpg',
          thumbnail: 'https://api.openverse.org/v1/images/example/thumb/',
          foreign_landing_url: 'https://www.flickr.com/photos/example/honda',
          width: 1600, height: 900, mature: false,
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
      for (let attempt = 0; attempt < 3; attempt++) {
        fetchMock.mockResolvedValueOnce(new Response('{}', { status: 406, headers: { 'content-type': 'application/json' } }));
      }
      fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      }));

      const pending = createTools().acquire_image(ctx, {
        query: 'Honda Africa Twin motorcycle',
        path: 'public/assets/honda-africa-twin',
      });
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(result.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(5);
      expect((result.data as { publicUrl: string }).publicUrl).toBe('./assets/honda-africa-twin.jpg');
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses destinations outside public', async () => {
    const result = await createTools().acquire_image(ctx, { query: 'car', path: 'src/car' });
    expect(result).toMatchObject({ ok: false, code: 'INVALID_PATH' });
  });
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
