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

  it('creates the destination directory up front instead of failing on it', async () => {
    // Even when nothing is found, the destination folder the agent named
    // must exist afterwards: a missing directory is created, never an
    // INVALID_PATH detour through create_directory (T-shirts run).
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    const result = await createTools().acquire_image(ctx, { query: 'nothing found', path: 'public/brand/new/dir/hero' });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('IMAGE_NOT_FOUND');
    expect(fs.existsSync(path.join(frontendDir, 'public', 'brand', 'new', 'dir'))).toBe(true);
  });

  it('rejects unsupported destination extensions with INVALID_PATH before searching', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const result = await createTools().acquire_image(ctx, { query: 'a photo', path: 'public/assets/anim.gif' });
    expect(result).toMatchObject({ ok: false, code: 'INVALID_PATH' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects destinations that escape public/ through .. segments', async () => {
    const result = await createTools().acquire_image(ctx, { query: 'a photo', path: 'public/../src/evil.jpg' });
    expect(result).toMatchObject({ ok: false, code: 'INVALID_PATH' });
    expect(fs.existsSync(path.join(frontendDir, 'src', 'evil.jpg'))).toBe(false);
  });

  it('stops at the per-call budget and returns IMAGE_TIMEOUT with retryable + alternatives', async () => {
    process.env.APPFORGE_IMAGE_CALL_BUDGET_MS = '300';
    try {
      const fetchMock = vi.spyOn(globalThis, 'fetch');
      fetchMock.mockImplementation((async (input: unknown, init?: { signal?: AbortSignal }) => {
        const url = String(input);
        if (url.startsWith('https://api.openverse.org/v1/images/?')) {
          return new Response(JSON.stringify({
            results: [{
              title: 'Slow photo', creator: 'Example photographer', license: 'by',
              url: 'https://images.example.test/slow.jpg',
              thumbnail: 'https://api.openverse.org/v1/images/example/thumb/',
              foreign_landing_url: 'https://example.test/photo/slow',
              width: 1600, height: 900, mature: false,
            }],
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        // The thumbnail download hangs until the caller's signal aborts it.
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')));
        });
      }) as typeof fetch);

      const t0 = Date.now();
      const result = await createTools().acquire_image(ctx, { query: 'slow photo', path: 'public/assets/slow' });
      const elapsed = Date.now() - t0;
      expect(result.ok).toBe(false);
      expect(result.code).toBe('IMAGE_TIMEOUT');
      expect(result.retryable).toBe(true);
      expect(result.alternatives).toHaveLength(3);
      expect(result.alternatives!.some((a) => a.includes('fallback: "placeholder"'))).toBe(true);
      // The 90 s default chain must NOT have run: the 300 ms budget stopped it.
      expect(elapsed).toBeLessThan(10_000);
    } finally {
      delete process.env.APPFORGE_IMAGE_CALL_BUDGET_MS;
    }
  });

  it('without fallback, an empty search stays IMAGE_NOT_FOUND (now with alternatives)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    const result = await createTools().acquire_image(ctx, { query: 'nonexistent subject', path: 'public/assets/none' });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('IMAGE_NOT_FOUND');
    expect(result.retryable).toBe(true);
    expect(result.alternatives).toHaveLength(3);
    expect(fs.existsSync(path.join(frontendDir, 'public', 'placeholder-illustrative.svg'))).toBe(false);
  });

  it('fallback "placeholder" writes the platform asset once and reports the degradation', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ results: [] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    const first = await createTools().acquire_image(ctx, {
      query: 'unobtainable photo', path: 'public/assets/hero', fallback: 'placeholder',
    });
    expect(first.ok).toBe(true);
    const data = first.data as { path: string; publicUrl: string; degraded: string; requestedPath: string; reason: string };
    expect(data.degraded).toBe('illustrative-placeholder');
    expect(data.path).toBe('public/placeholder-illustrative.svg');
    expect(data.publicUrl).toBe('./placeholder-illustrative.svg');
    expect(data.requestedPath).toBe('public/assets/hero');
    expect(data.reason).toBe('IMAGE_NOT_FOUND');
    const svgPath = path.join(frontendDir, 'public', 'placeholder-illustrative.svg');
    expect(fs.readFileSync(svgPath, 'utf8')).toContain('Imagen ilustrativa');
    // A second degraded acquisition reuses the same asset — no ASSET_EXISTS.
    const second = await createTools().acquire_image(ctx, {
      query: 'another unobtainable photo', path: 'public/assets/other', fallback: 'placeholder',
    });
    expect(second.ok).toBe(true);
    expect((second.data as { degraded: string }).degraded).toBe('illustrative-placeholder');
  });

  it('fallback "placeholder" also covers a failed search (HTTP error)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValue(new Response('upstream down', { status: 503 }));
    const result = await createTools().acquire_image(ctx, {
      query: 'anything', path: 'public/assets/x', fallback: 'placeholder',
    });
    expect(result.ok).toBe(true);
    expect((result.data as { degraded: string; reason: string }).degraded).toBe('illustrative-placeholder');
    expect((result.data as { reason: string }).reason).toBe('IMAGE_SEARCH_FAILED');
  });
});

describe('path confinement', () => {
  it('rejects text disguised as a raster image', async () => {
    const result = await createTools().write_file(ctx, { path: 'public/images/fake.jpg', content: '<svg></svg>' });
    expect(result).toMatchObject({ ok: false, code: 'BINARY_FILE_REQUIRED' });
    expect(fs.existsSync(path.join(frontendDir, 'public/images/fake.jpg'))).toBe(false);
  });

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

describe('frontend contract lint (write-time note)', () => {
  it('annotates a write_file that hand-writes an absolute /api fetch', async () => {
    const tools = createTools();
    const r = await tools.write_file(ctx, {
      path: 'src/App.tsx',
      content: "export default function App() { return fetch('/api/shirts'); }",
    });
    expect(r.ok).toBe(true);
    expect(r.output ?? '').toContain('Frontend contract check');
    expect(r.output ?? '').toContain('src/App.tsx');
  });

  it('does not annotate the API client file itself', async () => {
    const tools = createTools();
    const r = await tools.write_file(ctx, {
      path: 'src/api.ts',
      content: "export const login = () => fetch('/api/auth/login');",
    });
    expect(r.ok).toBe(true);
    expect(r.output ?? '').not.toContain('Frontend contract check');
  });

  it('annotates a patch_file whose replacement introduces the pattern', async () => {
    const tools = createTools();
    const w = await tools.write_file(ctx, { path: 'src/Cart.tsx', content: 'export function load() { return 1; }' });
    expect(w.ok).toBe(true);
    const r = await tools.patch_file(ctx, {
      path: 'src/Cart.tsx',
      search: 'return 1;',
      replace: 'return fetch("/api/cart");',
    });
    expect(r.ok).toBe(true);
    expect(r.output ?? '').toContain('Frontend contract check');
  });

  it('annotates write_files batches and stays silent on relative URLs', async () => {
    const tools = createTools();
    const bad = await tools.write_files(ctx, {
      files: [
        { path: 'src/Ok.tsx', content: "export const a = () => fetch('./api/shirts');" },
        { path: 'src/Bad.tsx', content: "export const b = () => axios.get('/api/shirts');" },
      ],
    });
    expect(bad.ok).toBe(true);
    expect(bad.output ?? '').toContain('Frontend contract check');
    expect(bad.output ?? '').toContain('src/Bad.tsx');
    expect(bad.output ?? '').not.toContain('src/Ok.tsx');
    const clean = await tools.write_files(ctx, {
      files: [{ path: 'src/Ok2.tsx', content: "export const c = () => fetch('./api/shirts');" }],
    });
    expect(clean.ok).toBe(true);
    expect(clean.output ?? '').not.toContain('Frontend contract check');
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
